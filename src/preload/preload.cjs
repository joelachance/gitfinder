const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitcp', {
  searchIssues: (query) => ipcRenderer.invoke('gitcp:search-issues', query),
  openExternal: (url) => ipcRenderer.invoke('gitcp:open-external', url),
  authStatus: () => ipcRenderer.invoke('gitcp:auth-status'),
  login: () => ipcRenderer.invoke('gitcp:login'),
  logout: () => ipcRenderer.invoke('gitcp:logout'),
  onAuthChanged: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on('gitcp:auth-changed', listener);
    return () => ipcRenderer.removeListener('gitcp:auth-changed', listener);
  },
  onFocusSearch: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('gitcp:focus-search', listener);
    return () => ipcRenderer.removeListener('gitcp:focus-search', listener);
  },
  shortcutInfo: () => ipcRenderer.invoke('gitcp:shortcut-info'),
  hide: () => ipcRenderer.invoke('gitcp:hide'),
  setPaletteHeight: (heightPx) => ipcRenderer.invoke('gitcp:set-palette-height', heightPx),
});
