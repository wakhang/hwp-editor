import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { openDocument } from '../../src/core/index.js';
import type { DocModel } from '../../src/core/types.js';
import { startServer } from '../../src/server/index.js';

describe('HTTP server', () => {
  it('opens, edits, broadcasts and saves a document with token authentication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hwp-server-test-'));
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    let server: { port: number; token: string; url: string; close(): Promise<void> } | undefined;
    let socket: WebSocket | undefined;
    try {
      server = await startServer({ port: 0 });
      expect(server.port).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(join(dir, '.hwp-editor', 'server.json'), 'utf8'))).toMatchObject({
        port: server.port, pid: process.pid, token: server.token,
      });

      const unauthorized = await fetch(`${server.url}/api/docs`, { headers: { Authorization: 'Bearer wrong-token' } });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' });

      const request = (path: string, data?: unknown) => fetch(`${server!.url}${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${server!.token}`, 'Content-Type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const fixture = join(process.cwd(), 'fixtures/hwpx/blank.hwpx');
      const opened = await request('/api/open', { path: fixture });
      expect(opened.status).toBe(200);
      const model = await opened.json() as DocModel;
      expect(model.sourcePath).toBe(fixture);
      const paragraph = model.sections[0].paragraphs[0];
      expect(paragraph).toBeDefined();

      // Image operations can carry roughly 20 MB of base64 in their JSON body.
      const largeBody = await request(`/api/docs/${encodeURIComponent(model.docId)}/ops`, {
        ops: [], source: 'ai', padding: 'A'.repeat(20_000_000),
      });
      expect(largeBody.status).toBe(200);

      socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(server.token)}`);
      await once(socket, 'open');
      const changed = once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
      const text = 'HTTP integration edit';
      const applied = await request(`/api/docs/${encodeURIComponent(model.docId)}/ops`, {
        ops: [{ op: 'setParagraph', id: paragraph.id, runs: [{ text }] }],
        source: 'ai', clientId: 'http-test',
      });
      expect(applied.status).toBe(200);
      const result = await applied.json() as { revision: number; model: DocModel };
      expect(result.revision).toBe(model.revision + 1);
      expect(result.model.sections[0].paragraphs[0].runs.map(run => run.text).join('')).toBe(text);
      expect(await changed).toEqual({ type: 'changed', docId: model.docId, revision: result.revision, source: 'ai', clientId: 'http-test' });

      const target = join(dir, 'saved.hwpx');
      const saved = await request(`/api/docs/${encodeURIComponent(model.docId)}/save`, { path: target });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ path: target });
      expect((await openDocument(target)).plainText()).toContain(text);
    } finally {
      socket?.terminate();
      try {
        await server?.close();
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
