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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAuthState,
  loadToken,
  loginWithOAuth,
  logout,
} from './github-oauth.js';

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
      sandbox: true,
    },
  });

  mainWindow.loadFile(getRendererPath());
  mainWindow.once('ready-to-show', () => {
    if (pendingPaletteReveal) {
      pendingPaletteReveal = false;
      revealPalette();
    }
  });

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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPalette();
  });
}

async function searchIssuesAndPrs(query) {
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
  return { items: data.items || [] };
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

function setupIpc() {
  ipcMain.handle('gitcp:search-issues', async (_e, query) => searchIssuesAndPrs(query));
  ipcMain.handle('gitcp:list-accessible-issues', (_e, opts) =>
    listIssuesForAccessibleRepos(opts ?? {}),
  );

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
    broadcastAuth();
    return getAuthState();
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
}

app.whenReady().then(() => {
  setupIpc();
  registerGlobalShortcuts();
  createTray();

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
