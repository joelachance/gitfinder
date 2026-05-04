const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitcp', {
  searchIssues: (query, options = {}) =>
    ipcRenderer.invoke('gitcp:search-issues', {
      query: typeof query === 'string' ? query : '',
      forceRefresh: Boolean(options.forceRefresh),
    }),
  listAccessibleIssues: (options) => ipcRenderer.invoke('gitcp:list-accessible-issues', options),
  listReposWithCi: () => ipcRenderer.invoke('gitcp:list-repos-ci'),
  repoView: (payload) => ipcRenderer.invoke('gitcp:repo-view', payload ?? {}),
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
  aiStatus: () => ipcRenderer.invoke('gitcp:ai-status'),
  aiChat: (message) =>
    ipcRenderer.invoke('gitcp:ai-chat', {
      message: typeof message === 'string' ? message : '',
    }),
  llmKeysStatus: () => ipcRenderer.invoke('gitcp:llm-keys-status'),
  llmKeysSet: (provider, value) =>
    ipcRenderer.invoke('gitcp:llm-keys-set', { provider, value }),
  llmKeysClearApp: (provider) => ipcRenderer.invoke('gitcp:llm-keys-clear-app', { provider }),
  llmKeysUnsetEnv: (provider) => ipcRenderer.invoke('gitcp:llm-keys-unset-env', { provider }),
  llmKeysResumeEnv: (provider) => ipcRenderer.invoke('gitcp:llm-keys-resume-env', { provider }),
});
