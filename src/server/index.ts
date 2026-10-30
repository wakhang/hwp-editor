import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { Op } from '../core/types.js';
import { OpError } from '../core/types.js';
import { SessionManager } from './session-manager.js';
export { SessionManager } from './session-manager.js';

export const serverInfoPath = () => join(homedir(), '.hwp-editor', 'server.json');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 30_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return z.record(z.string(), z.unknown()).parse(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function startServer(options: { port?: number; staticDir?: string } = {}): Promise<{ port: number; token: string; url: string; close(): Promise<void> }> {
  const manager = new SessionManager();
  const token = randomBytes(32).toString('hex');
  const validToken = (candidate: string | undefined) => {
    if (!candidate) return false;
    const a = Buffer.from(candidate), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const ws = new WebSocketServer({ noServer: true });
  const broadcast = (event: object) => {
    const data = JSON.stringify(event);
    for (const client of ws.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return json(res, 404, { error: 'Not found' });
        const root = resolve(options.staticDir ?? 'ui/dist');
        const file = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
        if (file !== root && !file.startsWith(root + sep)) return json(res, 403, { error: 'Forbidden' });
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
          res.end(data);
        } catch {
          if (url.pathname !== '/') return json(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>HWP 편집기</title><body>화면을 준비하고 있습니다.</body></html>');
        }
        return;
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
      // Image elements cannot set Authorization; accept the same token in the URL only for binary GETs.
      const imageToken = req.method === 'GET' && /^\/api\/docs\/[^/]+\/bin\/[^/]+$/.test(url.pathname) ? url.searchParams.get('token') ?? undefined : undefined;
      if (!validToken(bearer) && !validToken(imageToken)) return json(res, 401, { error: 'Unauthorized' });
      const method = req.method;
      if (method === 'GET' && url.pathname === '/api/docs') return json(res, 200, { docs: manager.list() });
      if (method === 'POST' && url.pathname === '/api/open') {
        const input = await body(req);
        if (typeof input.path !== 'string' || !input.path) return json(res, 400, { error: 'path is required' });
        const session = await manager.open(input.path);
        broadcast({ type: 'opened', docId: session.docId });
        return json(res, 200, session.model());
      }
      if (method === 'POST' && url.pathname === '/api/new') {
        const session = manager.new();
        broadcast({ type: 'opened', docId: session.docId });
        return json(res, 200, session.model());
      }
      const match = /^\/api\/docs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!match) return json(res, 404, { error: 'Not found' });
      const id = decodeURIComponent(match[1]), action = match[2] ?? '';
      const session = manager.get(id);
      if (!session) return json(res, 404, { error: 'Document not found' });
      if (method === 'GET' && !action) return json(res, 200, session.model());
      if (method === 'GET' && action === 'outline') return json(res, 200, { text: session.outline({ from: url.searchParams.get('from') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined }) });
      if (method === 'GET' && action === 'find') return json(res, 200, { hits: session.find(url.searchParams.get('q') ?? '', { regex: url.searchParams.get('regex') === 'true', matchCase: url.searchParams.get('matchCase') === 'true' }) });
      if (method === 'GET' && action.startsWith('bin/')) {
        const bin = session.getBinary(decodeURIComponent(action.slice(4)));
        if (!bin) return json(res, 404, { error: 'Binary not found' });
        res.writeHead(200, { 'Content-Type': bin.mime });
        return res.end(bin.data);
      }
      if (method === 'POST' && action === 'ops') {
        const input = await body(req);
        if (!Array.isArray(input.ops) || typeof input.source !== 'string' || !['ui', 'ai', 'cli'].includes(input.source)) return json(res, 400, { error: 'ops and source are required' });
        const result = session.apply(input.ops as Op[]);
        broadcast({ type: 'changed', docId: id, revision: result.revision, source: input.source, ...(input.clientId !== undefined ? { clientId: input.clientId } : {}) });
        return json(res, 200, { ...result, model: session.model() });
      }
      if (method === 'POST' && (action === 'undo' || action === 'redo')) {
        const input = await body(req);
        const ok = action === 'undo' ? session.undo() : session.redo();
        const model = session.model();
        if (ok) broadcast({ type: 'changed', docId: id, revision: model.revision, source: input.source });
        return json(res, 200, { ok, model });
      }
      if (method === 'POST' && action === 'save') {
        const input = await body(req);
        if (input.path !== undefined && typeof input.path !== 'string') return json(res, 400, { error: 'path must be a string' });
        const path = await session.save(input.path);
        broadcast({ type: 'saved', docId: id });
        return json(res, 200, { path });
      }
      if (method === 'POST' && action === 'close') {
        const ok = manager.close(id);
        if (ok) broadcast({ type: 'closed', docId: id });
        return json(res, 200, { ok });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof OpError) return json(res, 400, { error: error.message, opIndex: error.opIndex });
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !validToken(url.searchParams.get('token') ?? undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
  });
  let port = options.port ?? 47321;
  for (;;) {
    try {
      const listening = once(server, 'listening');
      server.listen(port, '127.0.0.1');
      await listening;
      break;
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EADDRINUSE' || port === 0 || port >= 65535) throw err;
      port++;
    }
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
  port = address.port;
  const info = serverInfoPath();
  try {
    await mkdir(join(homedir(), '.hwp-editor'), { recursive: true, mode: 0o700 });
    await writeFile(info, JSON.stringify({ port, pid: process.pid, token }), { mode: 0o600 });
    await chmod(info, 0o600);
  } catch (error) {
    ws.close(); server.close(); throw error;
  }
  return { port, token, url: `http://127.0.0.1:${port}`, async close() {
    for (const client of ws.clients) client.terminate();
    await promisify(server.close.bind(server))();
    ws.close();
    try {
      const current = JSON.parse(await readFile(info, 'utf8'));
      if (current.token === token) await unlink(info);
    } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
  } };
}
