import './env.js';
import {
  app,
  BrowserWindow,
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
  loadToken,
  loginWithOAuth,
  logout,
} from './github-oauth.js';
import { runAiChat, getAiStatus } from './ai-chat.js';
import {
  fetchRepoViewItems,
  findAccessibleRepoWithActions,
  isCiActionsEndpointBlocked,
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

/** Preload must be CommonJS — ESM preload paths often fail to load with sandbox and leave `window.gitcp` undefined. */
function getPreloadPath() {
  return path.join(__dirname, '../preload/preload.cjs');
}

function getRendererPath() {
  return path.join(__dirname, '../renderer/index.html');
}

let mainWindow = null;
let tray = null;

/**
 * Shortcuts to try in order. macOS: Command+Alt+P+R after Command+Shift+P (many apps use ⌘⇧P).
 * Final fallback is Alt+Space for visibility without stealing Cmd/Ctrl combos.
 */
const SHORTCUT_CANDIDATES =
  process.platform === 'darwin'
    ? [
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

/** True when createWindow() was triggered by showPalette() — show after ready-to-show. */
let pendingPaletteReveal = false;

function broadcastAuth() {
  const state = getAuthState();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('gitcp:auth-changed', state);
  }
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
  mainWindow.webContents.send('gitcp:focus-search');
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
  const buf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  return nativeImage.createFromBuffer(buf);
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('GitCP — click to open palette');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open GitCP',
      click: () => showPalette(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        appIsQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showPalette());
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
      console.warn('[gitcp] Could not register shortcut:', acc);
    }
  }

  if (!activeShortcut) {
    console.error('[gitcp] No global shortcuts registered — use the menu bar icon to open GitCP.');
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
    title: 'GitCP',
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
      console.error('[gitcp:renderer]', message);
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
      'User-Agent': 'gitcp/0.1.0',
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
    'User-Agent': 'gitcp/0.1.0',
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
      'Unknown repository command. Use /repo, /releases, /ci, /tags, /branches, /commits, or /activity followed by owner/repo.',
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
  ipcMain.handle('gitcp:search-issues', async (_e, payload) => {
    const query = typeof payload === 'string' ? payload : payload?.query ?? '';
    const forceRefresh =
      typeof payload === 'object' && payload !== null && payload.forceRefresh === true;
    return searchIssuesAndPrs(query, { forceRefresh });
  });
  ipcMain.handle('gitcp:list-accessible-issues', (_e, opts) =>
    listIssuesForAccessibleRepos(opts ?? {}),
  );

  ipcMain.handle('gitcp:list-repos-ci', async () => {
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to list repositories.');
    }
    return listReposWithCi(token);
  });

  ipcMain.handle('gitcp:repo-view', async (_e, payload) => {
    const kind = typeof payload?.kind === 'string' ? payload.kind : '';
    const fullName = typeof payload?.fullName === 'string' ? payload.fullName.trim() : '';
    const forceRefresh = typeof payload === 'object' && payload !== null && payload.forceRefresh === true;
    return getRepoViewData(kind, fullName, { forceRefresh });
  });

  ipcMain.handle('gitcp:open-external', async (_e, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('Invalid URL');
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('gitcp:auth-status', () => getAuthState());

  ipcMain.handle('gitcp:login', async () => {
    await loginWithOAuth();
    broadcastAuth();
    return getAuthState();
  });

  ipcMain.handle('gitcp:logout', () => {
    logout();
    clearSearchIssuesCache();
    clearRepoViewCache();
    broadcastAuth();
    return getAuthState();
  });

  ipcMain.handle('gitcp:llm-keys-status', () => llmKeysStatus());

  ipcMain.handle('gitcp:llm-keys-set', async (_e, payload) => {
    const p = payload?.provider;
    const value = typeof payload?.value === 'string' ? payload.value : '';
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    setLlmKey(p, value);
    return llmKeysStatus();
  });

  ipcMain.handle('gitcp:llm-keys-clear-app', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    clearLlmAppKey(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitcp:llm-keys-unset-env', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    unsetLlmEnvKey(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitcp:llm-keys-resume-env', async (_e, payload) => {
    const p = payload?.provider;
    if (p !== 'openai' && p !== 'anthropic') throw new Error('Invalid provider');
    resumeLlmEnv(p);
    return llmKeysStatus();
  });

  ipcMain.handle('gitcp:shortcut-info', () => ({
    candidates: SHORTCUT_CANDIDATES,
    registered: registeredShortcuts,
    primary: registeredShortcuts[0] ?? null,
    accelerator: activeShortcut,
    anyRegistered: registeredShortcuts.length > 0,
  }));

  ipcMain.handle('gitcp:hide', () => {
    hidePalette();
  });

  ipcMain.handle('gitcp:set-palette-height', (_e, heightPx) => {
    if (!mainWindow || typeof heightPx !== 'number' || !Number.isFinite(heightPx)) return;
    const [w] = mainWindow.getContentSize();
    const h = Math.min(520, Math.max(96, Math.round(heightPx)));
    mainWindow.setContentSize(Math.max(w, 480), h);
  });

  ipcMain.handle('gitcp:ai-status', () => getAiStatus());

  ipcMain.handle('gitcp:ai-chat', async (_e, payload) => {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!message) {
      throw new Error('Type your question after /ai (example: /ai summarize open issues).');
    }
    const token = loadToken()?.access_token;
    if (!token) {
      throw new Error('Sign in with GitHub to use AI.');
    }
    const reply = await runAiChat(token, message);
    return { reply };
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
