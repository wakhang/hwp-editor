import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { openDocument } from '../../src/core/index.js';
import type { DocModel } from '../../src/core/types.js';
import { startServer } from '../../src/server/index.js';

const root = process.cwd();
const source = join(root, 'fixtures/hwpx/blank.hwpx');

function serverCommand() {
  // Prefer source when tsx is installed; packaged runs can use the built entry point.
  const tsx = join(root, 'node_modules/tsx/dist/loader.mjs');
  if (existsSync(tsx)) return { command: process.execPath, args: ['--import', tsx, join(root, 'src/mcp/server.ts')] };
  const built = join(root, 'dist/mcp.mjs');
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  throw new Error('MCP integration tests require tsx or dist/mcp.mjs');
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, `${name}: ${JSON.stringify(response.content)}`).not.toBe(true);
  const content = response.content as Array<{ type: string; text?: string }>;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0].text!) as T;
}

describe('MCP stdio integration', () => {
  it.each(['local', 'remote'] as const)('lists, opens, edits and saves in %s mode', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-mcp-'));
    const previousHome = process.env.HOME;
    let server: { url: string; token: string; close(): Promise<void> } | undefined;
    let client: Client | undefined;
    try {
      const fixture = join(dir, 'input.hwpx');
      const saved = join(dir, 'saved.hwpx');
      await copyFile(source, fixture);
      // Isolate discovery from any real running app, including in local mode.
      process.env.HOME = dir;
      if (mode === 'remote') server = await startServer({ port: 0 });
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const transport = new StdioClientTransport({ ...serverCommand(), cwd: root, env: { ...env, HOME: dir }, stderr: 'pipe' });
      client = new Client({ name: 'hwp-editor-test', version: '1.0.0' });
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual([
        'hwp_apply', 'hwp_close', 'hwp_find', 'hwp_list', 'hwp_new',
        'hwp_open', 'hwp_outline', 'hwp_save', 'hwp_undo',
      ]);
      expect(tools.find(tool => tool.name === 'hwp_apply')?.description).toContain('setParagraph');
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(0);
      const created = await call<{ docId: string; paragraphs: number; tables: number; text: string; sections?: unknown }>(client, 'hwp_new');
      expect(created.paragraphs).toBeGreaterThan(0);
      expect(created.sections).toBeUndefined();
      expect(created.text).toContain('[p');
      expect(await call<{ ok: boolean }>(client, 'hwp_close', { docId: created.docId })).toEqual({ ok: true });

      const model = await call<{ docId: string; sourcePath: string; revision: number; paragraphs: number; tables: number; text: string }>(client, 'hwp_open', { path: fixture });
      expect(model.sourcePath).toBe(resolve(fixture));
      expect(model.paragraphs).toBeGreaterThan(0);
      expect(model.tables).toBe(0);
      const paragraphId = /\[(p\d+)\]/.exec(model.text)?.[1];
      expect(paragraphId).toBeTruthy();
      const listed = await call<{ docs: Array<{ docId: string }> }>(client, 'hwp_list');
      expect(listed.docs.map(doc => doc.docId)).toContain(model.docId);
      const outline = await call<{ text: string }>(client, 'hwp_outline', { docId: model.docId });
      expect(outline.text).toContain(paragraphId);

      const text = `MCP ${mode} integration edit`;
      const result = await call<{ revision: number; created: string[]; replaced: number; text: string }>(client, 'hwp_apply', {
        docId: model.docId,
        ops: [{ op: 'setParagraph', id: paragraphId, runs: [{ text }] }],
      });
      expect(result.revision).toBe(model.revision + 1);
      expect(result.created).toEqual([]);
      expect(result.replaced).toBe(0);
      expect(result.text).toContain(text);
      expect((await call<{ text: string }>(client, 'hwp_outline', { docId: model.docId })).text).toContain(text);

      // Inspect the HTTP session directly to prove the MCP process discovered and used it.
      if (server) {
        const response = await fetch(`${server.url}/api/docs/${encodeURIComponent(model.docId)}`, {
          headers: { Authorization: `Bearer ${server.token}` },
        });
        expect(response.status).toBe(200);
        const remoteModel = await response.json() as DocModel;
        expect(remoteModel.revision).toBe(result.revision);
        expect(remoteModel.sections[0].paragraphs[0].runs.map(run => run.text).join('')).toContain(text);
      }

      expect(await call<{ path: string }>(client, 'hwp_save', { docId: model.docId, path: saved })).toEqual({ path: saved });
      expect((await openDocument(saved)).plainText()).toContain(text);
      expect(await call<{ ok: boolean }>(client, 'hwp_close', { docId: model.docId })).toEqual({ ok: true });
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(0);
    } finally {
      try {
        await client?.close();
      } finally {
        try { await server?.close(); } finally {
          if (previousHome === undefined) delete process.env.HOME;
          else process.env.HOME = previousHome;
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);
  it('discovers a server started after MCP and its replacement token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwpx-mcp-discovery-'));
    const previousHome = process.env.HOME;
    let server: { url: string; token: string; close(): Promise<void> } | undefined;
    let client: Client | undefined;
    try {
      process.env.HOME = dir;
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const transport = new StdioClientTransport({ ...serverCommand(), cwd: root, env: { ...env, HOME: dir }, stderr: 'pipe' });
      client = new Client({ name: 'hwp-editor-test', version: '1.0.0' });
      await client.connect(transport);
      await call(client, 'hwp_new');

      server = await startServer({ port: 0 });
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(0);
      await call(client, 'hwp_new');
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(1);
      const oldToken = server.token;
      await server.close();
      server = undefined;
      server = await startServer({ port: 0 });
      expect(server.token).not.toBe(oldToken);
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(0);
      await call(client, 'hwp_new');
      expect((await call<{ docs: unknown[] }>(client, 'hwp_list')).docs).toHaveLength(1);
    } finally {
      try {
        await client?.close();
      } finally {
        try { await server?.close(); } finally {
          if (previousHome === undefined) delete process.env.HOME;
          else process.env.HOME = previousHome;
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);
});
