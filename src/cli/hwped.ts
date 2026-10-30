#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { openDocument } from '../core/index.js';
import { summarizeModel } from '../server/summary.js';
import type { DocModel } from '../core/types.js';
import type { Op, OpResult } from '../core/types.js';
import { convertHwpToHwpx } from '../convert/index.js';

const usage = `Usage:
  hwped outline <file> [--from <id>] [--limit <number>]
  hwped find <file> <query> [--regex] [--match-case] [--live]
  hwped replace <file> <find> <replacement> [--regex] [--match-case] [-o <output.hwpx> | --live]
  hwped apply <file> <ops-json|json-file|-> [-o <output.hwpx> | --live]
  hwped text <file>
  hwped convert <file.hwp> [output.hwpx]
  hwped open <file> [--json]`;

type Options = { live: boolean; regex: boolean; matchCase: boolean; json: boolean; from?: string; limit?: number; output?: string };

function parse(args: string[]): { command: string; positional: string[]; options: Options } {
  const command = args.shift();
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage);
    process.exit(0);
  }
  const options: Options = { live: false, regex: false, matchCase: false, json: false };
  const positional: string[] = [];
  let flags = true;
  while (args.length) {
    const arg = args.shift()!;
    if (flags && arg === '--') { flags = false; continue; }
    if (flags && arg === '--live') options.live = true;
    else if (flags && arg === '--json') options.json = true;
    else if (flags && arg === '--regex') options.regex = true;
    else if (flags && (arg === '--match-case' || arg === '--matchCase')) options.matchCase = true;
    else if (flags && (arg === '--from' || arg === '--limit' || arg === '-o' || arg === '--output')) {
      const value = args.shift();
      if (value === undefined || !value) throw new Error(`${arg} requires a value`);
      if (arg === '-o' || arg === '--output') options.output = value;
      else if (arg === '--from') options.from = value;
      else {
        options.limit = Number(value);
        if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('--limit must be a non-negative integer');
      }
    } else if (flags && arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { command, positional, options };
}

interface ServerInfo { port: number; token: string }
async function serverInfo(): Promise<ServerInfo> {
  const info = JSON.parse(await readFile(join(homedir(), '.hwp-editor', 'server.json'), 'utf8')) as ServerInfo;
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string' || !info.token) {
    throw new Error('Invalid server connection information');
  }
  return info;
}

async function request<T>(server: ServerInfo, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);
  return data;
}

async function liveDocument(server: ServerInfo, path: string): Promise<string> {
  const { docs } = await request<{ docs: { docId: string; path: string | null; sourcePath: string | null }[] }>(server, '/api/docs');
  const target = resolve(path);
  const doc = docs.find(item => [item.path, item.sourcePath].some(p => p !== null && resolve(p) === target));
  if (!doc) throw new Error(`Document is not open in the running server: ${path}`);
  return encodeURIComponent(doc.docId);
}

async function readOps(input: string): Promise<Op[]> {
  let json: string;
  if (input === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    json = Buffer.concat(chunks).toString('utf8');
  } else if (input.trimStart().startsWith('[')) json = input;
  else json = await readFile(input, 'utf8');
  const ops: unknown = JSON.parse(json);
  if (!Array.isArray(ops)) throw new Error('Operations must be a JSON array');
  return ops as Op[];
}

function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

async function main(): Promise<void> {
  const { command, positional, options } = parse(process.argv.slice(2));
  const count: Record<string, [number, number]> = {
    outline: [1, 1], find: [2, 2], replace: [3, 3], apply: [2, 2], text: [1, 1], convert: [1, 2], open: [1, 1],
  };
  const range = count[command];
  if (!range || positional.length < range[0] || positional.length > range[1]) throw new Error(usage);
  if (options.live && !['find', 'replace', 'apply'].includes(command)) throw new Error('--live is only supported by find, replace and apply');
  if ((options.regex || options.matchCase) && !['find', 'replace'].includes(command)) throw new Error('--regex and --match-case are only supported by find and replace');
  if ((options.from !== undefined || options.limit !== undefined) && command !== 'outline') throw new Error('--from and --limit are only supported by outline');
  if (options.output !== undefined && (!['replace', 'apply'].includes(command) || options.live)) throw new Error('-o is only supported for disk replace and apply, not --live');
  if (options.json && command !== 'open') throw new Error('--json is only supported by open');
  const [path, first, second] = positional;

  if (command === 'convert') {
    if (extname(path).toLowerCase() !== '.hwp') throw new Error('convert requires an .hwp file');
    const output = first ?? path.slice(0, -extname(path).length) + '.hwpx';
    if (extname(output).toLowerCase() !== '.hwpx') throw new Error('Output must have a .hwpx extension');
    await writeFile(output, await convertHwpToHwpx(path));
    console.log(output);
    return;
  }
  if (command === 'open') {
    const server = await serverInfo();
    const model = await request<DocModel>(server, '/api/open', { path: resolve(path) });
    printJson(options.json ? model : summarizeModel(model));
    return;
  }

  if (options.live) {
    const server = await serverInfo();
    const id = await liveDocument(server, path);
    if (command === 'find') {
      const query = new URLSearchParams({ q: first, regex: String(options.regex), matchCase: String(options.matchCase) });
      const result = await request<{ hits: unknown[] }>(server, `/api/docs/${id}/find?${query}`);
      printJson(result.hits);
    } else {
      const ops: Op[] = command === 'replace'
        ? [{ op: 'replaceText', find: first, replace: second, regex: options.regex, matchCase: options.matchCase }]
        : await readOps(first);
      const result = await request<OpResult>(server, `/api/docs/${id}/ops`, { ops, source: 'cli' });
      printJson({ revision: result.revision, created: result.created, replaced: result.replaced });
    }
    return;
  }

  const session = await openDocument(path);
  if (command === 'outline') console.log(session.outline({ from: options.from, limit: options.limit }));
  else if (command === 'text') console.log(session.plainText());
  else if (command === 'find') printJson(session.find(first, { regex: options.regex, matchCase: options.matchCase }));
  else {
    const ops: Op[] = command === 'replace'
      ? [{ op: 'replaceText', find: first, replace: second, regex: options.regex, matchCase: options.matchCase }]
      : await readOps(first);
    const result = session.apply(ops);
    await session.save(options.output);
    printJson(result);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
