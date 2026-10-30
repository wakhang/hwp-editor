import { resolve } from 'node:path';
import { newDocument, openDocument } from '../core/index.js';
import type { DocSession } from '../core/types.js';

export class SessionManager {
  private sessions = new Map<string, DocSession>();
  private opening = new Map<string, Promise<DocSession>>();

  list() {
    return [...this.sessions.values()].map(session => {
      const { docId, path, sourcePath, dirty, revision } = session.model();
      return { docId, path, sourcePath, dirty, revision };
    });
  }

  get(id: string): DocSession | undefined { return this.sessions.get(id); }

  async open(path: string): Promise<DocSession> {
    const absolute = resolve(path);
    const existing = [...this.sessions.values()].find(s => s.model().sourcePath && resolve(s.model().sourcePath!) === absolute);
    if (existing) return existing;
    let pending = this.opening.get(absolute);
    if (!pending) {
      pending = openDocument(absolute).then(session => {
        this.sessions.set(session.docId, session);
        return session;
      }).finally(() => this.opening.delete(absolute));
      this.opening.set(absolute, pending);
    }
    return pending;
  }

  new(): DocSession {
    const session = newDocument();
    this.sessions.set(session.docId, session);
    return session;
  }

  close(id: string): boolean { return this.sessions.delete(id); }
}
