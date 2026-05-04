import { resultIcon, Svg } from './icons.js';

const THEME_STORAGE_KEY = 'gitcp.theme';

const GITCP_THEMES = [
  { id: 'github', title: 'GitHub dark', subtitle: 'Blue accents (default)' },
  { id: 'arctic', title: 'Arctic glass', subtitle: 'Icy cyan on cool slate' },
  { id: 'plum', title: 'Plum HUD', subtitle: 'Electric magenta on purple gray' },
  { id: 'rose', title: 'Rose voltage', subtitle: 'Warm magenta-rose' },
  { id: 'split', title: 'Split neon', subtitle: 'Cyan + magenta highlights' },
];

const searchInput = document.getElementById('query');
const resultsEl = document.getElementById('results');
const resultsRefreshHintEl = document.getElementById('results-refresh-hint');
const hintEl = document.getElementById('hint');
const btnAuth = document.getElementById('btn-auth');
const userAvatarEl = document.getElementById('user-avatar');
const userAvatarPlaceholderEl = document.getElementById('user-avatar-placeholder');
const appEl = document.getElementById('app');
const loadSpinnerEl = document.getElementById('load-spinner');
const btnFilterQualifier = document.getElementById('btn-filter-qualifier');
const filterQualifierMenuEl = document.getElementById('filter-qualifier-menu');
const filterPillsEl = document.getElementById('filter-pills');

/** @type {{ kind: string, value: string }[]} */
let searchFilters = [];

let items = [];
let activeIndex = -1;
let debounceTimer = null;

/** Full list from GitHub when using `/issues`; reused while the query stays in that mode. */
let issuesListCache = null;

/** Full PR list when using `/pr` or `/prs` (open + closed); reused while the query stays in that mode. */
let prsListCache = null;

/** Rows from `/repos` (repos + CI summary); reused while the query stays in that mode. */
let reposListCache = null;

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

/** Only the latest `runSearch` may turn off the loading spinner (overlapping async). */
let loadSeq = 0;

function api() {
  return window.gitcp;
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
  if (isThemeCommand(trimmed) || shouldShowSlashCommands(trimmed)) {
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
    resultsRefreshHintEl.textContent = `${refreshShortcutLabel()} to refresh`;
    resultsRefreshHintEl.classList.remove('hidden');
    updateWindowHeight();
    return;
  }
  if (isReposCommand(trimmed)) {
    resultsRefreshHintEl.textContent = `${refreshShortcutLabel()} to refresh`;
    resultsRefreshHintEl.classList.remove('hidden');
    updateWindowHeight();
    return;
  }
  const q = buildSearchQuery();
  if (!q) {
    resultsRefreshHintEl.textContent = '';
    resultsRefreshHintEl.classList.add('hidden');
    updateWindowHeight();
    return;
  }
  resultsRefreshHintEl.textContent = `${refreshShortcutLabel()} to refresh results`;
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
  if (isIssuesCommand(inputLine)) {
    issuesListCache = null;
  } else if (isPrCommand(inputLine)) {
    prsListCache = null;
  } else if (isReposCommand(inputLine)) {
    reposListCache = null;
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
    dismiss.setAttribute('aria-label', `Remove ${f.kind} filter`);
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
    if (Number.isFinite(i) && searchFilters[i]) {
      searchFilters.splice(i, 1);
      renderFilterPills();
      scheduleSearch();
    }
  };

  updateWindowHeight();
}

function tryCommitSearchFilter() {
  const t = searchInput.value.trimEnd();
  const re = /(?:^|\s)((repo|user|org):(\S+))$/;
  const m = t.match(re);
  if (!m) return false;
  const kind = m[2];
  const value = m[3];
  const prefix = t.slice(0, m.index).trimEnd();
  searchFilters.push({ kind, value });
  searchInput.value = prefix;
  renderFilterPills();
  scheduleSearch();
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
    command: '/prs',
    description: 'Same as /pr',
  },
  {
    command: '/activity',
    description: 'Repository events (needs owner/repo)',
  },
  {
    command: '/branches',
    description: 'Branches (needs owner/repo)',
  },
  {
    command: '/commits',
    description: 'Recent commits (needs owner/repo)',
  },
  {
    command: '/releases',
    description: 'Releases (needs owner/repo)',
  },
  {
    command: '/repos',
    description: 'Your repositories + whether GitHub Actions / workflows are set up',
  },
  {
    command: '/repo',
    description: 'Repository summary (needs owner/repo)',
  },
  {
    command: '/tags',
    description: 'Tags (needs owner/repo)',
  },
  {
    command: '/ci',
    description: 'Actions workflow runs (needs owner/repo)',
  },
  {
    command: '/theme',
    description: 'Choose a color theme',
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

function buildReposLocalFilterText(inputLine) {
  const filterText =
    inputLine === '/repos' || !inputLine.startsWith('/repos ')
      ? ''
      : inputLine.slice('/repos '.length).trim();
  const pillTerms = searchFilters.map((f) => f.value);
  return [filterText, ...pillTerms].filter(Boolean).join(' ');
}

function isPrCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower === '/prs' || lower.startsWith('/prs ')) return true;
  if (lower === '/pr' || lower.startsWith('/pr ')) return true;
  return false;
}

function isThemeCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  return lower === '/theme' || lower.startsWith('/theme ');
}

function themePickerFilterQuery(trimmed) {
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('/theme')) return '';
  return trimmed.slice('/theme'.length).trim().toLowerCase();
}

function buildThemePickerItems(trimmed) {
  const q = themePickerFilterQuery(trimmed);
  const list = q
    ? GITCP_THEMES.filter((t) => {
        const hay = `${t.id} ${t.title} ${t.subtitle}`.toLowerCase();
        return hay.includes(q);
      })
    : GITCP_THEMES;
  return list.map((t) => ({
    __themeOption: true,
    themeId: t.id,
    command: t.title,
    description: t.subtitle,
  }));
}

function applyTheme(themeId) {
  if (!GITCP_THEMES.some((t) => t.id === themeId)) return;
  document.documentElement.setAttribute('data-theme', themeId);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* ignore */
  }
}

function initStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && GITCP_THEMES.some((t) => t.id === saved)) {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch {
    /* ignore */
  }
}

function prCommandFilterText(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('/prs ')) return trimmed.slice(5).trim();
  if (lower === '/prs') return '';
  if (lower.startsWith('/pr ')) return trimmed.slice(4).trim();
  if (lower === '/pr') return '';
  return '';
}

/**
 * @param {string} trimmed
 * @returns {{ kind: string, fullName: string, filterText: string } | null}
 */
function parseRepoViewCommand(trimmed) {
  const m = trimmed.match(
    /^\/(repo|releases|ci|tags|branches|commits|activity)\s+(\S+\/\S+)(?:\s+(.*))?$/i,
  );
  if (!m) return null;
  return {
    kind: m[1].toLowerCase(),
    fullName: m[2],
    filterText: (m[3] || '').trim(),
  };
}

/**
 * True when the user is typing `/releases` etc. but has not yet entered owner/repo.
 * @param {string} trimmed
 */
function isRepoViewIncomplete(trimmed) {
  const m = trimmed.match(/^\/(repo|releases|ci|tags|branches|commits|activity)(?:\s+(.*))?$/i);
  if (!m) return false;
  const rest = (m[2] || '').trim();
  if (!rest) return true;
  const firstTok = rest.split(/\s+/)[0];
  if (!firstTok.includes('/')) return true;
  return false;
}

function shouldShowSlashCommands(trimmed) {
  if (!trimmed.startsWith('/')) return false;
  if (isThemeCommand(trimmed)) return false;
  if (isIssuesCommand(trimmed)) return false;
  if (isReposCommand(trimmed)) return false;
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
    const hay = `${item.title} ${item.repository?.full_name ?? ''}`.toLowerCase();
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

/** Shared loader for menu choices; same IPC as slash `/ci owner/repo` (`gitcp:repo-view`). */
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
    items = result.rows;
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
    items = result.rows;
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
    const repoName = item.repository?.full_name ?? 'unknown';
    const num = item.number != null ? String(item.number) : '–';
    meta.textContent = `${kind} · ${repoName} #${num}`;

    main.appendChild(title);
    main.appendChild(meta);

    row.appendChild(iconWrap);
    row.appendChild(main);
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
  if (row?.__themeOption) {
    applyTheme(row.themeId);
    searchInput.value = '';
    scheduleSearch();
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
  if (isThemeCommand(inputLine)) {
    items = buildThemePickerItems(inputLine);
    activeIndex = items.length ? 0 : -1;
    setHint(items.length ? '' : 'No matching themes', { muted: !items.length });
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
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    items = [];
    activeIndex = -1;
    setHint('Add owner/repo after the command (e.g. octocat/Hello-World)', { muted: true });
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
    items = [];
    activeIndex = -1;
    setHint('');
    setLoading(false);
    renderResults();
    updateRefreshHint();
    return;
  }

  updateRefreshHint();

  if (isPrCommand(inputLine)) {
    reposListCache = null;
    const combinedFilter = buildPrLocalFilterText(inputLine);
    setHint('');
    items = [];
    activeIndex = -1;
    renderResults();
    const needFetch = !prsListCache;
    setLoading(needFetch);
    try {
      if (!prsListCache) {
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
    reposListCache = null;
    const combinedFilter = buildIssuesLocalFilterText(inputLine);
    setHint('');
    items = [];
    activeIndex = -1;
    renderResults();
    const needFetch = !issuesListCache;
    setLoading(needFetch);
    try {
      if (!issuesListCache) {
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
    issuesListCache = null;
    prsListCache = null;
    const combinedFilter = buildReposLocalFilterText(inputLine);
    setHint('');
    items = [];
    activeIndex = -1;
    renderResults();
    const needFetch = !reposListCache;
    setLoading(needFetch);
    try {
      if (!reposListCache) {
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

  const repoParsed = parseRepoViewCommand(inputLine);
  if (repoParsed) {
    issuesListCache = null;
    prsListCache = null;
    reposListCache = null;
    setHint('');
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
      const filtered = filterRepoViewRows(rows, repoParsed.filterText);
      items = filtered;
      activeIndex = items.length ? 0 : -1;
      const total = rows.length;
      const labels = {
        repo: 'repository',
        releases: 'release',
        ci: 'workflow run',
        tags: 'tag',
        branches: 'branch',
        commits: 'commit',
        activity: 'event',
      };
      const noun = labels[repoParsed.kind] ?? 'item';
      if (repoParsed.filterText) {
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

  issuesListCache = null;
  prsListCache = null;
  reposListCache = null;
  setHint('');
  items = [];
  activeIndex = -1;
  renderResults();
  setLoading(true);
  try {
    const data = await api().searchIssues(buildSearchQuery(), {
      forceRefresh: forceSearchRefresh,
    });
    if (seq !== loadSeq) return;
    items = data.items ?? [];
    activeIndex = items.length ? 0 : -1;
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
  const instantIssues =
    t === '/issues' ||
    t.startsWith('/issues ') ||
    isPrCommand(trimmed) ||
    isReposCommand(trimmed) ||
    isThemeCommand(trimmed) ||
    shouldShowSlashCommands(trimmed) ||
    isRepoViewIncomplete(trimmed) ||
    Boolean(parseRepoViewCommand(trimmed));
  const delay = instantIssues ? 0 : 220;
  debounceTimer = setTimeout(() => {
    void runSearch().catch((err) => {
      console.error('[gitcp] runSearch', err);
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
  input.focus();
  scheduleSearch();
}

const filterQualifierWrapEl = btnFilterQualifier?.closest('.filter-qualifier-wrap');

btnFilterQualifier?.addEventListener('click', () => {
  const shouldOpen = filterQualifierMenuEl?.classList.contains('hidden');
  setFilterQualifierMenuOpen(Boolean(shouldOpen));
});

filterQualifierMenuEl?.addEventListener('click', (e) => {
  const item = e.target.closest?.('[data-qualifier]');
  if (!item || !filterQualifierMenuEl.contains(item)) return;
  const q = item.getAttribute('data-qualifier');
  if (q) insertSearchQualifier(q);
  setFilterQualifierMenuOpen(false);
});

document.addEventListener('click', (e) => {
  if (filterQualifierWrapEl?.contains(e.target)) return;
  setFilterQualifierMenuOpen(false);
});

function updateAuthUi(status) {
  if (status?.loggedIn) {
    btnAuth.title = status.login ? `Sign out (${status.login})` : 'Sign out';
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
    btnAuth.title = 'Sign in with GitHub';
    btnAuth.setAttribute('aria-label', 'Sign in with GitHub');
  }
}

btnAuth.addEventListener('click', async () => {
  const status = await api().authStatus();
  setHint('');
  try {
    if (status.loggedIn) {
      await api().logout();
    } else {
      await api().login();
    }
  } catch (e) {
    setHint(e?.message || 'Authentication failed');
  }
});

searchInput.addEventListener('input', scheduleSearch);

document.addEventListener('keydown', (e) => {
  if (appEl.classList.contains('hidden')) return;
  if (!(e.metaKey || e.ctrlKey) || (e.key !== 'r' && e.key !== 'R')) return;
  const line = searchInput.value.trim();
  if (!parseRepoViewCommand(line) && !isReposCommand(line) && !buildSearchQuery().trim()) return;
  e.preventDefault();
  refreshSearch();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length === 0) return;
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    renderResults();
    scrollActiveIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length === 0) return;
    activeIndex = Math.max(activeIndex - 1, 0);
    renderResults();
    scrollActiveIntoView();
  } else if (
    items.length > 0 &&
    (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K')
  ) {
    e.preventDefault();
    if (e.key === 'j' || e.key === 'J') {
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else {
      activeIndex = Math.max(activeIndex - 1, 0);
    }
    renderResults();
    scrollActiveIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (tryCommitSearchFilter()) return;
    void openSelected();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (filterQualifierMenuEl && !filterQualifierMenuEl.classList.contains('hidden')) {
      setFilterQualifierMenuOpen(false);
    } else if (repoBrowseState?.step === 'list') {
      // Activity/CI preview → back to destination menu.
      backToRepoBrowseMenu();
    } else if (repoBrowseState?.step === 'menu') {
      // Menu → back to `/repos` list.
      exitRepoBrowse();
    } else {
      void api().hide();
    }
  }
});

function scrollActiveIntoView() {
  const el = resultsEl.querySelector(`li[data-index="${activeIndex}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

function bootstrap() {
  initStoredTheme();

  if (!window.gitcp) {
    hintEl.textContent =
      'Internal error: preload failed. Quit and reinstall, or run from the repo with bun run start.';
    appEl.classList.remove('hidden');
    return;
  }

  try {
    /* Show immediately: the window is transparent; #app was display:none until authStatus
     * resolved, so the palette was completely invisible if IPC was slow or never settled. */
    appEl.classList.remove('hidden');

    window.gitcp.onAuthChanged((state) => updateAuthUi(state));

    window.gitcp.onFocusSearch(() => {
      searchInput?.focus();
      searchInput?.select();
      updateWindowHeight();
    });

    window.gitcp
      .authStatus()
      .then((status) => {
        updateAuthUi(status);
        renderFilterPills();
        updateRefreshHint();
        searchInput?.focus();
        scheduleSearch();
        updateWindowHeight();
      })
      .catch(() => {
        hintEl.textContent = 'Could not load GitCP bridge.';
      });
  } catch (e) {
    console.error('[gitcp] bootstrap', e);
    hintEl.textContent = e?.message ?? 'GitCP UI failed to start.';
    appEl.classList.remove('hidden');
  }
}

bootstrap();
