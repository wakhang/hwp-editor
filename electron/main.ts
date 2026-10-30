import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { startServer as StartServer } from '../src/server/index.js';

let window: BrowserWindow | null = null;
let server: { url: string; token: string; close(): Promise<void> } | null = null;
let ready = false;
const pendingPaths: string[] = [];

function fileArguments(args: string[], cwd: string): string[] {
  return args.filter(arg => !arg.startsWith('-') && ['.hwp', '.hwpx'].includes(extname(arg).toLowerCase()))
    .map(arg => resolve(cwd, arg));
}

function openPath(path: string): void {
  if (!ready || !window || window.isDestroyed() || !server) {
    pendingPaths.push(path);
    return;
  }
  const endpoint = server;
  void (async () => {
    try {
      const response = await fetch(`${endpoint.url}/api/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) throw new Error(await response.text());
      // The renderer handles open-path by selecting the opened document.
      if (ready && window && !window.isDestroyed()) window.webContents.send('menu', 'open-path', path);
      else pendingPaths.push(path);
    } catch (error) {
      dialog.showErrorBox('문서 열기 오류', String(error));
    }
  })();
}

function menuAction(action: string): void {
  window?.webContents.send('menu', action);
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about', label: '이 앱에 관하여' }, { type: 'separator' }, { role: 'hide', label: '숨기기' }, { role: 'hideOthers', label: '다른 앱 숨기기' }, { role: 'unhide', label: '모두 보기' }, { type: 'separator' }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [
      { label: '새 문서', accelerator: 'CmdOrCtrl+N', click: () => menuAction('new') },
      { label: '열기…', accelerator: 'CmdOrCtrl+O', click: () => menuAction('open') },
      { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => menuAction('save') },
      { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => menuAction('saveAs') },
      { label: '문서 닫기', accelerator: 'CmdOrCtrl+W', click: () => menuAction('close') },
    ] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'toggleDevTools', label: '개발자 도구' }, { role: 'togglefullscreen', label: '전체 화면' }] },
    { label: '윈도우', submenu: [{ role: 'minimize', label: '최소화' }, { role: 'zoom', label: '확대/축소' }] },
  ]));
}

function bringToFront(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

async function createWindow(): Promise<void> {
  if (!server) return;
  window = new BrowserWindow({ width: 1200, height: 900, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  bringToFront();
  ready = false;
  window.webContents.once('did-finish-load', () => {
    ready = true;
    for (const path of pendingPaths.splice(0)) openPath(path);
  });
  window.on('closed', () => { window = null; ready = false; });
  await window.loadURL(`${server.url}/?token=${encodeURIComponent(server.token)}`);
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  for (const path of fileArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd())) openPath(path);
  app.on('open-file', (event, path) => {
    event.preventDefault();
    openPath(path);
    if (window) bringToFront();
    else if (server) void createWindow();
  });
  app.on('second-instance', (_event, args, cwd) => {
    for (const path of fileArguments(args.slice(1), cwd)) openPath(path);
    if (window) bringToFront();
    else if (server) void createWindow();
  });
  app.whenReady().then(async () => {
    if (app.isPackaged) {
      const vendor = join(process.resourcesPath, 'vendor');
      const java = join(vendor, 'jre', 'bin', 'java');
      if (!process.env.HWPED_JAVA && existsSync(java)) process.env.HWPED_JAVA = java;
      process.env.HWPED_JAR ||= join(vendor, 'hwp2hwpx-cli.jar');
    }
    ipcMain.handle('open-dialog', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'HWP 문서', extensions: ['hwp', 'hwpx'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('save-dialog', async (_event, defaultPath: string) => {
      const result = await dialog.showSaveDialog({ defaultPath, filters: [{ name: 'HWP 문서', extensions: ['hwpx', 'hwp'] }] });
      return result.canceled ? null : result.filePath ?? null;
    });
    const serverModule = pathToFileURL(join(__dirname, '..', 'server', 'server.mjs')).href;
    // The CommonJS Electron entry loads the separately bundled ESM server.
    const { startServer }: { startServer: typeof StartServer } = await import(serverModule);
    server = await startServer({ staticDir: join(app.getAppPath(), 'ui', 'dist') });
    installMenu();
    await createWindow();
    app.on('activate', () => { if (!window) void createWindow(); });
  }).catch(error => { dialog.showErrorBox('시작 오류', String(error)); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (!server) return;
    event.preventDefault();
    const closing = server;
    server = null;
    void closing.close().finally(() => app.quit());
  });
}
