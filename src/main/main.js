import './env.js';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAuthState,
  getOAuthAppConnectionsUrl,
  loadToken,
  loginWithOAuth,
  logout,
} from './github-oauth.js';
import { runAiChat, getAiStatus } from './ai-chat.js';
import {
  fetchRepoViewItems,
  findAccessibleRepoWithActions,
  isCiActionsEndpointBlocked,
  listAccessibleOrgs,
  listHomeActivity,
  listReposWithCi,
  parseOwnerRepo,
} from './github-repo.js';
import {
  initLlmKeys,
  llmKeysStatus,
  setLlmKey,
  clearLlmAppKey,
  unsetLlmEnvKey,
  resumeLlmEnv,
} from './llm-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_ICON_PATH = path.join(__dirname, 'assets/GitHubTemplate.png');

/** Preload must be CommonJS — ESM preload paths often fail to load with sandbox and leave `window.gitfinder` undefined. */
function getPreloadPath() {
  return path.join(__dirname, '../preload/preload.cjs');
}

function getRendererPath() {
  return path.join(__dirname, '../renderer/index.html');
}

let mainWindow = null;
let tray = null;

/**
 * Shortcuts to try in order. macOS leads with Command+G by default, then falls back.
 * Final fallback is Alt+Space for visibility without stealing Cmd/Ctrl combos.
 */
const SHORTCUT_CANDIDATES =
  process.platform === 'darwin'
    ? [
        'Command+G',
        'Command+Shift+P',
        'Command+Alt+P+R',
        'Command+Alt+P',
        'Alt+Space',
      ]
    : [
        'Control+Shift+P',
        'Control+Alt+P+R',
        'Control+Alt+P',
        'Alt+Space',
      ];

let registeredShortcuts = [];
let activeShortcut = null;

let appIsQuitting = false;

const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const REPO_VIEW_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { items: unknown[]; fetchedAt: number }>} */
const searchIssuesCache = new Map();
/** @type {Map<string, { items: unknown[]; fetchedAt: number }>} */
const repoViewCache = new Map();

function clearSearchIssuesCache() {
  searchIssuesCache.clear();
}

function clearRepoViewCache() {
  repoViewCache.clear();
}

function pruneSearchIssuesCache() {
  const now = Date.now();
  for (const [k, v] of searchIssuesCache) {
    if (now - v.fetchedAt >= SEARCH_CACHE_TTL_MS) {
      searchIssuesCache.delete(k);
    }
  }
}

function searchIssuesCacheKey(accessToken, fullQ) {
  return crypto.createHash('sha256').update(`${accessToken}\0${fullQ}`, 'utf8').digest('hex');
}

function githubHeaders(token, { json = false } = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gitfinder/0.1.0',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function githubJsonRequest(url, token, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: githubHeaders(token, { json: body !== undefined }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => '');
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data.message || data.error || res.statusText || 'GitHub request failed';
    throw new Error(msg);
  }
  return data;
}

function requireGithubToken(message) {
  const token = loadToken()?.access_token;
  if (!token) {
    throw new Error(message);
  }
  return token;
}

function requireRepoIssuePayload(payload) {
  const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
  const issueNumber = Number(payload?.issueNumber);
  const pair = parseOwnerRepo(fullName);
  if (!pair) {
    throw new Error('Expected owner/repo for this issue action.');
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Expected a valid issue number.');
  }
  return { fullName, issueNumber, pair };
}

async function toggleSelfAssignIssue(payload) {
  const token = requireGithubToken('Sign in with GitHub to assign issues.');
  const login = getAuthState().login;
  if (!login) {
    throw new Error('GitHub login not available for assignment.');
  }
  const { issueNumber, pair } = requireRepoIssuePayload(payload);
  const currentlyAssigned = payload?.currentlyAssigned === true;
  const url = `https://api.github.com/repos/${encodeURIComponent(pair.owner)}/${encodeURIComponent(pair.repo)}/issues/${issueNumber}/assignees`;
  await githubJsonRequest(url, token, {
    method: currentlyAssigned ? 'DELETE' : 'POST',
    body: { assignees: [login] },
  });
  clearSearchIssuesCache();
  return { assigned: !currentlyAssigned, login };
}

async function reopenIssue(payload) {
  const token = requireGithubToken('Sign in with GitHub to reopen issues.');
  const { issueNumber, pair } = requireRepoIssuePayload(payload);
  const url = `https://api.github.com/repos/${encodeURIComponent(pair.owner)}/${encodeURIComponent(pair.repo)}/issues/${issueNumber}`;
  await githubJsonRequest(url, token, {
    method: 'PATCH',
    body: { state: 'open' },
  });
  clearSearchIssuesCache();
  return { state: 'open' };
}

async function rerunFailedWorkflow(payload) {
  const token = requireGithubToken('Sign in with GitHub to rerun workflows.');
  const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
  const runId = Number(payload?.runId);
  const pair = parseOwnerRepo(fullName);
  if (!pair) {
    throw new Error('Expected owner/repo for this workflow run.');
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('Expected a valid workflow run id.');
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(pair.owner)}/${encodeURIComponent(pair.repo)}/actions/runs/${runId}/rerun-failed-jobs`;
  await githubJsonRequest(url, token, { method: 'POST' });
  clearRepoViewCache();
  return { ok: true };
}

/** True when createWindow() was triggered by showPalette() — show after ready-to-show. */
let pendingPaletteReveal = false;

function broadcastAuth() {
  const state = getAuthState();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('gitfinder:auth-changed', state);
  }
  refreshTrayMenu();
}

function revealPalette() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  /* Hotkey / tray can fire repeatedly; if we're already frontmost, skip to avoid
   * redundant focus → resize churn (and growing height from measurement feedback). */
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('gitfinder:focus-search');
}

function showPalette() {
  if (!mainWindow) {
    pendingPaletteReveal = true;
    createWindow();
    return;
  }
  revealPalette();
}

function hidePalette() {
  if (!mainWindow) return;
  mainWindow.hide();
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(MENU_ICON_PATH);
  if (icon.isEmpty()) {
    console.warn('[gitfinder] Menu icon rendered empty.');
  }
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }
  return icon;
}

function authMenuItemTemplate(authState) {
  if (!authState.loggedIn) {
    return {
      label: 'Sign In with GitHub',
      click: () => {
        void signInFromTray();
      },
    };
  }

  return {
    label: authState.login ? `Sign Out (${authState.login})` : 'Sign Out',
    click: () => {
      signOut();
    },
  };
}

function buildTrayMenu() {
  const authState = getAuthState();
  return Menu.buildFromTemplate([
    {
      label: 'Open GitFinder',
      click: () => showPalette(),
    },
    { type: 'separator' },
    authMenuItemTemplate(authState),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        appIsQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray) return null;
  const authState = getAuthState();
  const tooltip =
    authState.loggedIn && authState.login
      ? `GitFinder — signed in as ${authState.login}`
      : 'GitFinder — not signed in';
  if (process.platform === 'darwin') {
    tray.setTitle('');
  }
  tray.setToolTip(tooltip);
  const menu = buildTrayMenu();
  tray.setContextMenu(menu);
  return menu;
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function signIn() {
  await loginWithOAuth();
  clearSearchIssuesCache();
  clearRepoViewCache();
  broadcastAuth();
  return getAuthState();
}

function signOut() {
  logout();
  clearSearchIssuesCache();
  clearRepoViewCache();
  broadcastAuth();
  return getAuthState();
}

async function signInFromTray() {
  try {
    await signIn();
  } catch (error) {
    dialog.showErrorBox(
      'GitFinder Sign-In Failed',
      getErrorMessage(error, 'GitHub sign-in did not complete.'),
    );
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  refreshTrayMenu();
  tray.on('click', () => {
    if (process.platform === 'darwin') {
      const menu = refreshTrayMenu();
      tray.popUpContextMenu(menu ?? undefined);
      return;
    }
    showPalette();
  });
  tray.on('right-click', () => {
    const menu = refreshTrayMenu();
    tray.popUpContextMenu(menu ?? undefined);
  });
}

function unregisterAllShortcuts() {
  for (const acc of registeredShortcuts) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredShortcuts = [];
  activeShortcut = null;
}

function registerGlobalShortcuts() {
  unregisterAllShortcuts();

  for (const acc of SHORTCUT_CANDIDATES) {
    const ok = globalShortcut.register(acc, () => showPalette());
    if (ok) {
      registeredShortcuts.push(acc);
      if (!activeShortcut) activeShortcut = acc;
    } else {
      console.warn('[gitfinder] Could not register shortcut:', acc);
    }
  }

  if (!activeShortcut) {
    console.error('[gitfinder] No global shortcuts registered — use the menu bar icon to open GitFinder.');
  }
}

function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 720,
    height: 120,
    minWidth: 480,
    minHeight: 96,
    maxHeight: 520,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    ...(process.platform === 'darwin' ? { roundedCorners: false } : {}),
    title: 'GitFinder',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      /* sandbox:true + file:// can block loading the renderer module graph; keep preload strict. */
      sandbox: false,
    },
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      console.error('[gitfinder:renderer]', message);
    }
  });

  mainWindow.loadFile(getRendererPath());
  /* ready-to-show can fail to fire for frameless+transparent on some macOS/Electron pairs; use
   * did-finish-load as a fallback so the window is not left with show: false forever. */
  const flushPendingPaletteReveal = () => {
    if (!pendingPaletteReveal || !mainWindow) return;
    pendingPaletteReveal = false;
    revealPalette();
  };
  mainWindow.once('ready-to-show', flushPendingPaletteReveal);
  mainWindow.webContents.once('did-finish-load', flushPendingPaletteReveal);

  mainWindow.on('close', (e) => {
    if (!appIsQuitting) {
      e.preventDefault();
      hidePalette();
    }
  });
}

app.on('before-quit', () => {
  appIsQuitting = true;
});

let pendingSecondInstanceFocus = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  /**
   * second-instance can arrive before `ready` on the primary. Creating a BrowserWindow
   * before `ready` breaks startup; showing before `setupIpc()` leaves the renderer without
   * IPC (and globalShortcut is registered in `whenReady`).
   */
  app.on('second-instance', () => {
    if (app.isReady()) {
      showPalette();
    } else {
      pendingSecondInstanceFocus = true;
    }
  });
}

async function searchIssuesAndPrs(query, { forceRefresh = false } = {}) {
  const q = (query || '').trim();
  if (!q) {
    return { items: [] };
  }
  const token = loadToken()?.access_token;
  if (!token) {
    throw new Error('Sign in with GitHub to search.');
  }

  const fullQ = /\bis:(issue|pr)\b|\btype:(issue|pr)\b/i.test(q)
    ? q
    : `${q} (is:issue OR is:pr)`;

  pruneSearchIssuesCache();

  const key = searchIssuesCacheKey(token, fullQ);
  if (!forceRefresh) {
    const hit = searchIssuesCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < SEARCH_CACHE_TTL_MS) {
      return { items: hit.items };
    }
  }

  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', fullQ);
  url.searchParams.set('per_page', '20');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'gitfinder/0.1.0',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || res.statusText || 'Search request failed';
    throw new Error(msg);
  }
  const items = data.items || [];
  searchIssuesCache.set(key, { items, fetchedAt: Date.now() });
  return { items };
}

function normalizeIssueListItem(item) {
  let fullName = item.repository?.full_name;
  if (!fullName && typeof item.repository_url === 'string') {
    const tail = item.repository_url.split('/repos/')[1];
    if (tail) {
      const [a, b] = tail.split('/');
      if (a && b) fullName = `${a}/${b}`;
    }
  }
  return {
    ...item,
    repository: { ...(item.repository || {}), full_name: fullName || 'unknown' },
  };
}

/**
 * Issues (and PRs) in repositories the user owns or can access (GitHub: filter=repos).
 * @param {{ state?: 'open' | 'all'; pullRequestsOnly?: boolean }} [options]
 * @see https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user
 */
async function listIssuesForAccessibleRepos(options = {}) {
  const state = options.state === 'all' ? 'all' : 'open';
  const pullRequestsOnly = Boolean(options.pullRequestsOnly);

  const token = loadToken()?.access_token;
  if (!token) {
    throw new Error('Sign in with GitHub to list issues.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gitfinder/0.1.0',
  };
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL('https://api.github.com/issues');
    url.searchParams.set('filter', 'repos');
    url.searchParams.set('state', state);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');

    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      const msg =
        (Array.isArray(data) ? null : data?.message) || res.statusText || 'List issues failed';
      throw new Error(msg);
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    for (const item of data) {
      const normalized = normalizeIssueListItem(item);
      if (pullRequestsOnly && !normalized.pull_request) {
        continue;
      }
      all.push(normalized);
    }
    if (data.length < 100) {
      break;
    }
  }
  return { items: all };
}

/**
 * @param {string} kind
 * @param {string} fullName
 * @param {{ forceRefresh?: boolean }} [options]
 */
const REPO_VIEW_KINDS = new Set([
  'repo',
  'releases',
  'ci',
  'tags',
  'branches',
  'commits',
  'activity',
]);

async function getRepoViewData(kind, fullName, options = {}) {
  const { forceRefresh = false } = options;
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (!REPO_VIEW_KINDS.has(k)) {
    throw new Error(
      'Unknown repository command. Use /releases, /ci, /tags, /branches, /commits, or /activity followed by owner/repo, or open repository summary from /repos.',
    );
  }
  const token = loadToken()?.access_token;
  if (!token) {
    throw new Error('Sign in with GitHub to browse repository data.');
  }
  const pair = parseOwnerRepo(fullName);
  if (!pair) {
    throw new Error(
      `Add owner/repo after the command so GitHub can load this data — example: /${k} octocat/Hello-World (organization or user, slash, repository name).`,
    );
  }
  const cacheKey = `${k}/${pair.owner.toLowerCase()}/${pair.repo.toLowerCase()}`;
  if (!forceRefresh) {
    const hit = repoViewCache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < REPO_VIEW_CACHE_TTL_MS) {
      return hit.response;
    }
  }
  try {
    const items = await fetchRepoViewItems(k, pair.owner, pair.repo, token);
    const response = { items };
    repoViewCache.set(cacheKey, { response, fetchedAt: Date.now() });
    return response;
  } catch (err) {
    if (k === 'ci' && isCiActionsEndpointBlocked(err)) {
      const suggestion = await findAccessibleRepoWithActions(token, {
        excludeFullName: `${pair.owner}/${pair.repo}`,
      });
      const response = {
        items: [],
        unavailable: true,
        unavailableKind: 'actions',
        requestedRepo: `${pair.owner}/${pair.repo}`,
        suggestionRepo: suggestion?.full_name ?? null,
      };
      repoViewCache.set(cacheKey, { response, fetchedAt: Date.now() });
      return response;
    }
    throw err;
  }
}

function setupIpc() {
  ipcMain.handle('gitfinder:search-issues', async (_e, payload) => {
    const query = typeof payload === 'string' ? payload : payload?.query ?? '';
    const forceRefresh =
      typeof payload === 'object' && payload !== null && payload.forceRefresh === true;
    return searchIssuesAndPrs(query, { forceRefresh });
  });
  ipcMain.handle('gitfinder:list-accessible-issues', (_e, opts) =>
    listIssuesForAccessibleRepos(opts ?? {}),
  );

  ipcMain.handle('gitfinder:list-repos-ci', async () => {
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to list repositories.');
    }
    return listReposWithCi(token);
  });

  ipcMain.handle('gitfinder:home-activity', async () => {
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to load recent activity.');
    }
    return listHomeActivity(token);
  });

  ipcMain.handle('gitfinder:list-accessible-orgs', async () => {
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to list organizations.');
    }
    return listAccessibleOrgs(token);
  });

  ipcMain.handle('gitfinder:repo-view', async (_e, payload) => {
    const kind = typeof payload?.kind === 'string' ? payload.kind : '';
    const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
    const forceRefresh = typeof payload === 'object' && payload !== null && payload.forceRefresh === true;
    return getRepoViewData(kind, fullName, { forceRefresh });
  });
  ipcMain.handle('gitfinder:copy-text', async (_e, payload) => {
    const text = typeof payload === 'string' ? payload : payload?.text ?? '';
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Nothing to copy.');
    }
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('gitfinder:issue-toggle-self-assign', async (_e, payload) =>
    toggleSelfAssignIssue(payload ?? {}),
  );
  ipcMain.handle('gitfinder:issue-reopen', async (_e, payload) => reopenIssue(payload ?? {}));
  ipcMain.handle('gitfinder:workflow-rerun-failed', async (_e, payload) =>
    rerunFailedWorkflow(payload ?? {}),
  );

  ipcMain.handle('gitfinder:open-external', async (_e, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('Invalid URL');
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('gitfinder:auth-status', () => getAuthState());
  ipcMain.handle('gitfinder:oauth-app-connections-url', () => ({
    url: getOAuthAppConnectionsUrl(),
  }));

  ipcMain.handle('gitfinder:login', async () => {
    return signIn();
  });

  ipcMain.handle('gitfinder:logout', () => signOut());

  ipcMain.handle('gitfinder:llm-keys-status', () => llmKeysStatus());

  ipcMain.handle('gitfinder:llm-keys-set', async (_e, payload) => {
    const p = payload?.provider;
    const value = typeof payload?.value === 'string' ? payload.value : '';
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    setLlmKey(p, value);
    return llmKeysStatus();
  });

  ipcMain.handle('gitfinder:llm-keys-clear-app', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    clearLlmAppKey(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitfinder:llm-keys-unset-env', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    unsetLlmEnvKey(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitfinder:llm-keys-resume-env', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    resumeLlmEnv(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitfinder:shortcut-info', () => ({
    candidates: SHORTCUT_CANDIDATES,
    registered: registeredShortcuts,
    primary: registeredShortcuts[0] ?? null,
    accelerator: activeShortcut,
    anyRegistered: registeredShortcuts.length > 0,
  }));

  ipcMain.handle('gitfinder:hide', () => {
    hidePalette();
  });

  ipcMain.handle('gitfinder:set-palette-height', (_e, heightPx) => {
    if (!mainWindow || typeof heightPx !== 'number' || !Number.isFinite(heightPx)) return;
    const [w] = mainWindow.getContentSize();
    const h = Math.min(520, Math.max(96, Math.round(heightPx)));
    mainWindow.setContentSize(Math.max(w, 480), h);
  });

  ipcMain.handle('gitfinder:ai-status', () => getAiStatus());

  ipcMain.handle('gitfinder:ai-chat', async (_e, payload) => {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!message) {
      throw new Error('Type your question after /ai (example: /ai summarize open issues).');
    }
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to use AI.');
    }
    return runAiChat(token, message);
  });
}

app.whenReady().then(() => {
  initLlmKeys();
  setupIpc();
  registerGlobalShortcuts();
  createTray();

  if (pendingSecondInstanceFocus) {
    pendingSecondInstanceFocus = false;
    showPalette();
  }

  app.on('activate', () => {
    if (mainWindow) {
      showPalette();
    }
  });
});

app.on('will-quit', () => {
  unregisterAllShortcuts();
});

app.on('window-all-closed', () => {
  /* Window may be hidden; tray keeps app alive on all platforms for palette hotkeys. */
});
