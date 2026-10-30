import type { Document, Element, Node } from '@xmldom/xmldom';

type Prefix = 'p' | 't' | 'c' | 'o' | 's';
type Saved = { next: Record<Prefix, number>; entries: [string, number, number[]][] };

/** Session-local identities, stored separately from the document XML. */
export class Registry {
  private byElement = new WeakMap<Element, string>();
  private byId = new Map<string, Element>();
  private next: Record<Prefix, number> = { s: 0, p: 1, t: 1, c: 1, o: 1 };
  constructor(private docs: Document[]) {}

  id(el: Element, prefix: Prefix): string {
    let id = this.byElement.get(el);
    if (!id) {
      id = `${prefix}${this.next[prefix]++}`;
      this.byElement.set(el, id);
      this.byId.set(id, el);
    }
    return id;
  }

  get(id: string): Element | undefined {
    const el = this.byId.get(id);
    if (!el) return undefined;
    let node: Node | null = el;
    while (node.parentNode) node = node.parentNode;
    return this.docs.includes(node as Document) ? el : undefined;
  }

  snapshot(): string {
    const entries: Saved['entries'] = [];
    for (const [id, el] of this.byId) {
      const docIndex = el.ownerDocument ? this.docs.indexOf(el.ownerDocument) : -1;
      if (docIndex < 0) continue;
      const path: number[] = [];
      let node: Node = el;
      while (node.parentNode) {
        const parent: Node = node.parentNode;
        let i = 0;
        for (let child = parent.firstChild; child && child !== node; child = child.nextSibling) i++;
        path.unshift(i);
        node = parent;
      }
      if (node === this.docs[docIndex]) entries.push([id, docIndex, path]);
    }
    return JSON.stringify({ next: this.next, entries });
  }

  restore(snapshot: string, docs: Document[]): void {
    const saved = JSON.parse(snapshot) as Saved;
    this.docs = docs;
    this.next = saved.next;
    this.byElement = new WeakMap();
    this.byId = new Map();
    for (const [id, docIndex, path] of saved.entries) {
      let node: Node | null = docs[docIndex];
      for (const index of path) node = node?.childNodes.item(index) ?? null;
      if (node?.nodeType === 1) {
        this.byElement.set(node as Element, id);
        this.byId.set(id, node as Element);
      }
    }
  }
}
