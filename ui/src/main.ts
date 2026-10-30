import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { tableEditing } from 'prosemirror-tables';
import { Mapping } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import type { Align, DocModel, Op } from '../../src/core/types';
import { schema, modelToDoc } from './model';
import { diff } from './diff';
import './style.css';

declare global { interface Window { hwpApp?: { isElectron: boolean; onMenu(cb: (action: string, path?: string) => void): void; openDialog(): Promise<string | null>; saveDialog(defaultPath?: string): Promise<string | null> } } }
const token = new URLSearchParams(location.search).get('token') ?? '';
const clientId = crypto.randomUUID();
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header class="toolbar"><span class="filename">문서 없음</span><span class="dirty-dot"></span><span class="divider"></span><div class="tools"></div><span class="spacer"></span><span class="connection"><i></i><span>연결 끊김</span></span></header><main><div class="empty"><p>한글 문서를 열거나 새 문서를 만드세요</p><button data-action="open">문서 열기</button> <button data-action="new">새 문서</button></div><div class="editor"></div></main><footer></footer><div class="toast"></div>`;
const toolbar = app.querySelector<HTMLDivElement>('.tools')!;
const editor = app.querySelector<HTMLDivElement>('.editor')!;
const empty = app.querySelector<HTMLDivElement>('.empty')!;
const footer = app.querySelector<HTMLElement>('footer')!;
let model: DocModel | null = null;
let view: EditorView | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let busy: Promise<void> = Promise.resolve();
let inFlightMapping: Mapping | null = null;
let suppress = false;
let remotePending = false;
let remoteAgain = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let switchGeneration = 0;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { let message = response.statusText; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  return response.json() as Promise<T>;
}
function error(e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
function endpoint(suffix = '') { return `/api/docs/${encodeURIComponent(model!.docId)}${suffix}`; }
function imageUrl(binId: string) { return `${endpoint(`/bin/${encodeURIComponent(binId)}`)}?token=${encodeURIComponent(token)}`; }
interface CursorPosition { id: string; offset: number }
function cursor(): CursorPosition | null {
  if (!view) return null;
  const $pos = view.state.selection.$from;
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === schema.nodes.paragraph) return { id: $pos.node(d).attrs.id as string, offset: $pos.parentOffset };
  return null;
}
function restore(doc: PMNode, saved: CursorPosition | null) {
  if (!saved?.id) return undefined;
  let result: TextSelection | undefined;
  doc.descendants((node, pos) => { if (node.type === schema.nodes.paragraph && node.attrs.id === saved.id) { result = TextSelection.create(doc, pos + 1 + Math.min(saved.offset, node.content.size)); return false; } });
  return result;
}
function install(next: DocModel, keepCursor = false) {
  const saved = keepCursor ? cursor() : null;
  model = next;
  const doc = modelToDoc(next, imageUrl);
  const selection = restore(doc, saved);
  const state = EditorState.create({ schema, doc, ...(selection ? { selection } : {}), plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo, 'Mod-s': () => { void save(); return true; } }), keymap(baseKeymap), tableEditing()] });
  if (view) view.updateState(state); else view = new EditorView(editor, { state, dispatchTransaction });
  empty.hidden = true; editor.hidden = false; renderStatus();
}
function dispatchTransaction(tr: Transaction) {
  if (!view) return;
  if (tr.docChanged && !suppress) {
    const ids = new Set<string>();
    tr.doc.descendants((node, pos) => {
      if (node.type !== schema.nodes.paragraph || !node.attrs.id) return;
      if (ids.has(node.attrs.id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: null, pageBreakBefore: false });
      else ids.add(node.attrs.id);
    });
  }
  if (inFlightMapping && tr.docChanged && !suppress) inFlightMapping.appendMapping(tr.mapping);
  view.updateState(view.state.apply(tr));
  if (tr.docChanged && !suppress) { clearTimeout(timer); timer = setTimeout(() => { void flush().catch(error); }, 400); }
  renderStatus();
}
function renderStatus() {
  const filename = app.querySelector<HTMLElement>('.filename')!;
  const dot = app.querySelector<HTMLElement>('.dirty-dot')!;
  if (!model) { filename.textContent = '문서 없음'; dot.hidden = true; footer.textContent = ''; return; }
  filename.textContent = (model.path || model.sourcePath || '제목 없음').split('/').pop()!;
  const dirty = model.dirty || !!(view && diff(model, view.state.doc).ops.length);
  dot.hidden = !dirty;
  let count = 0; view?.state.doc.descendants(node => { if (node.type === schema.nodes.paragraph) count++; });
  footer.textContent = `${model.path || model.sourcePath || '저장 경로 없음'} · 문단 ${count}개 · r${model.revision} · ${dirty ? '수정됨' : '저장됨'}`;
  if (view) {
    const { $from } = view.state.selection;
    const mark = schema.marks.cs.isInSet(view.state.storedMarks || $from.marks());
    if (mark) {
      const value = String(mark.attrs.sizePt);
      if (![...size.options].some(option => option.value === value)) size.add(new Option(`${value}pt`, value));
      size.value = value;
      if (/^#[0-9a-f]{6}$/i.test(mark.attrs.color)) color.value = mark.attrs.color;
    }
    toolbar.querySelectorAll<HTMLButtonElement>('[data-mark]').forEach(b => b.classList.toggle('active', !!mark?.attrs[b.dataset.mark!]));
    toolbar.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(b => b.classList.toggle('active', $from.parent.attrs.align === b.dataset.align));
  }
}
function flush(): Promise<void> {
  clearTimeout(timer);
  busy = busy.catch(() => {}).then(async () => {
    while (model && view) {
      const { ops, inserted } = diff(model, view.state.doc);
      if (!ops.length) break;
      const id = model.docId;
      const mapping = new Mapping(); inFlightMapping = mapping;
      let response: { model: DocModel; created: string[] };
      try { response = await api(endpoint('/ops'), { ops, source: 'ui', clientId }); } finally { inFlightMapping = null; }
      if (!view || !model || model.docId !== id) return;
      const tr = view.state.tr;
      for (let i = 0; i < inserted.length; i++) {
        const pos = mapping.map(inserted[i].pos, 1);
        const node = tr.doc.nodeAt(pos);
        if (node?.type === schema.nodes.paragraph && !node.attrs.id && response.created[i]) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: response.created[i] });
      }
      if (tr.docChanged) { suppress = true; view.dispatch(tr.setMeta('addToHistory', false)); suppress = false; }
      model = response.model; renderStatus();
    }
  });
  return busy;
}
async function reload(showToast = false) {
  if (!model) return;
  await flush();
  const id = model.docId;
  const next = await api<DocModel>(endpoint());
  if (!model || model.docId !== id) return;
  // Changes made during the fetch must be sent before replacing the view.
  if (view && diff(model, view.state.doc).ops.length) { await flush(); return reload(showToast); }
  install(next, true);
  if (showToast) { const el = app.querySelector<HTMLElement>('.toast')!; el.textContent = 'AI가 문서를 고쳤습니다'; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2500); }
}
async function perform(ops: Op[]) { if (!model) return; await flush(); await api(endpoint('/ops'), { ops, source: 'ui', clientId }); await reload(); }
async function openPath(path: string) { await flush(); install(await api<DocModel>('/api/open', { path })); }
async function open() { const path = window.hwpApp?.isElectron ? await window.hwpApp.openDialog() : prompt('열 문서의 경로를 입력하세요'); if (path) await openPath(path); }
async function create() { await flush(); install(await api<DocModel>('/api/new', {})); }
async function save(as = false) {
  if (!model) return; await flush();
  let path: string | null | undefined = model.path;
  if (as || !path) path = window.hwpApp?.isElectron ? await window.hwpApp.saveDialog(path || undefined) : prompt('저장할 경로를 입력하세요', path || '');
  if (!path) return;
  await api(endpoint('/save'), { path }); model = await api<DocModel>(endpoint()); renderStatus();
}
function clearDocument() { clearTimeout(timer); model = null; view?.destroy(); view = null; editor.hidden = true; empty.hidden = false; renderStatus(); }
async function close() { if (!model) return; await flush(); const id = model.docId; await api(endpoint('/close'), {}); if (model?.docId === id) clearDocument(); }
async function switchDocument(id: string, generation: number) {
  await flush();
  const next = await api<DocModel>(`/api/docs/${encodeURIComponent(id)}`);
  if (generation !== switchGeneration) return;
  if (view && model && diff(model, view.state.doc).ops.length) { await flush(); return switchDocument(id, generation); }
  if (model?.docId !== id) install(next);
}
function markStyle(patch: Record<string, unknown>) {
  if (!view) return;
  const { state } = view; const { from, to, empty: isEmpty, $from } = state.selection;
  const mark = schema.marks.cs;
  const current = mark.isInSet(state.storedMarks || $from.marks());
  if (isEmpty) { view.dispatch(state.tr.addStoredMark(mark.create({ ...current?.attrs, ...patch }))); view.focus(); return; }
  const tr = state.tr;
  state.doc.nodesBetween(from, to, (node, pos) => { if (!node.isText) return; const start = Math.max(from, pos), end = Math.min(to, pos + node.nodeSize); const old = mark.isInSet(node.marks); tr.removeMark(start, end, mark).addMark(start, end, mark.create({ ...old?.attrs, ...patch })); });
  view.dispatch(tr); view.focus();
}
function toggle(name: string) { if (!view) return; const { $from } = view.state.selection; const mark = schema.marks.cs.isInSet(view.state.storedMarks || $from.marks()); markStyle({ [name]: !mark?.attrs[name] }); }
function align(value: Align) { if (!view) return; const tr = view.state.tr; const { from, to } = view.state.selection; view.state.doc.nodesBetween(from, to, (node, pos) => { if (node.type === schema.nodes.paragraph) tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: value }); }); if (tr.docChanged) view.dispatch(tr); view.focus(); }
function currentParagraph() { if (!view) return null; const $pos = view.state.selection.$from; for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === schema.nodes.paragraph) return $pos.node(d).attrs.id as string | null; return null; }
function currentTable() { if (!view) return null; const $pos = view.state.selection.$from; let table: string | null = null, row: number | null = null; for (let d = $pos.depth; d > 0; d--) { const node = $pos.node(d); if (node.type === schema.nodes.table_cell) row = node.attrs.row; if (node.type === schema.nodes.table) table = node.attrs.id; } return table && row !== null ? { table, row } : null; }
async function tableInsert() { const id = currentParagraph(); if (!id) return; const input = prompt('표 크기 (행×열)', '2×2'); if (!input) return; const match = input.match(/^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/i); if (!match || +match[1] < 1 || +match[2] < 1) { alert('행과 열을 올바르게 입력하세요.'); return; } await perform([{ op: 'insertTable', after: id, rows: +match[1], cols: +match[2] }]); }
function button(label: string, title: string, handler: () => void) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('click', handler); toolbar.append(b); return b; }
function divider() { const el = document.createElement('span'); el.className = 'divider'; toolbar.append(el); }
button('표', '표 삽입', () => { void tableInsert().catch(error); });
button('+행', '행 삽입', () => { const c = currentTable(); if (c) void perform([{ op: 'insertRow', tableId: c.table, at: c.row + 1 }]).catch(error); });
button('−행', '행 삭제', () => { const c = currentTable(); if (c) void perform([{ op: 'deleteRow', tableId: c.table, row: c.row }]).catch(error); }); divider();
for (const [label, title, name] of [['B','굵게','bold'],['I','기울임','italic'],['U','밑줄','underline'],['S','취소선','strike']]) button(label, title, () => toggle(name)).dataset.mark = name;
const size = document.createElement('select'); size.title = '글자 크기'; for (let i = 8; i <= 36; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = `${i}pt`; if (i === 10) o.selected = true; size.append(o); } size.onchange = () => markStyle({ sizePt: Number(size.value) }); toolbar.append(size);
const color = document.createElement('input'); color.type = 'color'; color.title = '글자 색'; color.oninput = () => markStyle({ color: color.value }); toolbar.append(color); divider();
for (const [label, title, value] of [['≡','왼쪽 정렬','left'],['≡','가운데 정렬','center'],['≡','오른쪽 정렬','right'],['☰','양쪽 정렬','justify']] as const) button(label, title, () => align(value)).dataset.align = value; divider();
button('↶', '실행 취소', () => { if (view) undo(view.state, view.dispatch); }); button('↷', '다시 실행', () => { if (view) redo(view.state, view.dispatch); }); button('저장', '저장', () => { void save().catch(error); });
app.querySelector('[data-action="open"]')!.addEventListener('click', () => { void open().catch(error); }); app.querySelector('[data-action="new"]')!.addEventListener('click', () => { void create().catch(error); });
window.hwpApp?.onMenu((action, path) => { const run = action === 'new' ? create() : action === 'open' ? open() : action === 'open-path' && path ? openPath(path) : action === 'save' ? save() : action === 'saveAs' ? save(true) : action === 'close' ? close() : Promise.resolve(); void run.catch(error); });
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save().catch(error); } });
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  const indicator = app.querySelector<HTMLElement>('.connection')!;
  const label = indicator.querySelector('span')!;
  ws.onopen = () => { indicator.classList.add('online'); label.textContent = 'AI 연결됨'; };
  ws.onclose = () => { indicator.classList.remove('online'); label.textContent = '연결 끊김'; setTimeout(connect, 1500); };
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'opened') {
      const generation = ++switchGeneration;
      void switchDocument(msg.docId, generation).catch(error);
    } else if (msg.type === 'closed') {
      if (model?.docId === msg.docId) { ++switchGeneration; clearDocument(); }
    } else if (msg.type === 'changed' && model && msg.docId === model.docId && msg.clientId !== clientId) {
      if (remotePending) { remoteAgain = true; return; }
      remotePending = true;
      void (async () => { do { remoteAgain = false; await reload(true); } while (remoteAgain); })().catch(error).finally(() => { remotePending = false; });
    } else if (msg.type === 'saved' && model && msg.docId === model.docId) {
      void api<DocModel>(endpoint()).then(next => { if (model?.docId === next.docId) { model = next; renderStatus(); } }).catch(error);
    }
  };
}
connect();
void api<{ docs: { docId: string }[] }>('/api/docs').then(async ({ docs }) => { if (docs.length && !model) install(await api<DocModel>(`/api/docs/${encodeURIComponent(docs[0].docId)}`)); }).catch(error);
