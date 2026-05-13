import { resultIcon, Svg } from './icons.js';

const THEME_STORAGE_KEY = 'gitfinder.theme';

const GITFINDER_THEMES = [
  { id: 'github', title: 'Monochrome', subtitle: 'Black, white, and graphite (default)' },
  { id: 'paper', title: 'Paper', subtitle: 'Soft whites with graphite ink' },
  { id: 'arctic', title: 'Arctic glass', subtitle: 'Icy cyan on cool slate' },
  { id: 'plum', title: 'Plum HUD', subtitle: 'Electric magenta on purple gray' },
  { id: 'rose', title: 'Rose voltage', subtitle: 'Warm magenta-rose' },
  { id: 'split', title: 'Split neon', subtitle: 'Cyan + magenta highlights' },
];

const SEARCH_RESULT_CACHE_TTL_MS = 30_000;
const HOME_ACTIVITY_CACHE_TTL_MS = 45_000;
const HOME_EMPTY_HINT =
  'Latest GitHub activity from your recent repos. Type to search, use /help for commands, or use + for repo/user/org filters.';

const searchInput = document.getElementById('query');
const resultsEl = document.getElementById('results');
const resultsRefreshHintEl = document.getElementById('results-refresh-hint');
const hintEl = document.getElementById('hint');
const btnAuth = document.getElementById('btn-auth');
const userAvatarEl = document.getElementById('user-avatar');
const userAvatarPlaceholderEl = document.getElementById('user-avatar-placeholder');
const authMenuEl = document.getElementById('auth-menu');
const authMenuStatusEl = document.getElementById('auth-menu-status');
const authMenuActionEl = document.getElementById('auth-menu-action');
const appEl = document.getElementById('app');
const loadSpinnerEl = document.getElementById('load-spinner');
const btnFilterQualifier = document.getElementById('btn-filter-qualifier');
const filterQualifierMenuEl = document.getElementById('filter-qualifier-menu');
const filterPillsEl = document.getElementById('filter-pills');
const apiKeyDialogEl = document.getElementById('api-key-dialog');
const apiKeyDialogBackdropEl = apiKeyDialogEl?.querySelector('.api-key-dialog-backdrop') ?? null;
const apiKeyDialogPanelEl = document.getElementById('api-key-dialog-panel');
const apiKeyDialogTitleEl = document.getElementById('api-key-dialog-title');
const apiKeyDialogInputEl = document.getElementById('api-key-dialog-input');
const apiKeyDialogCancelEl = document.getElementById('api-key-dialog-cancel');

/** @type {{ kind: string, value: string }[]} */
let searchFilters = [];

let items = [];
let activeIndex = -1;
let debounceTimer = null;

/** Full list from GitHub when using `/issues`; reused while the query stays in that mode. */
let issuesListCache = null;

/** Full PR list when using `/pr` (open + closed); reused while the query stays in that mode. */
let prsListCache = null;

/** Rows from `/repos` (repos + CI summary); reused while the query stays in that mode. */
let reposListCache = null;

/** Rows from `/orgs` (accessible organizations); reused while the query stays in that mode. */
let orgsListCache = null;

/** Latest plain GitHub search snapshot; reused for exact re-open and incremental local previews. */
let searchResultsCache = null;

/** Latest home activity snapshot for the empty-input dashboard. */
let homeActivityCache = null;

/** Latest slash repo view rows for `/ci`, `/branches`, etc. */
let repoViewListCache = null;

/**
 * `/repos` drill-down: selecting a catalog row (Enter) opens an in-app menu instead of GitHub.
 * - `menu`: pick CI, activity, branches, etc. (`__repoMenuOption` rows).
 * - `list`: `repoView` data for that choice; Enter on a row opens `html_url` in the browser.
 * Esc: list → menu → back to the `/repos` result list. Changing the search line or filter pills
 * invalidates the anchor and clears this state (next `/repos` run rebuilds the catalog).
 * @type {null | { step: 'menu'; fullName: string; htmlUrl: string } | { step: 'list'; fullName: string; kind: string; htmlUrl: string }}
 */
let repoBrowseState = null;

/** Value of `reposBrowseEffectiveKey()` when `enterRepoBrowseMenu` ran; edit → exit drill-down. */
let reposBrowseAnchorKey = '';
let reposBrowseRestoreFullName = '';

/** Only the latest `runSearch` may turn off the loading spinner (overlapping async). */
let loadSeq = 0;

/** Full input line of the last successful `/ai …` (for ↑ recall). */
let lastAiInputLine = '';

/** When true, the next `runSearch` for `/ai` skips the API (after ↑ recall). */
let suppressNextAiRun = false;

/** Multi-turn AI messages shown below the input; cleared when switching to other palette modes. */
let aiTranscript = [];

/** Last `/theme` picker visibility — used to restore the committed theme when leaving that mode. */
let themePickerWasOpen = false;

/** Active in-app API key prompt state while `/api-keys` is collecting a secret. */
let apiKeyDialogState = null;
let currentAuthState = { loggedIn: false, login: null, avatarUrl: null };
let pendingResultActionKey = '';
let shortcutInfoCache = null;

function api() {
  return window.gitfinder;
}

const authMenuWrapEl = btnAuth?.closest('.text-box-profile');

function setAuthMenuOpen(open) {
  if (!btnAuth || !authMenuEl) return;
  btnAuth.setAttribute('aria-expanded', open ? 'true' : 'false');
  authMenuEl.classList.toggle('hidden', !open);
  authMenuEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  updateWindowHeight();
}

function isAuthMenuOpen() {
  return Boolean(authMenuEl && !authMenuEl.classList.contains('hidden'));
}

function updateAuthMenu() {
  if (!authMenuStatusEl || !authMenuActionEl) return;
  if (currentAuthState.loggedIn) {
    authMenuStatusEl.textContent = currentAuthState.login
      ? `Signed in as ${currentAuthState.login}`
      : 'Signed in with GitHub';
    authMenuActionEl.textContent = 'Sign out';
    authMenuActionEl.setAttribute('aria-label', 'Sign out');
  } else {
    authMenuStatusEl.textContent = 'Not signed in';
    authMenuActionEl.textContent = 'Sign in with GitHub';
    authMenuActionEl.setAttribute('aria-label', 'Sign in with GitHub');
  }
}

function openAuthMenu() {
  updateAuthMenu();
  setAuthMenuOpen(true);
  requestAnimationFrame(() => {
    authMenuActionEl?.focus();
  });
}

function closeAuthMenu({ restoreFocus = false } = {}) {
  setAuthMenuOpen(false);
  if (restoreFocus) {
    requestAnimationFrame(() => {
      btnAuth?.focus();
    });
  }
}

function focusSearchInput({ select = false, preserveSelection = false } = {}) {
  searchInput?.focus();
  if (select) {
    searchInput?.select();
    return;
  }
  if (preserveSelection) {
    return;
  }
  const len = searchInput?.value.length ?? 0;
  searchInput?.setSelectionRange(len, len);
}

function insertTextIntoSearchInput(text) {
  focusSearchInput();
  const start = searchInput.selectionStart ?? searchInput.value.length;
  const end = searchInput.selectionEnd ?? searchInput.value.length;
  searchInput.value = `${searchInput.value.slice(0, start)}${text}${searchInput.value.slice(end)}`;
  const pos = start + text.length;
  searchInput.setSelectionRange(pos, pos);
  scheduleSearch();
}

function isApiKeyDialogOpen() {
  return Boolean(apiKeyDialogState && apiKeyDialogEl && !apiKeyDialogEl.classList.contains('hidden'));
}

function closeApiKeyDialog({ value = null, restoreFocus = true } = {}) {
  const state = apiKeyDialogState;
  apiKeyDialogState = null;
  if (apiKeyDialogInputEl) {
    apiKeyDialogInputEl.value = '';
  }
  apiKeyDialogEl?.classList.add('hidden');
  state?.resolve?.(value);
  if (!restoreFocus) return;
  requestAnimationFrame(() => {
    if (state?.previousFocus?.isConnected) {
      state.previousFocus.focus();
      return;
    }
    focusSearchInput({ preserveSelection: true });
  });
}

function openApiKeyDialog(provider) {
  if (!apiKeyDialogEl || !apiKeyDialogTitleEl || !apiKeyDialogInputEl) {
    setHint('API key dialog unavailable');
    return Promise.resolve(null);
  }
  if (isApiKeyDialogOpen()) {
    closeApiKeyDialog({ restoreFocus: false });
  }
  const label = providerDisplayName(provider);
  apiKeyDialogTitleEl.textContent = `Paste ${label} API key`;
  apiKeyDialogInputEl.value = '';
  apiKeyDialogInputEl.placeholder = provider === 'anthropic' ? 'sk-ant-...' : 'sk-...';
  apiKeyDialogState = {
    provider,
    previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    resolve: null,
  };
  apiKeyDialogEl.classList.remove('hidden');
  return new Promise((resolve) => {
    if (!apiKeyDialogState) {
      resolve(null);
      return;
    }
    apiKeyDialogState.resolve = resolve;
    requestAnimationFrame(() => {
      apiKeyDialogInputEl.focus();
      apiKeyDialogInputEl.select();
    });
  });
}

function clearAiChatTranscript() {
  aiTranscript = [];
}

function trimExtractedUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  while (/[.,!?;:]$/.test(url)) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) || []).length;
    const closes = (url.match(/\)/g) || []).length;
    if (closes <= opens) break;
    url = url.slice(0, -1);
  }
  return url;
}

function extractTextLinks(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"']+/g) || [];
  const seen = new Set();
  const out = [];
  for (const match of matches) {
    const url = trimExtractedUrl(match);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function buildAiLinkTitle(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `Open ${parsed.hostname}${path}`;
  } catch {
    return `Open ${url}`;
  }
}

function transcriptToItems() {
  /** @type {unknown[]} */
  const out = [];
  for (const m of aiTranscript) {
    if (m.role === 'user') {
      out.push({ __aiUser: true, text: m.text });
    } else {
      out.push({ __aiResponse: true, text: m.text });
      const links =
        Array.isArray(m.links) && m.links.length
          ? m.links.filter((url) => typeof url === 'string' && url.trim())
          : extractTextLinks(m.text);
      for (const url of links) {
        out.push({
          __aiLinkRow: true,
          title: buildAiLinkTitle(url),
          subtitle: 'Press Enter to open this link',
          html_url: url,
        });
      }
    }
  }
  return out;
}

/**
 * Submit `/ai …` on Enter: show prompt below, clear input, then stream result into the transcript.
 * @returns {Promise<boolean>} true if this handled the key (do not run openSelected).
 */
async function submitAiChatFromEnter() {
  const inputLine = searchInput.value.trim();
  if (!isAiCommand(inputLine)) return false;
  const question = buildAiChatPayload(inputLine);
  if (!question.trim()) return false;

  const seq = ++loadSeq;
  const displayLine = inputLine;

  searchInput.value = '';
  aiTranscript.push({ role: 'user', text: displayLine });
  lastAiInputLine = displayLine;

  issuesListCache = null;
  prsListCache = null;
  reposListCache = null;

  items = [...transcriptToItems(), { __aiPending: true }];
  activeIndex = -1;
  setHint('Waiting for AI…', { muted: true });
  setLoading(true);
  renderResults();
  scrollResultsToBottom();
  updateRefreshHint();

  const endLoading = () => {
    if (seq === loadSeq) setLoading(false);
  };

  try {
    const st = await api().aiStatus();
    if (seq !== loadSeq) return true;
    if (!st?.configured) {
      aiTranscript.push({
        role: 'assistant',
        text: 'No LLM API key active. Use /api-keys or set OPENAI_API_KEY / ANTHROPIC_API_KEY in .env.local.',
      });
      items = transcriptToItems();
      activeIndex = -1;
      setHint('Configure an API key to use /ai', { muted: true });
      renderResults();
      scrollResultsToBottom();
      endLoading();
      updateRefreshHint();
      return true;
    }
    const data = await api().aiChat(question);
    if (seq !== loadSeq) return true;
    const reply = typeof data?.reply === 'string' ? data.reply : '';
    const links = Array.isArray(data?.links)
      ? data.links.filter((url) => typeof url === 'string' && url.trim())
      : [];
    aiTranscript.push({ role: 'assistant', text: reply, links });
    items = transcriptToItems();
    activeIndex = -1;
    setHint(
      `AI (${st.provider || 'openai'}) · Type /ai … and Enter for another · ↑ recall · Esc hides`,
      { muted: true },
    );
    renderResults();
    scrollResultsToBottom();
  } catch (err) {
    if (seq !== loadSeq) return true;
    aiTranscript.push({
      role: 'assistant',
      text: err?.message || 'AI request failed',
    });
    items = transcriptToItems();
    activeIndex = -1;
    setHint(err?.message || 'AI request failed');
    renderResults();
    scrollResultsToBottom();
  } finally {
    endLoading();
    updateRefreshHint();
  }
  return true;
}

function setHint(text, { muted = false } = {}) {
  hintEl.textContent = text ?? '';
  hintEl.classList.toggle('hint--muted', Boolean(text) && muted);
  updateWindowHeight();
}

function refreshShortcutLabel() {
  return typeof navigator !== 'undefined' &&
    (navigator.platform?.startsWith('Mac') ?? false)
    ? '⌘R'
    : 'Ctrl+R';
}

function updateRefreshHint() {
  if (!resultsRefreshHintEl) return;
  const trimmed = searchInput.value.trim();
  if (isThemeCommand(trimmed) || isHelpCommand(trimmed) || isAiCommand(trimmed) || shouldShowSlashCommands(trimmed)) {
    resultsRefreshHintEl.textContent = '';
    resultsRefreshHintEl.classList.add('hidden');
    updateWindowHeight();
    return;
  }
  if (isSignOutCommand(trimmed) || isApiKeysCommand(trimmed)) {
    resultsRefreshHintEl.textContent = '';
    resultsRefreshHintEl.classList.add('hidden');
    updateWindowHeight();
    return;
  }
  if (isRepoViewIncomplete(trimmed)) {
    resultsRefreshHintEl.textContent = '';
    resultsRefreshHintEl.classList.add('hidden');
    updateWindowHeight();
    return;
  }
  if (parseRepoViewCommand(trimmed)) {
    resultsRefreshHintEl.textContent = `j/k to navigate · ${refreshShortcutLabel()} to refresh`;
    resultsRefreshHintEl.classList.remove('hidden');
    updateWindowHeight();
    return;
  }
  if (isReposCommand(trimmed)) {
    resultsRefreshHintEl.textContent = `j/k to navigate · ${refreshShortcutLabel()} to refresh`;
    resultsRefreshHintEl.classList.remove('hidden');
    updateWindowHeight();
    return;
  }
  const q = buildSearchQuery();
  if (!q) {
    if (!searchInput.value.trim() && searchFilters.length === 0 && aiTranscript.length === 0 && currentAuthState.loggedIn) {
      resultsRefreshHintEl.textContent = `j/k to navigate · ${refreshShortcutLabel()} to refresh activity`;
      resultsRefreshHintEl.classList.remove('hidden');
    } else {
      resultsRefreshHintEl.textContent = '';
      resultsRefreshHintEl.classList.add('hidden');
    }
    updateWindowHeight();
    return;
  }
  resultsRefreshHintEl.textContent = `j/k to navigate · ${refreshShortcutLabel()} to refresh results`;
  resultsRefreshHintEl.classList.remove('hidden');
  updateWindowHeight();
}

function refreshSearch() {
  const inputLine = searchInput.value.trim();
  // Drill-down: refresh the loaded repo sub-list only; do not clear `reposListCache` from the menu step.
  if (repoBrowseState?.step === 'list') {
    void refreshRepoBrowseSublist({ forceSearchRefresh: true });
    return;
  }
  if (repoBrowseState) {
    return;
  }
  if (isApiKeysCommand(inputLine)) {
    void runSearch({ forceSearchRefresh: true });
    return;
  }
  void runSearch({ forceSearchRefresh: true });
}

function setLoading(on) {
  if (!loadSpinnerEl) return;
  loadSpinnerEl.classList.toggle('hidden', !on);
  loadSpinnerEl.setAttribute('aria-hidden', on ? 'false' : 'true');
  updateWindowHeight();
}

function buildSearchQuery() {
  const parts = searchFilters.map((f) => `${f.kind}:${f.value}`);
  const free = searchInput.value.trim();
  if (free) parts.push(free);
  return parts.join(' ').trim();
}

function normalizeSearchText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenizeSearchText(text) {
  return normalizeSearchText(text).split(' ').filter(Boolean);
}

function buildSearchItemHaystack(item) {
  const kind = item.pull_request ? 'pull request pr' : 'issue';
  return [
    item.title,
    issueFullName(item),
    item.number,
    item.state,
    kind,
    item.user?.login,
    item.assignee?.login,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function filterSearchResultsByQuery(list, query) {
  const terms = tokenizeSearchText(query);
  if (terms.length === 0) return list;
  return list.filter((item) => {
    const hay = buildSearchItemHaystack(item);
    return terms.every((t) => hay.includes(t));
  });
}

function isPlainSearchInput(trimmed) {
  if (!trimmed && searchFilters.length === 0) return false;
  if (isThemeCommand(trimmed)) return false;
  if (isSignOutCommand(trimmed)) return false;
  if (isApiKeysCommand(trimmed)) return false;
  if (isHelpCommand(trimmed)) return false;
  if (isAiCommand(trimmed)) return false;
  if (shouldShowSlashCommands(trimmed)) return false;
  if (isIssuesCommand(trimmed)) return false;
  if (isPrCommand(trimmed)) return false;
  if (isReposCommand(trimmed)) return false;
  if (isOrgsCommand(trimmed)) return false;
  if (isRepoViewIncomplete(trimmed)) return false;
  if (Boolean(parseRepoViewCommand(trimmed))) return false;
  return Boolean(buildSearchQuery());
}

function getFreshSearchResultsCache(query) {
  if (!searchResultsCache) return null;
  if (searchResultsCache.query !== query) return null;
  if (Date.now() - searchResultsCache.fetchedAt > SEARCH_RESULT_CACHE_TTL_MS) return null;
  return searchResultsCache;
}

function canPreviewSearchResultsFromCache(query) {
  if (!searchResultsCache?.query || !Array.isArray(searchResultsCache.items)) return false;
  const next = normalizeSearchText(query);
  const prev = normalizeSearchText(searchResultsCache.query);
  if (!next || !prev) return false;
  return next === prev || next.startsWith(prev);
}

function getFreshHomeActivityCache() {
  if (!homeActivityCache) return null;
  if (Date.now() - homeActivityCache.fetchedAt > HOME_ACTIVITY_CACHE_TTL_MS) return null;
  return homeActivityCache;
}

function getStaleHomeActivityCache() {
  return homeActivityCache;
}

function buildHomeStateItems(activityItems = []) {
  return [...activityItems];
}

function homeHintText(activityCount, scannedRepos, { refreshing = false, signedIn = currentAuthState.loggedIn } = {}) {
  if (!signedIn) {
    return 'Sign in with GitHub to see recent CI failures, commits, and repo activity here.';
  }
  if (activityCount > 0) {
    const suffix = refreshing ? ' · refreshing…' : '';
    return `${activityCount} recent updates across ${scannedRepos} repo${scannedRepos === 1 ? '' : 's'}${suffix}`;
  }
  if (scannedRepos > 0) {
    const suffix = refreshing ? ' · refreshing…' : '';
    return `No recent activity surfaced across ${scannedRepos} repo${scannedRepos === 1 ? '' : 's'}${suffix}`;
  }
  return HOME_EMPTY_HINT;
}

function renderHomeState(activityItems = [], options = {}) {
  const scannedRepos = Number.isInteger(options.scannedRepos) ? options.scannedRepos : 0;
  const refreshing = options.refreshing === true;
  const signedIn =
    typeof options.signedIn === 'boolean' ? options.signedIn : currentAuthState.loggedIn;
  items = buildHomeStateItems(activityItems);
  activeIndex = -1;
  if (items.length > 0) {
    activeIndex = 0;
  }
  setHint(homeHintText(activityItems.length, scannedRepos, { refreshing, signedIn }), { muted: true });
  setLoading(false);
  renderResults();
  updateRefreshHint();
}

function previewPlainSearchFromCache() {
  const trimmed = searchInput.value.trim();
  if (!isPlainSearchInput(trimmed)) return false;
  const query = buildSearchQuery();
  if (!canPreviewSearchResultsFromCache(query)) return false;
  const filtered = filterSearchResultsByQuery(searchResultsCache.items, query);
  items = filtered;
  activeIndex = filtered.length ? 0 : -1;
  const total = searchResultsCache.items.length;
  if (query === searchResultsCache.query) {
    setHint(
      total
        ? `${total} cached result${total === 1 ? '' : 's'} · refreshing GitHub…`
        : 'Searching GitHub…',
      { muted: true },
    );
  } else {
    setHint(
      filtered.length
        ? `${filtered.length} of ${total} cached result${total === 1 ? '' : 's'} match · refreshing GitHub…`
        : 'No cached matches · searching GitHub…',
      { muted: true },
    );
  }
  renderResults();
  setLoading(true);
  updateRefreshHint();
  return true;
}

function getRepoViewItemNoun(kind) {
  const labels = {
    repo: 'repository',
    releases: 'release',
    ci: 'workflow run',
    tags: 'tag',
    branches: 'branch',
    commits: 'commit',
    activity: 'event',
  };
  return labels[kind] ?? 'item';
}

function getFreshRepoViewListCache(kind, fullName) {
  if (!repoViewListCache) return null;
  if (repoViewListCache.kind !== kind || repoViewListCache.fullName !== fullName) return null;
  if (Date.now() - repoViewListCache.fetchedAt > SEARCH_RESULT_CACHE_TTL_MS) return null;
  return repoViewListCache;
}

function getStaleRepoViewListCache(kind, fullName) {
  if (!repoViewListCache) return null;
  if (repoViewListCache.kind !== kind || repoViewListCache.fullName !== fullName) return null;
  return repoViewListCache;
}

function buildIssuesLocalFilterText(inputLine) {
  const filterText =
    inputLine === '/issues' || !inputLine.startsWith('/issues ')
      ? ''
      : inputLine.slice('/issues '.length).trim();
  const pillTerms = searchFilters.map((f) => f.value);
  return [filterText, ...pillTerms].filter(Boolean).join(' ');
}

function buildPrLocalFilterText(inputLine) {
  const filterText = prCommandFilterText(inputLine);
  const pillTerms = searchFilters.map((f) => f.value);
  return [filterText, ...pillTerms].filter(Boolean).join(' ');
}

/**
 * GitHub-style status: issues + PRs (open/closed/draft/merged).
 * @param {Record<string, unknown>} item
 */
function statusIconForSearchItem(item) {
  const pr = item.pull_request;
  const mergedAt = pr?.merged_at ?? item.merged_at;
  if (pr && mergedAt) {
    return { el: resultIcon('result-icon--pr-merged', Svg.prMerged), label: 'Merged pull request' };
  }
  if (pr) {
    if (item.state === 'open' && item.draft) {
      return {
        el: resultIcon('result-icon--pr-draft', Svg.prDraft),
        label: 'Draft pull request',
      };
    }
    if (item.state === 'open') {
      return {
        el: resultIcon('result-icon--pr-open', Svg.prOpen),
        label: 'Open pull request',
      };
    }
    return {
      el: resultIcon('result-icon--pr-closed', Svg.prClosed),
      label: 'Closed pull request',
    };
  }
  if (item.state === 'open') {
    return { el: resultIcon('result-icon--issue-open', Svg.issueOpen), label: 'Open issue' };
  }
  return { el: resultIcon('result-icon--issue-closed', Svg.issueClosed), label: 'Closed issue' };
}

function renderFilterPills() {
  if (!filterPillsEl) return;
  filterPillsEl.innerHTML = '';
  searchFilters.forEach((f, i) => {
    const badge = document.createElement('span');
    badge.className = `badge filter-pill filter-pill--${f.kind}`;
    badge.title = `${f.kind}:${f.value}`;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'badge-dismiss';
    dismiss.tabIndex = 0;
    dismiss.setAttribute('aria-label', `Remove ${f.kind} filter ${f.value}`);
    dismiss.title = `Remove ${f.kind}:${f.value}`;
    dismiss.dataset.index = String(i);
    dismiss.textContent = '×';

    const label = document.createElement('span');
    label.className = 'badge-label';
    label.textContent = f.value;

    badge.appendChild(dismiss);
    badge.appendChild(label);
    filterPillsEl.appendChild(badge);
  });

  filterPillsEl.onclick = (e) => {
    const btn = e.target.closest('.badge-dismiss');
    if (!btn || !filterPillsEl.contains(btn)) return;
    const i = Number(btn.dataset.index);
    if (!Number.isFinite(i) || !searchFilters[i]) return;
    removeSearchFilterAt(i);
  };

  filterPillsEl.onkeydown = (e) => {
    const btn = e.target.closest('.badge-dismiss');
    if (!btn || !filterPillsEl.contains(btn)) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();
    const i = Number(btn.dataset.index);
    if (!Number.isFinite(i) || !searchFilters[i]) return;
    removeSearchFilterAt(i);
  };

  updateWindowHeight();
}

function focusFilterDismissAt(index) {
  if (!filterPillsEl || index < 0) return false;
  const next = filterPillsEl.querySelector(`.badge-dismiss[data-index="${index}"]`);
  if (!(next instanceof HTMLButtonElement)) return false;
  next.focus();
  return true;
}

function removeSearchFilterAt(index) {
  if (!Number.isInteger(index) || index < 0 || index >= searchFilters.length) return;
  searchFilters.splice(index, 1);
  renderFilterPills();
  if (!focusFilterDismissAt(index) && !focusFilterDismissAt(index - 1)) {
    searchInput.focus();
  }
  scheduleSearch();
}

function addSearchFilter(kind, value, { nextInputValue = searchInput.value } = {}) {
  const normalizedKind = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedKind || !normalizedValue) {
    return { added: false, alreadyPresent: false };
  }
  const exists = searchFilters.some(
    (filter) =>
      filter.kind === normalizedKind &&
      filter.value.toLowerCase() === normalizedValue.toLowerCase(),
  );
  searchInput.value = nextInputValue;
  if (!exists) {
    searchFilters.push({ kind: normalizedKind, value: normalizedValue });
  }
  renderFilterPills();
  focusSearchInput();
  const pos = searchInput.value.length;
  searchInput.setSelectionRange(pos, pos);
  scheduleSearch();
  return { added: !exists, alreadyPresent: exists };
}

function tryCommitSearchFilter() {
  const t = searchInput.value.trimEnd();
  const re = /(?:^|\s)((repo|user|org):(\S+))$/;
  const m = t.match(re);
  if (!m) return false;
  const kind = m[2];
  const value = m[3];
  const prefix = t.slice(0, m.index).trimEnd();
  addSearchFilter(kind, value, { nextInputValue: prefix });
  return true;
}

/** Shown when input starts with `/` but is not yet a complete command. */
const SLASH_COMMANDS = [
  {
    command: '/issues',
    description: 'Open issues in repos you can access',
  },
  {
    command: '/pr',
    description: 'Pull requests (open & closed) in repos you can access',
  },
  {
    command: '/activity',
    description: 'Repository events — use /activity owner/repo or add a repo: badge',
  },
  {
    command: '/branches',
    description: 'Branches — use /branches owner/repo or add a repo: badge',
  },
  {
    command: '/commits',
    description: 'Recent commits — use /commits owner/repo or add a repo: badge',
  },
  {
    command: '/releases',
    description: 'Releases — use /releases owner/repo or add a repo: badge',
  },
  {
    command: '/repos',
    description: 'Your repositories + whether GitHub Actions / workflows are set up',
  },
  {
    command: '/orgs',
    description: 'Organizations your GitHub account can access, with an action to add an org: badge',
  },
  {
    command: '/tags',
    description: 'Tags — use /tags owner/repo or add a repo: badge',
  },
  {
    command: '/ci',
    description: 'Actions workflow runs — use /ci owner/repo or add a repo: badge',
  },
  {
    command: '/theme',
    description: 'Choose a color theme',
  },
  {
    command: '/ai',
    description: 'Ask about GitHub — include owner/repo for one-repo CI/data',
  },
  {
    command: '/sign-out',
    description: 'Sign out of GitHub',
  },
  {
    command: '/api-keys',
    description: 'OpenAI & Anthropic API keys (env + saved)',
  },
  {
    command: '/help',
    description: 'How badges, slash commands, shortcuts, and actions work',
  },
];

function isIssuesCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/issues' || lower.startsWith('/issues ');
}

function isReposCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/repos' || lower.startsWith('/repos ');
}

function isOrgsCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/orgs' || lower.startsWith('/orgs ');
}

function buildReposLocalFilterText(inputLine) {
  const filterText =
    inputLine === '/repos' || !inputLine.startsWith('/repos ')
      ? ''
      : inputLine.slice('/repos '.length).trim();
  const pillTerms = searchFilters.map((f) => f.value);
  return [filterText, ...pillTerms].filter(Boolean).join(' ');
}

function buildOrgsLocalFilterText(inputLine) {
  return inputLine === '/orgs' || !inputLine.startsWith('/orgs ')
    ? ''
    : inputLine.slice('/orgs '.length).trim();
}

/**
 * Same qualifier pills as `/issues` and `/repos`, combined with `/ci owner/repo` trailing text.
 * @param {{ filterText: string }} repoParsed
 */
function buildRepoViewLocalFilterText(repoParsed) {
  const pillTerms = searchFilters.filter((f) => f.kind !== 'repo').map((f) => f.value);
  return [repoParsed.filterText, ...pillTerms].filter(Boolean).join(' ');
}

function activeRepoBadgeValue() {
  for (let i = searchFilters.length - 1; i >= 0; i -= 1) {
    const filter = searchFilters[i];
    if (filter.kind === 'repo' && /^\S+\/\S+$/.test(filter.value)) {
      return filter.value;
    }
  }
  return '';
}

function isPrCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower === '/pr' || lower.startsWith('/pr ')) return true;
  return false;
}

function isThemeCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/theme' || lower.startsWith('/theme ');
}

function isSignOutCommand(trimmed) {
  return trimmed.toLowerCase() === '/sign-out';
}

function isApiKeysCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/api-keys' || lower.startsWith('/api-keys ');
}

function isHelpCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/help' || lower.startsWith('/help ');
}

function helpFilterQuery(trimmed) {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/help')) return '';
  return trimmed.slice('/help'.length).trim().toLowerCase();
}

function formatShortcutLabel(shortcutInfo) {
  return shortcutInfo?.accelerator || shortcutInfo?.primary || 'menu bar item';
}

function buildHelpItems(trimmed, shortcutInfo) {
  const q = helpFilterQuery(trimmed);
  const launchShortcut = formatShortcutLabel(shortcutInfo);
  const helpRows = [
    {
      __helpRow: true,
      title: 'Add badges',
      description:
        'Type repo:owner/name, user:octocat, or org:acme at the end of the input and press Enter to turn it into a badge. You can also press + to insert the qualifier first, or use /orgs: Enter on an org row adds a badge, while the top Add an org row opens GitHub’s GitFinder access page.',
    },
    {
      __helpRow: true,
      title: 'Use repo badges with repo commands',
      description:
        'A repo: badge can supply the repository for /ci, /branches, /commits, /releases, /tags, and /activity, so /ci works without retyping owner/repo.',
    },
    {
      __helpRow: true,
      title: 'Keyboard',
      description:
        `Launch with ${launchShortcut}. Enter opens the active row, Esc backs out or hides the palette, Tab reaches controls, and j/k or arrow keys move through results.`,
    },
    {
      __helpRow: true,
      title: 'Row actions',
      description:
        'Issue and PR rows can copy links, assign or unassign you, closed issues can reopen, branch rows can copy the branch name, and failed workflow rows can rerun failed jobs.',
    },
    {
      __helpRow: true,
      title: 'AI and auth',
      description:
        'Use /api-keys to configure OpenAI or Anthropic for /ai. The profile button signs you in or out of GitHub, and /sign-out is available from the command list too.',
    },
  ];
  const commandRows = SLASH_COMMANDS.map((command) => ({
    __slashCommand: true,
    command: command.command,
    description: command.description,
  }));
  const allRows = [...helpRows, ...commandRows];
  if (!q) return allRows;
  return allRows.filter((row) => {
    const hay = `${row.title || ''} ${row.description || ''} ${row.command || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

/** Text after `/ai` (empty if the user only typed `/ai`). */
function aiUserQuestion(trimmed) {
  if (!/^\/ai\b/i.test(trimmed)) return '';
  return trimmed.replace(/^\/ai\b/i, '').trim();
}

/**
 * Message sent to the AI: optional filter badges (`repo:`, `org:`, `user:`) plus the question text.
 * Uses the same `kind:value` encoding as filter search (`buildSearchQuery`).
 * @param {string} trimmed
 */
function buildAiChatPayload(trimmed) {
  const q = aiUserQuestion(trimmed);
  const pills = searchFilters.map((f) => `${f.kind}:${f.value}`);
  const badgeLine =
    pills.length > 0 ? `Active filter badges: ${pills.join(' ')}` : '';
  if (!badgeLine) return q;
  if (!q) return badgeLine;
  return `${badgeLine}\n\n${q}`;
}

function isAiCommand(trimmed) {
  return /^\/ai(\s|$)/i.test(trimmed);
}

function isAiIncomplete(trimmed) {
  return (
    isAiCommand(trimmed) &&
    !aiUserQuestion(trimmed) &&
    searchFilters.length === 0
  );
}

function apiKeysFilterQuery(trimmed) {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/api-keys')) return '';
  return trimmed.slice('/api-keys'.length).trim();
}

function providerDisplayName(p) {
  return p === 'openai' ? 'OpenAI' : 'Anthropic';
}

function apiKeysStatusSubtitle(st) {
  if (!st.configured) return 'Not set · Enter to paste a key';
  const src =
    st.source === 'app'
      ? 'Saved in app'
      : st.source === 'env'
        ? 'Environment variable'
        : 'Not active';
  return `${st.preview} · ${src} · Enter to replace`;
}

/**
 * @param {string} trimmed
 * @param {{
 *   openai: { configured: boolean; source: string; preview: string; startupEnvAvailable: boolean; suppressEnv: boolean };
 *   anthropic: { configured: boolean; source: string; preview: string; startupEnvAvailable: boolean; suppressEnv: boolean };
 * }} status
 */
function buildApiKeysItems(trimmed, status) {
  const q = apiKeysFilterQuery(trimmed).toLowerCase();
  /** @type {unknown[]} */
  const rows = [];

  function push(row) {
    const hay = `${row.title} ${row.subtitle}`.toLowerCase();
    if (!q || hay.includes(q)) rows.push(row);
  }

  for (const p of /** @type {const} */ (['openai', 'anthropic'])) {
    const st = status[p];
    push({
      __apiKeysRow: true,
      action: 'set',
      provider: p,
      title: `${providerDisplayName(p)} API key`,
      subtitle: apiKeysStatusSubtitle(st),
    });
    if (st.source === 'env' && st.configured) {
      push({
        __apiKeysRow: true,
        action: 'unset-env',
        provider: p,
        title: `${providerDisplayName(p)} — Stop using environment variable`,
        subtitle: 'Hide the launch-time key for this model until you resume or paste a new key',
      });
    }
    if (st.source === 'app') {
      const envName = p === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      push({
        __apiKeysRow: true,
        action: 'clear-app',
        provider: p,
        title: `${providerDisplayName(p)} — Delete saved key`,
        subtitle: st.startupEnvAvailable
          ? `Falls back to ${envName} from when GitFinder started`
          : 'Removes the stored secret from this device',
      });
    }
    if (st.suppressEnv && st.startupEnvAvailable) {
      push({
        __apiKeysRow: true,
        action: 'resume-env',
        provider: p,
        title: `${providerDisplayName(p)} — Resume from environment`,
        subtitle: 'Use the key that was available when GitFinder started',
      });
    }
  }

  return rows;
}

async function handleApiKeysAction(row) {
  const { action, provider } = row;
  if (action === 'set') {
    const label = providerDisplayName(provider);
    const next = await openApiKeyDialog(provider);
    if (next === null) return;
    const t = next.trim();
    if (!t) {
      setHint('Key unchanged');
      return;
    }
    try {
      await api().llmKeysSet(provider, t);
      setHint(`${label} key saved in app`);
    } catch (e) {
      setHint(e?.message || 'Could not save key');
    }
    scheduleSearch();
    return;
  }
  try {
    if (action === 'unset-env') {
      await api().llmKeysUnsetEnv(provider);
      setHint('No longer using environment variable for this model');
    } else if (action === 'clear-app') {
      await api().llmKeysClearApp(provider);
      setHint('Saved key removed');
    } else if (action === 'resume-env') {
      await api().llmKeysResumeEnv(provider);
      setHint('Using environment key again');
    }
  } catch (e) {
    setHint(e?.message || 'Update failed');
  }
  scheduleSearch();
}

function themePickerFilterQuery(trimmed) {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/theme')) return '';
  return trimmed.slice('/theme'.length).trim().toLowerCase();
}

function buildThemePickerItems(trimmed) {
  const q = themePickerFilterQuery(trimmed);
  const list = q
    ? GITFINDER_THEMES.filter((t) => {
        const hay = `${t.id} ${t.title} ${t.subtitle}`.toLowerCase();
        return hay.includes(q);
      })
    : GITFINDER_THEMES;
  return list.map((t) => ({
    __themeOption: true,
    themeId: t.id,
    command: t.title,
    description: t.subtitle,
  }));
}

function setThemeOnDom(themeId) {
  if (!GITFINDER_THEMES.some((t) => t.id === themeId)) return;
  document.documentElement.setAttribute('data-theme', themeId);
}

function getCommittedThemeId() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && GITFINDER_THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* ignore */
  }
  return 'github';
}

function restoreCommittedTheme() {
  setThemeOnDom(getCommittedThemeId());
}

/** Persist + DOM (Enter, click). */
function applyTheme(themeId) {
  setThemeOnDom(themeId);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* ignore */
  }
}

/** Live preview while `/theme` list is focused (j/k, arrows); no localStorage. */
function previewThemeSelection() {
  if (!items.length || !items[0].__themeOption) return;
  if (activeIndex < 0 || activeIndex >= items.length) {
    restoreCommittedTheme();
    return;
  }
  const row = items[activeIndex];
  if (row?.__themeOption) setThemeOnDom(row.themeId);
}

function initStoredTheme() {
  restoreCommittedTheme();
}

function prCommandFilterText(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('/pr ')) return trimmed.slice(4).trim();
  if (lower === '/pr') return '';
  return '';
}

/**
 * @param {string} trimmed
 * @returns {{ kind: string, fullName: string, filterText: string } | null}
 */
function parseRepoViewCommand(trimmed) {
  const m = trimmed.match(/^\/(releases|ci|tags|branches|commits|activity)(?:\s+(.*))?$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  const repoBadge = activeRepoBadgeValue();
  if (!rest) {
    if (!repoBadge) return null;
    return { kind, fullName: repoBadge, filterText: '' };
  }
  const [firstTok, ...tail] = rest.split(/\s+/);
  if (firstTok.includes('/')) {
    return {
      kind,
      fullName: firstTok,
      filterText: tail.join(' ').trim(),
    };
  }
  if (!repoBadge) return null;
  return {
    kind,
    fullName: repoBadge,
    filterText: rest,
  };
}

/**
 * True when the user is typing `/releases` etc. but has not yet entered owner/repo.
 * @param {string} trimmed
 */
function isRepoViewIncomplete(trimmed) {
  const m = trimmed.match(/^\/(releases|ci|tags|branches|commits|activity)(?:\s+(.*))?$/i);
  if (!m) return false;
  const rest = (m[2] || '').trim();
  const repoBadge = activeRepoBadgeValue();
  if (!rest) return !repoBadge;
  const firstTok = rest.split(/\s+/)[0];
  if (!firstTok.includes('/')) return !repoBadge;
  return false;
}

function shouldShowSlashCommands(trimmed) {
  if (!trimmed.startsWith('/')) return false;
  if (isThemeCommand(trimmed)) return false;
  if (isSignOutCommand(trimmed)) return false;
  if (isApiKeysCommand(trimmed)) return false;
  if (isHelpCommand(trimmed)) return false;
  if (isAiCommand(trimmed)) return false;
  if (isIssuesCommand(trimmed)) return false;
  if (isReposCommand(trimmed)) return false;
  if (isOrgsCommand(trimmed)) return false;
  if (isPrCommand(trimmed)) return false;
  if (parseRepoViewCommand(trimmed)) return false;
  if (isRepoViewIncomplete(trimmed)) return false;
  return true;
}

function buildSlashPickerItems(trimmed) {
  const prefix = trimmed.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.command.startsWith(prefix)).map((c) => ({
    __slashCommand: true,
    command: c.command,
    description: c.description,
  }));
}

function filterIssuesBySearchText(list, searchText) {
  const terms = searchText
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((item) => {
    const hay = `${item.title} ${issueFullName(item)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * @param {{ title: string, subtitle: string }[]} list
 * @param {string} searchText
 */
function filterRepoViewRows(list, searchText) {
  const terms = searchText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((item) => {
    const hay = `${item.title} ${item.subtitle}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// --- `/repos` drill-down (menu + repoView preview lists) ---

/** Stable key for “same `/repos` query context”: input line + qualifier pills. */
function reposBrowseEffectiveKey() {
  const line = searchInput.value.trim();
  const pillKey = searchFilters.map((f) => `${f.kind}:${f.value}`).sort().join(',');
  return `${line}|${pillKey}`;
}

/** SVG fragment for each menu row (`open`, `ci`, `activity`, …). */
function iconSvgForRepoMenuAction(action) {
  switch (action) {
    case 'open':
      return Svg.repo;
    case 'repo':
      return Svg.repo;
    case 'ci':
      return Svg.ci;
    case 'activity':
      return Svg.activity;
    case 'branches':
      return Svg.branch;
    case 'commits':
      return Svg.commit;
    case 'releases':
      return Svg.release;
    case 'tags':
      return Svg.tag;
    default:
      return Svg.repo;
  }
}

/** Enter drill-down from a `repos-catalog` row (`row.title` is `owner/repo`). */
function enterRepoBrowseMenu(fullName, htmlUrl) {
  reposBrowseAnchorKey = reposBrowseEffectiveKey();
  reposBrowseRestoreFullName = fullName;
  repoBrowseState = { step: 'menu', fullName, htmlUrl };
  buildRepoBrowseMenuItems();
}

/** Populate `items` with synthetic menu rows (`__repoMenuOption`); maps to `repoView` kinds in main. */
function buildRepoBrowseMenuItems() {
  if (repoBrowseState?.step !== 'menu') return;
  const { fullName, htmlUrl } = repoBrowseState;
  const opts = [
    { action: 'open', title: 'Open repository on GitHub', blurb: 'Main repo page' },
    { action: 'repo', title: 'Repository summary', blurb: 'Stars, language, description' },
    { action: 'ci', title: 'Workflow runs (CI)', blurb: 'Recent Actions runs' },
    { action: 'activity', title: 'Activity', blurb: 'Recent events' },
    { action: 'branches', title: 'Branches', blurb: 'Branch tips' },
    { action: 'commits', title: 'Commits', blurb: 'Recent commits on default branch' },
    { action: 'releases', title: 'Releases', blurb: 'Published releases' },
    { action: 'tags', title: 'Tags', blurb: 'Git tags' },
  ];
  items = opts.map((o) => ({
    __repoMenuOption: true,
    action: o.action,
    title: o.title,
    subtitle: `${fullName} · ${o.blurb}`,
    fullName,
    htmlUrl,
  }));
  activeIndex = items.length ? 0 : -1;
  setHint(
    `Choose a view for ${fullName} · Enter to load or open · Esc back to repo list`,
    { muted: true },
  );
  renderResults();
  updateRefreshHint();
}

/** Esc from sub-list: discard preview rows and show the destination menu again. */
function backToRepoBrowseMenu() {
  if (repoBrowseState?.step !== 'list') return;
  const { fullName, htmlUrl } = repoBrowseState;
  repoBrowseState = { step: 'menu', fullName, htmlUrl };
  buildRepoBrowseMenuItems();
}

/** Leave drill-down entirely and redraw the filtered `/repos` catalog from `reposListCache`. */
function exitRepoBrowse() {
  repoBrowseState = null;
  reposBrowseAnchorKey = '';
  void restoreReposListView();
}

/** After Esc from menu; mirrors the hint/filter logic in `runSearch`’s `/repos` branch. */
async function restoreReposListView() {
  const inputLine = searchInput.value.trim();
  if (!isReposCommand(inputLine)) {
    await runSearch();
    return;
  }
  if (!reposListCache) {
    await runSearch();
    return;
  }
  const combinedFilter = buildReposLocalFilterText(inputLine);
  const filtered = filterRepoViewRows(reposListCache, combinedFilter);
  items = filtered;
  const restoreIndex = reposBrowseRestoreFullName
    ? filtered.findIndex((item) => item.title === reposBrowseRestoreFullName)
    : -1;
  activeIndex = restoreIndex >= 0 ? restoreIndex : items.length ? 0 : -1;
  reposBrowseRestoreFullName = '';
  const n = reposListCache.length;
  if (combinedFilter) {
    setHint(
      items.length
        ? `${items.length} of ${n} repo${n === 1 ? '' : 's'} match`
        : `No matches in ${n} repo${n === 1 ? '' : 's'}`,
      { muted: true },
    );
  } else {
    setHint(
      n
        ? `${n} repo${n === 1 ? '' : 's'} · pushed recently first · CI = GitHub Actions workflows on the default branch`
        : 'No repositories returned for your account',
      { muted: true },
    );
  }
  renderResults();
  updateRefreshHint();
}

/** Status line when showing Activity/CI/etc. rows inside the palette. */
function hintForRepoBrowseSublist(total, kind, fullName) {
  const labels = {
    repo: 'repository',
    releases: 'release',
    ci: 'workflow run',
    tags: 'tag',
    branches: 'branch',
    commits: 'commit',
    activity: 'event',
  };
  const noun = labels[kind] ?? 'item';
  if (total === 0) {
    return `No ${noun}${kind === 'repo' ? '' : 's'} · ${fullName} · Esc back to menu`;
  }
  return `${total} ${noun}${total === 1 ? '' : 's'} · ${fullName} · Enter opens in browser · Esc back to menu`;
}

/** Shared loader for menu choices; same IPC as slash `/ci owner/repo` (`gitfinder:repo-view`). */
async function fetchRepoBrowseSublistRows(kind, fullName, forceRefresh) {
  const data = await api().repoView({
    kind,
    fullName,
    forceRefresh,
  });
  if (data.unavailable && data.unavailableKind === 'actions') {
    return { unavailable: true, data };
  }
  const rows = (data.items ?? []).map((r) => ({
    ...r,
    __repoView: true,
  }));
  return { rows };
}

/** Enter on a menu row: `open` → browser + exit; else load `repoView` into `items` as step `list`. */
async function handleRepoMenuSelection(row) {
  const { action, fullName, htmlUrl } = row;
  if (action === 'open') {
    await api().openExternal(htmlUrl);
    exitRepoBrowse();
    return;
  }
  const kindMap = {
    repo: 'repo',
    ci: 'ci',
    activity: 'activity',
    branches: 'branches',
    commits: 'commits',
    releases: 'releases',
    tags: 'tags',
  };
  const kind = kindMap[action];
  if (!kind) return;

  const seq = ++loadSeq;
  setLoading(true);
  try {
    const result = await fetchRepoBrowseSublistRows(kind, fullName, false);
    if (seq !== loadSeq) return;
    if (result.unavailable) {
      const data = result.data;
      const req = data.requestedRepo || fullName;
      const sug = data.suggestionRepo;
      setHint(
        sug
          ? `No Actions data for ${req} (GitHub returned 403/404). Try /ci ${sug} — we picked a repo that accepts the Actions API.`
          : `No Actions data for ${req}. GitHub blocked access and no fallback repo responded.`,
        { muted: true },
      );
      renderResults();
      return;
    }
    repoBrowseState = { step: 'list', fullName, kind, htmlUrl };
    const line = searchInput.value.trim();
    const combinedFilter = buildReposLocalFilterText(line);
    const filtered = filterRepoViewRows(result.rows, combinedFilter);
    items = filtered;
    activeIndex = items.length ? 0 : -1;
    setHint(hintForRepoBrowseSublist(items.length, kind, fullName), { muted: true });
    renderResults();
  } catch (err) {
    setHint(err?.message || 'Could not load repository data');
  } finally {
    if (seq === loadSeq) setLoading(false);
    updateRefreshHint();
  }
}

/** Cmd/Ctrl+R while on a repo sub-list: bust cache for that `kind` + `fullName` only. */
async function refreshRepoBrowseSublist({ forceSearchRefresh = false } = {}) {
  if (repoBrowseState?.step !== 'list') return;
  const { fullName, kind } = repoBrowseState;
  const seq = ++loadSeq;
  setLoading(true);
  try {
    const result = await fetchRepoBrowseSublistRows(kind, fullName, forceSearchRefresh);
    if (seq !== loadSeq) return;
    if (result.unavailable) {
      const data = result.data;
      const req = data.requestedRepo || fullName;
      const sug = data.suggestionRepo;
      setHint(
        sug
          ? `No Actions data for ${req}. Try /ci ${sug}.`
          : `No Actions data for ${req}.`,
        { muted: true },
      );
      items = [];
      activeIndex = -1;
      renderResults();
      return;
    }
    const line = searchInput.value.trim();
    const combinedFilter = buildReposLocalFilterText(line);
    const filtered = filterRepoViewRows(result.rows, combinedFilter);
    items = filtered;
    activeIndex = items.length ? 0 : -1;
    setHint(hintForRepoBrowseSublist(items.length, kind, fullName), { muted: true });
    renderResults();
  } catch (err) {
    setHint(err?.message || 'Could not refresh');
  } finally {
    if (seq === loadSeq) setLoading(false);
    updateRefreshHint();
  }
}

/**
 * @param {string | undefined} rowKind
 */
function iconForRepoViewItem(rowKind) {
  switch (rowKind) {
    case 'repo':
      return { el: resultIcon('result-icon--rv-repo', Svg.repo), label: 'Repository' };
    case 'release':
      return { el: resultIcon('result-icon--rv-release', Svg.release), label: 'Release' };
    case 'ci':
      return { el: resultIcon('result-icon--rv-ci', Svg.ci), label: 'Workflow run' };
    case 'tag':
      return { el: resultIcon('result-icon--rv-tag', Svg.tag), label: 'Tag' };
    case 'branch':
      return { el: resultIcon('result-icon--rv-branch', Svg.branch), label: 'Branch' };
    case 'commit':
      return { el: resultIcon('result-icon--rv-commit', Svg.commit), label: 'Commit' };
    case 'activity':
      return { el: resultIcon('result-icon--rv-activity', Svg.activity), label: 'Activity' };
    case 'repos-catalog':
      return { el: resultIcon('result-icon--rv-repo', Svg.repo), label: 'Repository' };
    default:
      return { el: resultIcon('result-icon--rv-repo', Svg.repo), label: 'Repository' };
  }
}

function getCurrentLoginLower() {
  return currentAuthState.login ? currentAuthState.login.toLowerCase() : '';
}

function issueFullName(item) {
  if (typeof item?.repository?.full_name === 'string' && item.repository.full_name) {
    return item.repository.full_name;
  }
  if (typeof item?.repository_url === 'string') {
    const tail = item.repository_url.split('/repos/')[1];
    if (tail) {
      const [owner, repo] = tail.split('/');
      if (owner && repo) {
        return `${owner}/${repo}`;
      }
    }
  }
  return '';
}

function issueNumber(item) {
  return Number.isInteger(item?.number) ? item.number : null;
}

function issueMatches(item, fullName, num) {
  return issueFullName(item) === fullName && issueNumber(item) === num;
}

function orgLogin(item) {
  if (typeof item?.orgLogin === 'string' && item.orgLogin.trim()) {
    return item.orgLogin.trim();
  }
  return typeof item?.title === 'string' ? item.title.trim() : '';
}

function buildManualOrgEntryRow() {
  return {
    __orgAddRow: true,
    title: 'Add an org',
    subtitle: 'Open GitHub’s GitFinder app access page so you can grant organization access',
  };
}

function buildOrgsCommandRows(filteredOrgs) {
  return [buildManualOrgEntryRow(), ...filteredOrgs];
}

function addOrgFilterFromItem(item) {
  const login = orgLogin(item);
  if (!login) return;
  const result = addSearchFilter('org', login, { nextInputValue: '' });
  setHint(
    result.alreadyPresent ? `org:${login} is already added` : `Added org:${login}`,
    { muted: true },
  );
}

function isAssignedToCurrentUser(item) {
  const login = getCurrentLoginLower();
  if (!login) return false;
  const assignees = Array.isArray(item?.assignees)
    ? item.assignees
    : item?.assignee
      ? [item.assignee]
      : [];
  return assignees.some((assignee) => assignee?.login?.toLowerCase?.() === login);
}

function mutateMatchingIssueRows(fullName, num, mutate) {
  const lists = [items, issuesListCache, prsListCache, searchResultsCache?.items];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (issueMatches(item, fullName, num)) {
        mutate(item);
      }
    }
  }
}

function applyIssueAssignmentLocally(fullName, num, assigned, login) {
  mutateMatchingIssueRows(fullName, num, (item) => {
    const assignees = Array.isArray(item.assignees)
      ? [...item.assignees]
      : item.assignee
        ? [item.assignee]
        : [];
    const next = assignees.filter((assignee) => assignee?.login?.toLowerCase?.() !== login.toLowerCase());
    if (assigned) {
      next.push({ login });
    }
    item.assignees = next;
    item.assignee = next[0] ?? null;
  });
}

function applyIssueReopenedLocally(fullName, num) {
  mutateMatchingIssueRows(fullName, num, (item) => {
    item.state = 'open';
  });
}

function mutateMatchingWorkflowRows(fullName, runId, mutate) {
  const lists = [items, repoViewListCache?.rows, homeActivityCache?.items];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.rowKind === 'ci' && item?.repoFullName === fullName && item?.runId === runId) {
        mutate(item);
      }
    }
  }
}

function markWorkflowRerunRequestedLocally(fullName, runId) {
  mutateMatchingWorkflowRows(fullName, runId, (item) => {
    if (!String(item.subtitle || '').includes('rerun requested')) {
      item.subtitle = item.subtitle ? `${item.subtitle} · rerun requested` : 'rerun requested';
    }
    item.__rerunRequested = true;
  });
}

function refreshCurrentResultsAfterMutation() {
  if (repoBrowseState?.step === 'list') {
    void refreshRepoBrowseSublist({ forceSearchRefresh: true });
    return;
  }
  void runSearch({ forceSearchRefresh: true });
}

function resultActionKey(action, item) {
  if (action.kind === 'toggle-assign' || action.kind === 'reopen') {
    return `${action.kind}:${issueFullName(item)}#${issueNumber(item)}`;
  }
  if (action.kind === 'rerun-failed') {
    return `${action.kind}:${item.repoFullName || ''}:${item.runId || ''}`;
  }
  if (action.kind === 'copy') {
    return `${action.kind}:${action.label}:${action.text}`;
  }
  return action.kind;
}

function buildResultActions(item) {
  const actions = [];
  if (item?.__repoView) {
    if (item.rowKind === 'branch' && item.title) {
      actions.push({
        kind: 'copy',
        label: 'Copy branch',
        text: item.title,
        successHint: `Copied branch ${item.title}`,
      });
    }
    if (
      item.rowKind === 'ci' &&
      item.repoFullName &&
      item.runId &&
      item.runConclusion === 'failure' &&
      !item.__rerunRequested
    ) {
      actions.push({
        kind: 'rerun-failed',
        label: 'Rerun failed',
      });
    }
    return actions;
  }
  const fullName = issueFullName(item);
  const num = issueNumber(item);
  if (!fullName || !num) return actions;
  if (item.pull_request) {
    actions.push({
      kind: 'copy',
      label: 'Copy PR URL',
      text: item.html_url || `https://github.com/${fullName}/pull/${num}`,
      successHint: 'Copied PR URL',
    });
  } else {
    actions.push({
      kind: 'copy',
      label: 'Copy issue',
      text: `${fullName}#${num}`,
      successHint: `Copied ${fullName}#${num}`,
    });
  }
  if (currentAuthState.loggedIn && currentAuthState.login) {
    actions.push({
      kind: 'toggle-assign',
      label: isAssignedToCurrentUser(item) ? 'Unassign' : 'Assign me',
    });
  }
  if (!item.pull_request && item.state === 'closed') {
    actions.push({
      kind: 'reopen',
      label: 'Reopen',
    });
  }
  return actions;
}

async function handleResultAction(action, item, index) {
  const key = resultActionKey(action, item);
  if (pendingResultActionKey === key) return;
  pendingResultActionKey = key;
  activeIndex = index;
  renderResults();
  try {
    if (action.kind === 'copy') {
      await api().copyText(action.text);
      setHint(action.successHint, { muted: true });
      return;
    }
    if (action.kind === 'toggle-assign') {
      const fullName = issueFullName(item);
      const num = issueNumber(item);
      const result = await api().issueToggleSelfAssign({
        fullName,
        issueNumber: num,
        currentlyAssigned: isAssignedToCurrentUser(item),
      });
      applyIssueAssignmentLocally(fullName, num, result.assigned, result.login);
      setHint(result.assigned ? 'Assigned to you' : 'Unassigned from you', { muted: true });
      renderResults();
      refreshCurrentResultsAfterMutation();
      return;
    }
    if (action.kind === 'reopen') {
      const fullName = issueFullName(item);
      const num = issueNumber(item);
      await api().issueReopen({
        fullName,
        issueNumber: num,
      });
      applyIssueReopenedLocally(fullName, num);
      setHint(`Reopened ${fullName}#${num}`, { muted: true });
      renderResults();
      refreshCurrentResultsAfterMutation();
      return;
    }
    if (action.kind === 'rerun-failed') {
      await api().workflowRerunFailed({
        fullName: item.repoFullName,
        runId: item.runId,
      });
      markWorkflowRerunRequestedLocally(item.repoFullName, item.runId);
      setHint('Requested rerun of failed jobs', { muted: true });
      renderResults();
      refreshCurrentResultsAfterMutation();
    }
  } catch (err) {
    setHint(err?.message || 'Action failed');
  } finally {
    if (pendingResultActionKey === key) {
      pendingResultActionKey = '';
    }
    renderResults();
  }
}

function appendResultActions(row, item, index) {
  const actions = buildResultActions(item);
  if (!actions.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'result-actions';
  actions.forEach((action, actionIndex) => {
    const btn = document.createElement('button');
    const key = resultActionKey(action, item);
    btn.type = 'button';
    btn.className = 'result-action-button';
    btn.dataset.rowIndex = String(index);
    btn.dataset.actionKind = action.kind;
    btn.dataset.actionIndex = String(actionIndex);
    if (action.kind === 'rerun-failed') {
      btn.classList.add('result-action-button--primary');
    }
    btn.textContent = action.label;
    btn.title = action.label;
    btn.setAttribute('aria-label', action.label);
    btn.disabled = pendingResultActionKey === key;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeIndex = index;
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void handleResultAction(action, item, index);
    });
    wrap.appendChild(btn);
  });
  row.appendChild(wrap);
}

function getFocusedResultActionButton() {
  const el = document.activeElement;
  return el instanceof HTMLButtonElement && el.classList.contains('result-action-button') ? el : null;
}

function focusResultActionButton(rowIndex, { kind, actionIndex } = {}) {
  if (rowIndex < 0) return false;
  const buttons = Array.from(
    resultsEl.querySelectorAll(`.result-action-button[data-row-index="${rowIndex}"]`),
  );
  if (buttons.length === 0) return false;
  let target = null;
  if (kind) {
    target = buttons.find((button) => button.dataset.actionKind === kind) ?? null;
  }
  if (!target && Number.isInteger(actionIndex)) {
    target = buttons[Math.max(0, Math.min(actionIndex, buttons.length - 1))] ?? null;
  }
  if (!target) {
    target = buttons[0] ?? null;
  }
  target?.focus();
  return Boolean(target);
}

function moveActiveResult(delta, { preserveActionFocus = false } = {}) {
  if (items.length === 0) return;
  const nextIndex = delta > 0
    ? Math.min(activeIndex + 1, items.length - 1)
    : Math.max(activeIndex - 1, 0);
  const focusedActionButton = preserveActionFocus ? getFocusedResultActionButton() : null;
  const actionKind = focusedActionButton?.dataset.actionKind ?? '';
  const actionIndex = Number(focusedActionButton?.dataset.actionIndex);
  activeIndex = nextIndex;
  renderResults();
  previewThemeSelection();
  scrollActiveIntoView();
  if (focusedActionButton) {
    requestAnimationFrame(() => {
      if (!focusResultActionButton(nextIndex, { kind: actionKind, actionIndex })) {
        focusSearchInput({ preserveSelection: true });
      }
    });
  }
}

function scrollResultsToBottom() {
  if (!resultsEl) return;
  requestAnimationFrame(() => {
    resultsEl.scrollTop = resultsEl.scrollHeight;
  });
}

function updateWindowHeight() {
  requestAnimationFrame(() => {
    if (!appEl.classList.contains('hidden')) {
      const rect = appEl.getBoundingClientRect();
      const h = Math.ceil(rect.height) + 24;
      try {
        api()?.setPaletteHeight?.(h);
      } catch {
        /* ignore */
      }
    }
  });
}

function renderResults() {
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    if (i === activeIndex) li.classList.add('active');

    const row = document.createElement('div');
    row.className = 'result-row';

    if (item.__aiUser) {
      li.classList.add('result-row--ai-user');
      const pre = document.createElement('pre');
      pre.className = 'ai-user-prompt';
      pre.textContent = typeof item.text === 'string' ? item.text : '';
      li.appendChild(pre);
      li.setAttribute('aria-label', 'Your prompt');
      resultsEl.appendChild(li);
      return;
    }

    if (item.__aiPending) {
      li.classList.add('result-row--ai-pending');
      const p = document.createElement('p');
      p.className = 'ai-pending';
      p.textContent = 'Waiting for AI…';
      li.appendChild(p);
      li.setAttribute('aria-label', 'Loading AI reply');
      resultsEl.appendChild(li);
      return;
    }

    if (item.__aiResponse) {
      li.classList.add('result-row--ai');
      const pre = document.createElement('pre');
      pre.className = 'ai-response';
      pre.textContent = typeof item.text === 'string' ? item.text : '';
      li.appendChild(pre);
      li.setAttribute('aria-label', 'AI reply');
      resultsEl.appendChild(li);
      return;
    }

    if (item.__aiLinkRow) {
      const iconWrap = resultIcon('result-icon--rv-link', Svg.link);
      iconWrap.title = 'Link';
      const main = document.createElement('div');
      main.className = 'result-main';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;
      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(iconWrap);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.subtitle}`);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__helpRow) {
      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.description;

      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.description}`);
      resultsEl.appendChild(li);
      return;
    }

    if (item.__themeOption) {
      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.command;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.description;

      main.appendChild(title);
      main.appendChild(meta);

      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.command}: ${item.description}`);

      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        applyTheme(item.themeId);
        searchInput.value = '';
        scheduleSearch();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__slashCommand) {
      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.command;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.description;

      main.appendChild(title);
      main.appendChild(meta);

      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.command}: ${item.description}`);

      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        applySelectedSlashCommand();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__signOutRow) {
      const iconWrap = resultIcon('result-icon--signout', Svg.issueClosed);
      iconWrap.title = 'Sign out';
      const main = document.createElement('div');
      main.className = 'result-main';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;
      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(iconWrap);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.subtitle}`);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__apiKeysRow) {
      const iconWrap = resultIcon('result-icon--api-keys', Svg.key);
      iconWrap.title = 'API key';
      const main = document.createElement('div');
      main.className = 'result-main';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;
      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(iconWrap);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.subtitle}`);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__orgRow) {
      const iconWrap = resultIcon('result-icon--rv-repo', Svg.repo);
      iconWrap.title = 'Organization';

      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;

      main.appendChild(title);
      main.appendChild(meta);

      row.appendChild(iconWrap);
      row.appendChild(main);
      appendResultActions(row, item, i);
      li.appendChild(row);
      li.setAttribute('aria-label', `Organization: ${item.title}`);

      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__orgAddRow) {
      const iconWrap = resultIcon('result-icon--api-keys', Svg.repo);
      iconWrap.title = 'Add organization filter';

      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;

      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(iconWrap);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.subtitle}`);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    // Second step: destination picker for a selected `/repos` row (`__repoMenuOption` is not `__repoView`).
    if (item.__repoMenuOption) {
      const iconWrap = resultIcon('result-icon--rv-repo', iconSvgForRepoMenuAction(item.action));
      iconWrap.title = item.title;
      const main = document.createElement('div');
      main.className = 'result-main';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;
      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(iconWrap);
      row.appendChild(main);
      li.appendChild(row);
      li.setAttribute('aria-label', `${item.title}: ${item.subtitle}`);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        void openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    if (item.__repoView) {
      const { el: rvIconEl, label: rvLabel } = iconForRepoViewItem(item.rowKind);
      rvIconEl.title = rvLabel;

      const main = document.createElement('div');
      main.className = 'result-main';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.subtitle;

      main.appendChild(title);
      main.appendChild(meta);

      row.appendChild(rvIconEl);
      row.appendChild(main);
      appendResultActions(row, item, i);
      li.appendChild(row);
      li.setAttribute('aria-label', `${rvLabel}: ${item.title}`);

      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        renderResults();
        openSelected();
      });
      resultsEl.appendChild(li);
      return;
    }

    const { el: iconWrap, label: statusLabel } = statusIconForSearchItem(item);
    iconWrap.title = statusLabel;

    const main = document.createElement('div');
    main.className = 'result-main';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const kind = item.pull_request ? 'PR' : 'Issue';
    const repoName = issueFullName(item) || 'unknown';
    const num = item.number != null ? String(item.number) : '–';
    meta.textContent = `${kind} · ${repoName} #${num}`;

    main.appendChild(title);
    main.appendChild(meta);

    row.appendChild(iconWrap);
    row.appendChild(main);
    appendResultActions(row, item, i);
    li.appendChild(row);
    li.setAttribute('aria-label', `${statusLabel}: ${item.title}`);

    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activeIndex = i;
      renderResults();
      openSelected();
    });
    resultsEl.appendChild(li);
  });
  updateWindowHeight();
}

function applySelectedSlashCommand() {
  const row = items[activeIndex];
  if (!row?.__slashCommand || !row.command) return;
  searchInput.value = `${row.command} `;
  searchInput.focus();
  scheduleSearch();
}

async function openSelected() {
  const row = items[activeIndex];
  if (row?.__aiUser || row?.__aiPending || row?.__aiResponse) {
    return;
  }
  if (row?.__aiLinkRow) {
    if (!row.html_url) return;
    await api().openExternal(row.html_url);
    return;
  }
  if (row?.__themeOption) {
    applyTheme(row.themeId);
    searchInput.value = '';
    scheduleSearch();
    return;
  }
  if (row?.__signOutRow) {
    try {
      await api().logout();
      searchInput.value = '';
      setHint('Signed out of GitHub');
      scheduleSearch();
    } catch (e) {
      setHint(e?.message || 'Sign out failed');
    }
    return;
  }
  if (row?.__apiKeysRow) {
    await handleApiKeysAction(row);
    return;
  }
  if (row?.__orgAddRow) {
    const info = await api().oauthAppConnectionsUrl?.();
    const url = info?.url;
    if (!url) {
      setHint('GitFinder OAuth app link is not configured. Set GITFINDER_GITHUB_CLIENT_ID first.');
      return;
    }
    await api().openExternal(url);
    return;
  }
  if (row?.__orgRow) {
    addOrgFilterFromItem(row);
    return;
  }
  if (row?.__slashCommand) {
    applySelectedSlashCommand();
    return;
  }
  // `/repos` drill-down: menu actions load data; catalog rows open the chooser (not GitHub) when at top level.
  if (row?.__repoMenuOption) {
    await handleRepoMenuSelection(row);
    return;
  }
  if (row?.__repoView && row.rowKind === 'repos-catalog' && !repoBrowseState) {
    enterRepoBrowseMenu(row.title, row.html_url);
    return;
  }
  if (!row?.html_url) return;
  await api().openExternal(row.html_url);
}

async function runSearch(options = {}) {
  const { forceSearchRefresh = false } = options;
  const seq = ++loadSeq;
  const endLoading = () => {
    if (seq === loadSeq) setLoading(false);
  };

  const inputLine = searchInput.value.trim();
  const inThemePicker = isThemeCommand(inputLine);
  if (themePickerWasOpen && !inThemePicker) {
    restoreCommittedTheme();
  }
  themePickerWasOpen = inThemePicker;

  if (inThemePicker) {
    clearAiChatTranscript();
    items = buildThemePickerItems(inputLine);
    activeIndex = items.length ? 0 : -1;
    setHint(items.length ? '' : 'No matching themes', { muted: !items.length });
    setLoading(false);
    renderResults();
    if (items.length) previewThemeSelection();
    else restoreCommittedTheme();
    updateRefreshHint();
    return;
  }

  if (isHelpCommand(inputLine)) {
    clearAiChatTranscript();
    try {
      if (!shortcutInfoCache) {
        shortcutInfoCache = await api().shortcutInfo();
      }
    } catch {
      shortcutInfoCache = null;
    }
    items = buildHelpItems(inputLine, shortcutInfoCache);
    activeIndex = items.findIndex((item) => item.__slashCommand);
    if (activeIndex < 0) {
      activeIndex = items.length ? 0 : -1;
    }
    setHint(items.length ? 'Use Enter on a slash command row to insert it.' : 'No matching help rows', {
      muted: true,
    });
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  if (isSignOutCommand(inputLine)) {
    clearAiChatTranscript();
    items = [
      {
        __signOutRow: true,
        title: 'Sign out of GitHub',
        subtitle: 'Disconnect OAuth for this app on this machine',
      },
    ];
    activeIndex = items.length ? 0 : -1;
    setHint('Enter to sign out');
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  if (isApiKeysCommand(inputLine)) {
    clearAiChatTranscript();
    setLoading(true);
    renderResults();
    try {
      const status = await api().llmKeysStatus();
      if (seq !== loadSeq) return;
      items = buildApiKeysItems(inputLine, status);
      activeIndex = items.length ? 0 : -1;
      setHint(items.length ? '' : 'No matching rows', { muted: !items.length });
    } catch (err) {
      if (seq !== loadSeq) return;
      items = [];
      activeIndex = -1;
      setHint(err?.message || 'Could not load API key status');
    } finally {
      endLoading();
      renderResults();
      updateRefreshHint();
    }
    return;
  }

  if (isAiIncomplete(inputLine)) {
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    repoViewListCache = null;
    if (aiTranscript.length > 0) {
      items = transcriptToItems();
      activeIndex = -1;
      setHint(
        'Ask a question after /ai (or add repo/org/user filter badges first — they are sent with your prompt). One-repo CI: include owner/repo or use a repo: badge. Keys: /api-keys or OPENAI_API_KEY / ANTHROPIC_API_KEY.',
        { muted: true },
      );
      setLoading(false);
      renderResults();
      updateRefreshHint();
      return;
    }
    items = [];
    activeIndex = -1;
    setHint(
      'Ask a question after /ai (or add repo/org/user filter badges first — they are sent with your prompt). One-repo CI: include owner/repo or use a repo: badge. Keys: /api-keys or OPENAI_API_KEY / ANTHROPIC_API_KEY.',
      { muted: true },
    );
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  if (shouldShowSlashCommands(inputLine)) {
    items = buildSlashPickerItems(inputLine);
    activeIndex = items.length ? 0 : -1;
    setHint(items.length ? '' : 'No matching commands', { muted: !items.length });
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  if (isRepoViewIncomplete(inputLine)) {
    clearAiChatTranscript();
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    repoViewListCache = null;
    items = [];
    activeIndex = -1;
    setHint(
      'Add owner/repo after the command, or use a repo: badge first — for example /ci octocat/Hello-World or repo:octocat/Hello-World + /ci.',
      { muted: true },
    );
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  const q = buildSearchQuery();
  if (!q) {
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    orgsListCache = null;
    repoViewListCache = null;
    if (aiTranscript.length > 0) {
      items = transcriptToItems();
      activeIndex = -1;
      setHint('');
      setLoading(false);
      renderResults();
      updateRefreshHint();
      return;
    }
    if (!currentAuthState.loggedIn) {
      renderHomeState([], { signedIn: false });
      return;
    }
    const freshHomeCache = !forceSearchRefresh ? getFreshHomeActivityCache() : null;
    if (freshHomeCache) {
      renderHomeState(freshHomeCache.items, { scannedRepos: freshHomeCache.scannedRepos });
      return;
    }
    const staleHomeCache = getStaleHomeActivityCache();
    if (staleHomeCache) {
      renderHomeState(staleHomeCache.items, {
        scannedRepos: staleHomeCache.scannedRepos,
        refreshing: true,
      });
    } else {
      renderHomeState([], { signedIn: true, refreshing: forceSearchRefresh });
    }
    setLoading(true);
    try {
      const data = await api().homeActivity();
      if (seq !== loadSeq) return;
      homeActivityCache = {
        items: (data.items ?? []).map((item) => ({
          ...item,
          __repoView: true,
        })),
        scannedRepos: Number.isInteger(data.scannedRepos) ? data.scannedRepos : 0,
        fetchedAt: Date.now(),
      };
      renderHomeState(homeActivityCache.items, {
        scannedRepos: homeActivityCache.scannedRepos,
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      if (staleHomeCache) {
        items = buildHomeStateItems(staleHomeCache.items);
        activeIndex = items.length ? 0 : -1;
        setHint(
          `${homeHintText(staleHomeCache.items.length, staleHomeCache.scannedRepos, {
            signedIn: true,
          })} · refresh failed`,
          { muted: true },
        );
        renderResults();
      } else {
        renderHomeState([], { signedIn: true });
        setHint(err?.message || 'Could not load recent activity');
      }
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  updateRefreshHint();

  if (isPrCommand(inputLine)) {
    clearAiChatTranscript();
    reposListCache = null;
    orgsListCache = null;
    repoViewListCache = null;
    const combinedFilter = buildPrLocalFilterText(inputLine);
    const cachedPrs = prsListCache;
    const needFetch = forceSearchRefresh || !cachedPrs;
    if (cachedPrs) {
      const filtered = filterIssuesBySearchText(cachedPrs, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = cachedPrs.length;
      const refreshingSuffix = forceSearchRefresh ? ' · refreshing…' : '';
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} pull request${n === 1 ? '' : 's'} match${refreshingSuffix}`
            : `No matches in ${n} pull request${n === 1 ? '' : 's'}${refreshingSuffix}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} pull request${n === 1 ? '' : 's'} (open & closed) in repos you can access${refreshingSuffix}`
            : `No pull requests in repos you can access${refreshingSuffix}`,
          { muted: true },
        );
      }
      renderResults();
    } else {
      setHint('');
      items = [];
      activeIndex = -1;
      renderResults();
    }
    setLoading(needFetch);
    try {
      if (needFetch) {
        const data = await api().listAccessibleIssues({
          state: 'all',
          pullRequestsOnly: true,
        });
        if (seq !== loadSeq) return;
        prsListCache = data.items ?? [];
      }
      const filtered = filterIssuesBySearchText(prsListCache, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = prsListCache.length;
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} pull request${n === 1 ? '' : 's'} match`
            : `No matches in ${n} pull request${n === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} pull request${n === 1 ? '' : 's'} (open & closed) in repos you can access`
            : 'No pull requests in repos you can access',
          { muted: true },
        );
      }
      renderResults();
    } catch (err) {
      prsListCache = null;
      items = [];
      activeIndex = -1;
      renderResults();
      setHint(err?.message || 'Could not load pull requests');
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  if (isIssuesCommand(inputLine)) {
    clearAiChatTranscript();
    reposListCache = null;
    orgsListCache = null;
    repoViewListCache = null;
    const combinedFilter = buildIssuesLocalFilterText(inputLine);
    const cachedIssues = issuesListCache;
    const needFetch = forceSearchRefresh || !cachedIssues;
    if (cachedIssues) {
      const filtered = filterIssuesBySearchText(cachedIssues, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = cachedIssues.length;
      const refreshingSuffix = forceSearchRefresh ? ' · refreshing…' : '';
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} issue${n === 1 ? '' : 's'} match${refreshingSuffix}`
            : `No matches in ${n} open issue${n === 1 ? '' : 's'}${refreshingSuffix}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} open issue${n === 1 ? '' : 's'} in repos you can access${refreshingSuffix}`
            : `No open issues in repos you can access${refreshingSuffix}`,
          { muted: true },
        );
      }
      renderResults();
    } else {
      setHint('');
      items = [];
      activeIndex = -1;
      renderResults();
    }
    setLoading(needFetch);
    try {
      if (needFetch) {
        const data = await api().listAccessibleIssues();
        if (seq !== loadSeq) return;
        issuesListCache = data.items ?? [];
      }
      const filtered = filterIssuesBySearchText(issuesListCache, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = issuesListCache.length;
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} issue${n === 1 ? '' : 's'} match`
            : `No matches in ${n} open issue${n === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} open issue${n === 1 ? '' : 's'} in repos you can access`
            : 'No open issues in repos you can access',
          { muted: true },
        );
      }
      renderResults();
    } catch (err) {
      issuesListCache = null;
      items = [];
      activeIndex = -1;
      renderResults();
      setHint(err?.message || 'Could not load issues');
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  if (isReposCommand(inputLine)) {
    // While drill-down is open, skip refetching the catalog unless the user changed query/pills (anchor mismatch).
    if (repoBrowseState) {
      if (reposBrowseEffectiveKey() === reposBrowseAnchorKey) {
        updateRefreshHint();
        return;
      }
      repoBrowseState = null;
      reposBrowseAnchorKey = '';
    }
    clearAiChatTranscript();
    issuesListCache = null;
    prsListCache = null;
    orgsListCache = null;
    repoViewListCache = null;
    const combinedFilter = buildReposLocalFilterText(inputLine);
    const cachedRepos = reposListCache;
    const needFetch = forceSearchRefresh || !cachedRepos;
    if (cachedRepos) {
      const filtered = filterRepoViewRows(cachedRepos, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = cachedRepos.length;
      const refreshingSuffix = forceSearchRefresh ? ' · refreshing…' : '';
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} repo${n === 1 ? '' : 's'} match${refreshingSuffix}`
            : `No matches in ${n} repo${n === 1 ? '' : 's'}${refreshingSuffix}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} repo${n === 1 ? '' : 's'} · pushed recently first · CI = GitHub Actions workflows on the default branch${refreshingSuffix}`
            : `No repositories returned for your account${refreshingSuffix}`,
          { muted: true },
        );
      }
      renderResults();
    } else {
      setHint('');
      items = [];
      activeIndex = -1;
      renderResults();
    }
    setLoading(needFetch);
    try {
      if (needFetch) {
        const data = await api().listReposWithCi();
        if (seq !== loadSeq) return;
        reposListCache = (data.items ?? []).map((r) => ({
          ...r,
          __repoView: true,
        }));
      }
      const filtered = filterRepoViewRows(reposListCache, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const n = reposListCache.length;
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${n} repo${n === 1 ? '' : 's'} match`
            : `No matches in ${n} repo${n === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} repo${n === 1 ? '' : 's'} · pushed recently first · CI = GitHub Actions workflows on the default branch`
            : 'No repositories returned for your account',
          { muted: true },
        );
      }
      renderResults();
    } catch (err) {
      reposListCache = null;
      items = [];
      activeIndex = -1;
      renderResults();
      setHint(err?.message || 'Could not load repositories');
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  if (isOrgsCommand(inputLine)) {
    clearAiChatTranscript();
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    repoViewListCache = null;
    const combinedFilter = buildOrgsLocalFilterText(inputLine);
    const cachedOrgs = orgsListCache;
    const needFetch = forceSearchRefresh || !cachedOrgs;
    if (cachedOrgs) {
      const filteredOrgs = filterRepoViewRows(cachedOrgs, combinedFilter);
      items = buildOrgsCommandRows(filteredOrgs);
      activeIndex = items.length ? 0 : -1;
      const n = cachedOrgs.length;
      const refreshingSuffix = forceSearchRefresh ? ' · refreshing…' : '';
      if (combinedFilter) {
        setHint(
          filteredOrgs.length
            ? `${filteredOrgs.length} of ${n} org${n === 1 ? '' : 's'} match${refreshingSuffix}`
            : `No matches in ${n} org${n === 1 ? '' : 's'}${refreshingSuffix}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} org${n === 1 ? '' : 's'} you can access · Enter adds an org badge · Add an org opens GitHub${refreshingSuffix}`
            : `No organizations returned for your account${refreshingSuffix}`,
          { muted: true },
        );
      }
      renderResults();
    } else {
      setHint('');
      items = [];
      activeIndex = -1;
      renderResults();
    }
    setLoading(needFetch);
    try {
      if (needFetch) {
        const data = await api().listAccessibleOrgs();
        if (seq !== loadSeq) return;
        orgsListCache = (data.items ?? []).map((org) => ({
          ...org,
          __orgRow: true,
        }));
      }
      const filteredOrgs = filterRepoViewRows(orgsListCache, combinedFilter);
      items = buildOrgsCommandRows(filteredOrgs);
      activeIndex = items.length ? 0 : -1;
      const n = orgsListCache.length;
      if (combinedFilter) {
        setHint(
          filteredOrgs.length
            ? `${filteredOrgs.length} of ${n} org${n === 1 ? '' : 's'} match`
            : `No matches in ${n} org${n === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          n
            ? `${n} org${n === 1 ? '' : 's'} you can access · Enter adds an org badge · Add an org opens GitHub`
            : 'No organizations returned for your account',
          { muted: true },
        );
      }
      renderResults();
    } catch (err) {
      orgsListCache = null;
      items = [];
      activeIndex = -1;
      renderResults();
      setHint(err?.message || 'Could not load organizations');
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  const repoParsed = parseRepoViewCommand(inputLine);
  if (repoParsed) {
    clearAiChatTranscript();
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    orgsListCache = null;
    const combinedFilter = buildRepoViewLocalFilterText(repoParsed);
    const freshRepoViewCache = !forceSearchRefresh
      ? getFreshRepoViewListCache(repoParsed.kind, repoParsed.fullName)
      : null;
    if (freshRepoViewCache) {
      const filtered = filterRepoViewRows(freshRepoViewCache.rows, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const total = freshRepoViewCache.rows.length;
      const noun = getRepoViewItemNoun(repoParsed.kind);
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${total} ${noun}${total === 1 ? '' : 's'} match`
            : `No matches in ${total} ${noun}${total === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          total
            ? `${total} ${noun}${total === 1 ? '' : 's'} · ${repoParsed.fullName}`
            : `No ${noun}s · ${repoParsed.fullName}`,
          { muted: true },
        );
      }
      setLoading(false);
      renderResults();
      updateRefreshHint();
      return;
    }
    const staleRepoViewCache = getStaleRepoViewListCache(repoParsed.kind, repoParsed.fullName);
    if (staleRepoViewCache) {
      const filtered = filterRepoViewRows(staleRepoViewCache.rows, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const total = staleRepoViewCache.rows.length;
      const noun = getRepoViewItemNoun(repoParsed.kind);
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${total} ${noun}${total === 1 ? '' : 's'} match · refreshing…`
            : `No matches in ${total} ${noun}${total === 1 ? '' : 's'} · refreshing…`,
          { muted: true },
        );
      } else {
        setHint(
          total
            ? `${total} ${noun}${total === 1 ? '' : 's'} · ${repoParsed.fullName} · refreshing…`
            : `No ${noun}s · ${repoParsed.fullName} · refreshing…`,
          { muted: true },
        );
      }
      renderResults();
    } else {
      setHint('');
    }
    setLoading(true);
    try {
      const data = await api().repoView({
        kind: repoParsed.kind,
        fullName: repoParsed.fullName,
        forceRefresh: forceSearchRefresh,
      });
      if (seq !== loadSeq) return;

      if (data.unavailable && data.unavailableKind === 'actions') {
        items = [];
        activeIndex = -1;
        renderResults();
        const req = data.requestedRepo || repoParsed.fullName;
        const sug = data.suggestionRepo;
        setHint(
          sug
            ? `No Actions data for ${req} (GitHub returned 403/404 for that repo). Try /ci ${sug} — we scanned your accessible repos and common OSS picks until one accepted the Actions API.`
            : `No Actions data for ${req}. GitHub blocked access and no fallback repo responded — check Actions settings on GitHub.`,
          { muted: true },
        );
        endLoading();
        updateRefreshHint();
        return;
      }

      const rows = (data.items ?? []).map((r) => ({
        ...r,
        __repoView: true,
      }));
      repoViewListCache = {
        kind: repoParsed.kind,
        fullName: repoParsed.fullName,
        rows,
        fetchedAt: Date.now(),
      };
      const filtered = filterRepoViewRows(rows, combinedFilter);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const total = rows.length;
      const noun = getRepoViewItemNoun(repoParsed.kind);
      if (combinedFilter) {
        setHint(
          items.length
            ? `${items.length} of ${total} ${noun}${total === 1 ? '' : 's'} match`
            : `No matches in ${total} ${noun}${total === 1 ? '' : 's'}`,
          { muted: true },
        );
      } else {
        setHint(
          total
            ? `${total} ${noun}${total === 1 ? '' : 's'} · ${repoParsed.fullName}`
            : `No ${noun}s · ${repoParsed.fullName}`,
          { muted: true },
        );
      }
      renderResults();
    } catch (err) {
      items = [];
      activeIndex = -1;
      renderResults();
      setHint(err?.message || 'Could not load repository data');
    } finally {
      endLoading();
      updateRefreshHint();
    }
    return;
  }

  if (isAiCommand(inputLine)) {
    if (suppressNextAiRun) {
      suppressNextAiRun = false;
      return;
    }
    const question = buildAiChatPayload(inputLine);
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    orgsListCache = null;
    if (!question.trim()) {
      items = [];
      activeIndex = -1;
      setHint('');
      setLoading(false);
      renderResults();
      updateRefreshHint();
      return;
    }
    setHint(
      'Press Enter to send · Filter badges (+) are included in the prompt · Esc hides palette',
      { muted: true },
    );
    setLoading(false);
    items = transcriptToItems();
    activeIndex = -1;
    renderResults();
    updateRefreshHint();
    return;
  }

  issuesListCache = null;
  prsListCache = null;
  reposListCache = null;
  orgsListCache = null;
  repoViewListCache = null;
  clearAiChatTranscript();
  const freshCachedSearch = !forceSearchRefresh ? getFreshSearchResultsCache(q) : null;
  if (freshCachedSearch) {
    items = freshCachedSearch.items;
    activeIndex = items.length ? 0 : -1;
    setHint(
      items.length
        ? `${items.length} cached result${items.length === 1 ? '' : 's'} · ${refreshShortcutLabel()} to refresh`
        : 'No cached results for this search',
      { muted: true },
    );
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }
  const staleCachedSearch =
    forceSearchRefresh && searchResultsCache?.query === q ? searchResultsCache : null;
  if (staleCachedSearch) {
    items = staleCachedSearch.items;
    activeIndex = items.length ? 0 : -1;
    setHint(
      items.length
        ? `${items.length} cached result${items.length === 1 ? '' : 's'} · refreshing GitHub…`
        : 'Refreshing GitHub…',
      { muted: true },
    );
    renderResults();
  } else {
    setHint('');
    items = [];
    activeIndex = -1;
    renderResults();
  }
  setLoading(true);
  try {
    const data = await api().searchIssues(q, {
      forceRefresh: forceSearchRefresh,
    });
    if (seq !== loadSeq) return;
    items = data.items ?? [];
    activeIndex = items.length ? 0 : -1;
    searchResultsCache = {
      query: q,
      items,
      fetchedAt: Date.now(),
    };
    if (items.length === 0) {
      setHint(
        `No issues or pull requests matched. Try /issues, /pr, or narrow with repo/user/org filters.`,
        { muted: true },
      );
    } else {
      setHint('');
    }
    renderResults();
  } catch (err) {
    items = [];
    activeIndex = -1;
    renderResults();
    setHint(err?.message || 'Search failed');
  } finally {
    endLoading();
    updateRefreshHint();
  }
}

function scheduleSearch() {
  clearTimeout(debounceTimer);
  const t = searchInput.value.trimStart();
  const trimmed = searchInput.value.trim();
  if (!previewPlainSearchFromCache() && !trimmed && searchFilters.length === 0 && aiTranscript.length === 0) {
    const freshHomeCache = getFreshHomeActivityCache();
    renderHomeState(freshHomeCache?.items ?? [], {
      scannedRepos: freshHomeCache?.scannedRepos ?? 0,
      signedIn: currentAuthState.loggedIn,
    });
  }
  const instantIssues =
    t === '/issues' ||
    t.startsWith('/issues ') ||
    isPrCommand(trimmed) ||
    isReposCommand(trimmed) ||
    isOrgsCommand(trimmed) ||
    isThemeCommand(trimmed) ||
    isHelpCommand(trimmed) ||
    isSignOutCommand(trimmed) ||
    isApiKeysCommand(trimmed) ||
    isAiCommand(trimmed) ||
    shouldShowSlashCommands(trimmed) ||
    isRepoViewIncomplete(trimmed) ||
    Boolean(parseRepoViewCommand(trimmed));
  const delay = instantIssues ? 0 : 220;
  debounceTimer = setTimeout(() => {
    void runSearch().catch((err) => {
      console.error('[gitfinder] runSearch', err);
      setHint(err?.message ?? 'Something went wrong');
      setLoading(false);
    });
  }, delay);
}

function setFilterQualifierMenuOpen(open) {
  if (!btnFilterQualifier || !filterQualifierMenuEl) return;
  btnFilterQualifier.setAttribute('aria-expanded', open ? 'true' : 'false');
  filterQualifierMenuEl.classList.toggle('hidden', !open);
  filterQualifierMenuEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  updateWindowHeight();
}

function isFilterQualifierMenuOpen() {
  return Boolean(filterQualifierMenuEl && !filterQualifierMenuEl.classList.contains('hidden'));
}

function getFilterQualifierMenuItems() {
  return filterQualifierMenuEl
    ? Array.from(filterQualifierMenuEl.querySelectorAll('.filter-qualifier-menu-item'))
    : [];
}

function focusFilterQualifierButton() {
  btnFilterQualifier?.focus();
}

function focusFilterQualifierMenuItem(index) {
  const items = getFilterQualifierMenuItems();
  if (!items.length) return false;
  const nextIndex = Math.max(0, Math.min(index, items.length - 1));
  items[nextIndex]?.focus();
  return true;
}

function openFilterQualifierMenu({ focusIndex = 0 } = {}) {
  if (!btnFilterQualifier || !filterQualifierMenuEl) return;
  setFilterQualifierMenuOpen(true);
  requestAnimationFrame(() => {
    focusFilterQualifierMenuItem(focusIndex);
  });
}

function closeFilterQualifierMenu({ restoreFocus = false } = {}) {
  if (!btnFilterQualifier || !filterQualifierMenuEl) return;
  setFilterQualifierMenuOpen(false);
  if (restoreFocus) {
    requestAnimationFrame(() => {
      focusFilterQualifierButton();
    });
  }
}

function insertSearchQualifier(prefix) {
  const input = searchInput;
  const raw = input.value;
  const start = input.selectionStart ?? raw.length;
  const end = input.selectionEnd ?? raw.length;
  const before = raw.slice(0, start);
  const after = raw.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const insert = (needsLeadingSpace ? ' ' : '') + prefix;
  input.value = before + insert + after;
  const pos = start + insert.length;
  input.setSelectionRange(pos, pos);
  focusSearchInput({ preserveSelection: true });
  scheduleSearch();
}

const filterQualifierWrapEl = btnFilterQualifier?.closest('.filter-qualifier-wrap');

apiKeyDialogPanelEl?.addEventListener('submit', (e) => {
  e.preventDefault();
  closeApiKeyDialog({ value: apiKeyDialogInputEl?.value ?? '' });
});

apiKeyDialogCancelEl?.addEventListener('click', () => {
  closeApiKeyDialog();
});

apiKeyDialogBackdropEl?.addEventListener('click', () => {
  closeApiKeyDialog();
});

btnFilterQualifier?.addEventListener('click', () => {
  if (isFilterQualifierMenuOpen()) {
    closeFilterQualifierMenu();
    return;
  }
  openFilterQualifierMenu();
});

btnFilterQualifier?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    openFilterQualifierMenu({ focusIndex: 0 });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const items = getFilterQualifierMenuItems();
    openFilterQualifierMenu({ focusIndex: Math.max(0, items.length - 1) });
  } else if (e.key === 'Escape' && isFilterQualifierMenuOpen()) {
    e.preventDefault();
    closeFilterQualifierMenu({ restoreFocus: true });
  }
});

filterQualifierMenuEl?.addEventListener('click', (e) => {
  const item = e.target.closest?.('[data-qualifier]');
  if (!item || !filterQualifierMenuEl.contains(item)) return;
  const q = item.getAttribute('data-qualifier');
  if (q) insertSearchQualifier(q);
  closeFilterQualifierMenu();
});

filterQualifierMenuEl?.addEventListener('keydown', (e) => {
  const items = getFilterQualifierMenuItems();
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    focusFilterQualifierMenuItem(nextIndex);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const nextIndex =
      currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    focusFilterQualifierMenuItem(nextIndex);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusFilterQualifierMenuItem(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusFilterQualifierMenuItem(items.length - 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFilterQualifierMenu({ restoreFocus: true });
  }
});

document.addEventListener('click', (e) => {
  if (filterQualifierWrapEl?.contains(e.target)) return;
  closeFilterQualifierMenu();
});

filterQualifierWrapEl?.addEventListener('focusout', (e) => {
  const next = e.relatedTarget;
  if (next instanceof Node && filterQualifierWrapEl.contains(next)) return;
  closeFilterQualifierMenu();
});

document.addEventListener('click', (e) => {
  if (authMenuWrapEl?.contains(e.target)) return;
  closeAuthMenu();
});

authMenuWrapEl?.addEventListener('focusout', (e) => {
  const next = e.relatedTarget;
  if (next instanceof Node && authMenuWrapEl.contains(next)) return;
  closeAuthMenu();
});

function updateAuthUi(status) {
  currentAuthState = {
    loggedIn: Boolean(status?.loggedIn),
    login: status?.login ?? null,
    avatarUrl: status?.avatarUrl ?? null,
  };
  updateAuthMenu();
  if (status?.loggedIn) {
    btnAuth.title = status.login ? `GitHub account menu (${status.login})` : 'GitHub account menu';
    btnAuth.setAttribute('aria-label', btnAuth.title);
    if (status.avatarUrl) {
      userAvatarEl.src = status.avatarUrl;
      userAvatarEl.alt = status.login ? `${status.login} on GitHub` : 'GitHub profile';
      userAvatarEl.classList.remove('hidden');
    } else {
      userAvatarEl.removeAttribute('src');
      userAvatarEl.classList.add('hidden');
      userAvatarEl.alt = '';
    }
    userAvatarPlaceholderEl.textContent = status.avatarUrl
      ? ''
      : (status.login || '?').slice(0, 1).toUpperCase();
  } else {
    userAvatarEl.removeAttribute('src');
    userAvatarEl.classList.add('hidden');
    userAvatarEl.alt = '';
    userAvatarPlaceholderEl.textContent = '?';
    btnAuth.title = 'GitHub account menu';
    btnAuth.setAttribute('aria-label', 'GitHub account menu');
  }
  if (items.length > 0) {
    renderResults();
  }
}

btnAuth.addEventListener('click', () => {
  if (isAuthMenuOpen()) {
    closeAuthMenu();
    return;
  }
  openAuthMenu();
});

btnAuth.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    openAuthMenu();
  } else if (e.key === 'Escape' && isAuthMenuOpen()) {
    e.preventDefault();
    closeAuthMenu({ restoreFocus: true });
  }
});

authMenuActionEl?.addEventListener('click', async () => {
  setHint('');
  closeAuthMenu();
  try {
    if (currentAuthState.loggedIn) {
      await api().logout();
      setHint('Signed out of GitHub', { muted: true });
    } else {
      await api().login();
    }
  } catch (e) {
    setHint(e?.message || 'Authentication failed');
  }
});

authMenuActionEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAuthMenu({ restoreFocus: true });
  }
});

searchInput.addEventListener('input', scheduleSearch);

function handleEscapeKey() {
  if (isApiKeyDialogOpen()) {
    closeApiKeyDialog();
  } else if (isAuthMenuOpen()) {
    closeAuthMenu({ restoreFocus: true });
  } else if (isFilterQualifierMenuOpen()) {
    closeFilterQualifierMenu({ restoreFocus: true });
  } else if (repoBrowseState?.step === 'list') {
    // Activity/CI preview → back to destination menu.
    backToRepoBrowseMenu();
  } else if (repoBrowseState?.step === 'menu') {
    // Menu → back to `/repos` list.
    exitRepoBrowse();
  } else {
    if (isThemeCommand(searchInput.value.trim())) {
      restoreCommittedTheme();
    }
    void api().hide();
  }
}

document.addEventListener('keydown', (e) => {
  if (appEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    handleEscapeKey();
    return;
  }
  const focusedActionButton = getFocusedResultActionButton();
  if (
    focusedActionButton &&
    items.length > 0 &&
    (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K' || e.key === 'ArrowDown' || e.key === 'ArrowUp')
  ) {
    e.preventDefault();
    moveActiveResult(
      e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown' ? 1 : -1,
      { preserveActionFocus: true },
    );
    return;
  }
  if (isApiKeyDialogOpen()) return;
  if (
    e.key === '/' &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    document.activeElement !== searchInput
  ) {
    e.preventDefault();
    closeFilterQualifierMenu();
    insertTextIntoSearchInput('/');
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || (e.key !== 'r' && e.key !== 'R')) return;
  const line = searchInput.value.trim();
  if (
    !parseRepoViewCommand(line) &&
    !isReposCommand(line) &&
    !(isAiCommand(line) && aiUserQuestion(line)) &&
    !buildSearchQuery().trim() &&
    !(line === '' && searchFilters.length === 0 && aiTranscript.length === 0 && currentAuthState.loggedIn)
  )
    return;
  e.preventDefault();
  refreshSearch();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActiveResult(1);
  } else if (e.key === 'ArrowUp') {
    const trimmed = searchInput.value.trim();
    if (lastAiInputLine && trimmed === '') {
      e.preventDefault();
      suppressNextAiRun = true;
      searchInput.value = lastAiInputLine;
      const len = lastAiInputLine.length;
      searchInput.setSelectionRange(len, len);
      scheduleSearch();
      return;
    }
    e.preventDefault();
    moveActiveResult(-1);
  } else if (
    items.length > 0 &&
    (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K')
  ) {
    e.preventDefault();
    moveActiveResult(e.key === 'j' || e.key === 'J' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (tryCommitSearchFilter()) return;
    void (async () => {
      if (await submitAiChatFromEnter()) return;
      await openSelected();
    })();
  }
});

function scrollActiveIntoView() {
  const el = resultsEl.querySelector(`li[data-index="${activeIndex}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

function bootstrap() {
  initStoredTheme();

  if (!window.gitfinder) {
    hintEl.textContent =
      'Internal error: preload failed. Quit and reinstall, or run from the repo with bun run start.';
    appEl.classList.remove('hidden');
    return;
  }

  try {
    /* Show immediately: the window is transparent; #app was display:none until authStatus
     * resolved, so the palette was completely invisible if IPC was slow or never settled. */
    appEl.classList.remove('hidden');

    window.gitfinder.onAuthChanged((state) => {
      homeActivityCache = null;
      updateAuthUi(state);
      scheduleSearch();
    });

    window.gitfinder.onFocusSearch(() => {
      focusSearchInput({ select: true });
      updateWindowHeight();
    });

    window.gitfinder
      .authStatus()
      .then((status) => {
        updateAuthUi(status);
        renderFilterPills();
        updateRefreshHint();
        focusSearchInput();
        scheduleSearch();
        updateWindowHeight();
      })
      .catch(() => {
        hintEl.textContent = 'Could not load GitFinder bridge.';
      });
  } catch (e) {
    console.error('[gitfinder] bootstrap', e);
    hintEl.textContent = e?.message ?? 'GitFinder UI failed to start.';
    appEl.classList.remove('hidden');
  }
}

bootstrap();
