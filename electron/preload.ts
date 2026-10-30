import { contextBridge, ipcRenderer } from 'electron';

type MenuAction = 'new' | 'open' | 'save' | 'saveAs' | 'close' | 'open-path';
contextBridge.exposeInMainWorld('hwpApp', {
  isElectron: true,
  onMenu(callback: (action: MenuAction, arg?: string) => void) {
    ipcRenderer.on('menu', (_event, action: MenuAction, arg?: string) => callback(action, arg));
  },
  openDialog: (): Promise<string | null> => ipcRenderer.invoke('open-dialog'),
  saveDialog: (defaultPath: string): Promise<string | null> => ipcRenderer.invoke('save-dialog', defaultPath),
});
