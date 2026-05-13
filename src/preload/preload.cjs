const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitfinder', {
  searchIssues: (query, options = {}) =>
    ipcRenderer.invoke('gitfinder:search-issues', {
      query: typeof query === 'string' ? query : '',
      forceRefresh: Boolean(options.forceRefresh),
    }),
  listAccessibleIssues: (options) => ipcRenderer.invoke('gitfinder:list-accessible-issues', options),
  listReposWithCi: () => ipcRenderer.invoke('gitfinder:list-repos-ci'),
  homeActivity: () => ipcRenderer.invoke('gitfinder:home-activity'),
  listAccessibleOrgs: () => ipcRenderer.invoke('gitfinder:list-accessible-orgs'),
  repoView: (payload) => ipcRenderer.invoke('gitfinder:repo-view', payload ?? {}),
  copyText: (text) => ipcRenderer.invoke('gitfinder:copy-text', { text }),
  issueToggleSelfAssign: (payload) =>
    ipcRenderer.invoke('gitfinder:issue-toggle-self-assign', payload ?? {}),
  issueReopen: (payload) => ipcRenderer.invoke('gitfinder:issue-reopen', payload ?? {}),
  workflowRerunFailed: (payload) =>
    ipcRenderer.invoke('gitfinder:workflow-rerun-failed', payload ?? {}),
  openExternal: (url) => ipcRenderer.invoke('gitfinder:open-external', url),
  authStatus: () => ipcRenderer.invoke('gitfinder:auth-status'),
  oauthAppConnectionsUrl: () => ipcRenderer.invoke('gitfinder:oauth-app-connections-url'),
  login: () => ipcRenderer.invoke('gitfinder:login'),
  logout: () => ipcRenderer.invoke('gitfinder:logout'),
  onAuthChanged: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on('gitfinder:auth-changed', listener);
    return () => ipcRenderer.removeListener('gitfinder:auth-changed', listener);
  },
  onFocusSearch: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('gitfinder:focus-search', listener);
    return () => ipcRenderer.removeListener('gitfinder:focus-search', listener);
  },
  shortcutInfo: () => ipcRenderer.invoke('gitfinder:shortcut-info'),
  hide: () => ipcRenderer.invoke('gitfinder:hide'),
  setPaletteHeight: (heightPx) => ipcRenderer.invoke('gitfinder:set-palette-height', heightPx),
  aiStatus: () => ipcRenderer.invoke('gitfinder:ai-status'),
  aiChat: (message) =>
    ipcRenderer.invoke('gitfinder:ai-chat', {
      message: typeof message === 'string' ? message : '',
    }),
  llmKeysStatus: () => ipcRenderer.invoke('gitfinder:llm-keys-status'),
  llmKeysSet: (provider, value) =>
    ipcRenderer.invoke('gitfinder:llm-keys-set', { provider, value }),
  llmKeysClearApp: (provider) => ipcRenderer.invoke('gitfinder:llm-keys-clear-app', { provider }),
  llmKeysUnsetEnv: (provider) => ipcRenderer.invoke('gitfinder:llm-keys-unset-env', { provider }),
  llmKeysResumeEnv: (provider) => ipcRenderer.invoke('gitfinder:llm-keys-resume-env', { provider }),
});
