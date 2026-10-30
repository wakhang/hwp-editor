import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SessionManager } from '../server/session-manager.js';
import { serverInfoPath } from '../server/index.js';
import { summarizeModel } from '../server/summary.js';
import type { DocModel } from '../core/types.js';
import type { Op } from '../core/types.js';

const opDescription = `Apply an atomic array of operations. IDs are session-scoped and come from hwp_outline: paragraphs p…, tables t…, sections s…, objects o…. Text offsets are zero-based UTF-16 code-unit offsets in concatenated paragraph runs, with start inclusive and end exclusive. Rows and columns are zero-based. Operations (JSON objects):
{"op":"setParagraph","id":paragraphId,"runs":[RunInput,...]} replaces runs while retaining anchors;
{"op":"insertParagraph","after":paragraphId,"runs"?:RunInput[],"align"?:Align,"styleFrom"?:paragraphId} or use before instead of after (exactly one); inherits paragraph formatting from styleFrom or neighbor;
{"op":"deleteParagraph","id":paragraphId} deletes anchors too; last paragraph in section/cell is cleared;
{"op":"setAlign","id":paragraphId,"align":Align};
{"op":"styleRange","id":paragraphId,"start":number,"end":number,"style":StylePatch};
{"op":"replaceText","find":string,"replace":string,"regex"?:boolean,"matchCase"?:boolean,"scope"?:paragraphOrTableOrSectionId}; omitted scope means whole document;
{"op":"setCellText","tableId":tableId,"row":number,"col":number,"text":string} (newlines split paragraphs);
{"op":"insertTable","after":paragraphId,"rows":number,"cols":number,"data"?:string[][]};
{"op":"insertRow","tableId":tableId,"at":number}; {"op":"deleteRow","tableId":tableId,"row":number}; {"op":"deleteObject","id":tableOrObjectId}. Rows crossing merges cannot be inserted/deleted.
{"op":"insertPicture","paragraph":paragraphId,"path"?:string,"data"?:base64String,"widthMm"?:number,"heightMm"?:number}; supply exactly one of path or data. PNG, JPEG, GIF and BMP are supported; images are fitted to the available width. A paragraph containing text gets a new picture-only paragraph immediately after it; an empty paragraph holds the picture itself.
RunInput = {"text":string,"base"?:number,"style"?:StylePatch,"compose"?:{"composeText":string,"circleType":string}}; base is a charPrId, defaulting to first run's character style. Compose text must be the displayed text; checked boxes appear as ☑, and writing ☑ as plain text is also fine. StylePatch = {"bold"?:boolean,"italic"?:boolean,"underline"?:boolean,"strike"?:boolean,"sizePt"?:number,"color"?:"#rrggbb","highlight"?:string|null,"font"?:string}; Align = "left"|"right"|"center"|"justify"|"distribute".`;
const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const number = { type: 'integer' } as const;
function tool(name: string, description: string, properties: Record<string, object>, required: string[] = []) {
  return { name, description, inputSchema: { type: 'object' as const, properties, required } };
}
const tools = [
  tool('hwp_list', 'List open documents.', {}),
  tool('hwp_open', 'Open an HWPX or HWP document. HWP is converted; saving writes HWPX, never HWP.', { path: string }, ['path']),
  tool('hwp_new', 'Create a blank document.', {}),
  tool('hwp_outline', 'Get document text with session-scoped paragraph and table IDs for subsequent operations.', { docId: string, from: string, limit: number }, ['docId']),
  tool('hwp_find', 'Find text and return paragraph IDs and UTF-16 offsets.', { docId: string, query: string, regex: boolean }, ['docId', 'query']),
  tool('hwp_apply', opDescription, { docId: string, ops: { type: 'array', items: { type: 'object' }, description: opDescription } }, ['docId', 'ops']),
  tool('hwp_undo', 'Undo the last edit.', { docId: string }, ['docId']),
  tool('hwp_save', 'Save as HWPX, optionally to a new path.', { docId: string, path: string }, ['docId']),
  tool('hwp_close', 'Close a document.', { docId: string }, ['docId']),
];

type Remote = { port: number; token: string };
async function discover(): Promise<Remote | null> {
  try {
    const info = z.object({ port: z.number().int().min(1).max(65535), token: z.string() }).parse(JSON.parse(await readFile(serverInfoPath(), 'utf8')));
    const response = await fetch(`http://127.0.0.1:${info.port}/api/docs`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1500) });
    return response.ok ? info : null;
  } catch { return null; }
}
async function main() {
  let manager: SessionManager | undefined;
  const server = new Server({ name: 'hwp-editor', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const remote = await discover();
      if (!remote) manager ??= new SessionManager();
      async function request(path: string, payload?: object): Promise<Record<string, unknown>> {
        if (!remote) throw new Error('No running server');
        const response = await fetch(`http://127.0.0.1:${remote.port}${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
        const value = z.record(z.string(), z.unknown()).parse(await response.json());
        if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`);
        return value;
      }
      const args = params.arguments ?? {};
      const id = String(args.docId ?? '');
      const base = `/api/docs/${encodeURIComponent(id)}`;
      let result: unknown;
      if (params.name === 'hwp_list') result = remote ? await request('/api/docs') : { docs: manager!.list() };
      else if (params.name === 'hwp_open' || params.name === 'hwp_new') {
        const session = remote ? null : params.name === 'hwp_open' ? await manager!.open(String(args.path)) : manager!.new();
        // The authenticated local server returns the same DocModel contract as the in-process session.
        const model = session ? session.model() : await request(params.name === 'hwp_open' ? '/api/open' : '/api/new', params.name === 'hwp_open' ? { path: args.path } : {}) as unknown as DocModel;
        const outline = session ? session.outline({ limit: 40 }) : (await request(`/api/docs/${encodeURIComponent(model.docId)}/outline?limit=40`)).text;
        result = { ...summarizeModel(model), text: outline, ...(model.sourceFormat === 'hwp' ? { note: 'HWP 파일은 HWPX로 변환되며 저장 시 .hwpx 파일에 기록됩니다.' } : {}) };
      }
      else if (remote) {
        if (params.name === 'hwp_outline') {
          const query = new URLSearchParams();
          if (args.from !== undefined) query.set('from', String(args.from));
          if (args.limit !== undefined) query.set('limit', String(args.limit));
          result = await request(`${base}/outline?${query}`);
        } else if (params.name === 'hwp_find') {
          const query = new URLSearchParams({ q: String(args.query ?? '') });
          if (args.regex !== undefined) query.set('regex', String(args.regex));
          result = await request(`${base}/find?${query}`);
        } else if (params.name === 'hwp_apply') {
          const applied = await request(`${base}/ops`, { ops: args.ops, source: 'ai' });
          const { revision, created, replaced } = applied;
          result = { revision, created, replaced, ...(await request(`${base}/outline`)) };
        } else if (params.name === 'hwp_undo') {
          const { ok, model } = await request(`${base}/undo`, { source: 'ai' });
          const parsed = z.object({ revision: z.number() }).parse(model);
          result = { ok, revision: parsed.revision };
        } else if (params.name === 'hwp_save') result = await request(`${base}/save`, { path: args.path });
        else if (params.name === 'hwp_close') result = await request(`${base}/close`, {});
        else throw new Error(`Unknown tool: ${params.name}`);
      } else {
        const session = manager!.get(id);
        if (!session) throw new Error('Document not found');
        if (params.name === 'hwp_outline') result = { text: session.outline({ from: args.from as string | undefined, limit: args.limit as number | undefined }) };
        else if (params.name === 'hwp_find') result = { hits: session.find(String(args.query ?? ''), { regex: args.regex === true }) };
        else if (params.name === 'hwp_apply') result = { ...session.apply(args.ops as Op[]), text: session.outline() };
        else if (params.name === 'hwp_undo') { const ok = session.undo(); result = { ok, revision: session.model().revision }; }
        else if (params.name === 'hwp_save') result = { path: await session.save(args.path as string | undefined) };
        else if (params.name === 'hwp_close') result = { ok: manager!.close(id) };
        else throw new Error(`Unknown tool: ${params.name}`);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
