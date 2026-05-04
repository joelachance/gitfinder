import createLucideSvg from '../../node_modules/lucide/dist/esm/createElement.mjs';
import CircleCheck from '../../node_modules/lucide/dist/esm/icons/circle-check.mjs';
import CircleDot from '../../node_modules/lucide/dist/esm/icons/circle-dot.mjs';
import GitMerge from '../../node_modules/lucide/dist/esm/icons/git-merge.mjs';
import GitPullRequest from '../../node_modules/lucide/dist/esm/icons/git-pull-request.mjs';
import GitPullRequestClosed from '../../node_modules/lucide/dist/esm/icons/git-pull-request-closed.mjs';
import GitPullRequestDraft from '../../node_modules/lucide/dist/esm/icons/git-pull-request-draft.mjs';

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
  if (isIssuesCommand(inputLine)) {
    issuesListCache = null;
  } else if (isPrCommand(inputLine)) {
    prsListCache = null;
  }
  void runSearch();
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

function lucideIcon(iconNode, statusClass) {
  const svg = createLucideSvg(iconNode, {
    width: 16,
    height: 16,
    'stroke-width': 2,
    'aria-hidden': 'true',
  });
  const wrap = document.createElement('span');
  wrap.className = `result-icon ${statusClass}`;
  wrap.appendChild(svg);
  return wrap;
}

/**
 * GitHub-style status: issues + PRs (open/closed/draft/merged).
 * @param {Record<string, unknown>} item
 */
function statusIconForSearchItem(item) {
  const pr = item.pull_request;
  const mergedAt = pr?.merged_at ?? item.merged_at;
  if (pr && mergedAt) {
    return { el: lucideIcon(GitMerge, 'result-icon--pr-merged'), label: 'Merged pull request' };
  }
  if (pr) {
    if (item.state === 'open' && item.draft) {
      return {
        el: lucideIcon(GitPullRequestDraft, 'result-icon--pr-draft'),
        label: 'Draft pull request',
      };
    }
    if (item.state === 'open') {
      return {
        el: lucideIcon(GitPullRequest, 'result-icon--pr-open'),
        label: 'Open pull request',
      };
    }
    return {
      el: lucideIcon(GitPullRequestClosed, 'result-icon--pr-closed'),
      label: 'Closed pull request',
    };
  }
  if (item.state === 'open') {
    return { el: lucideIcon(CircleDot, 'result-icon--issue-open'), label: 'Open issue' };
  }
  return { el: lucideIcon(CircleCheck, 'result-icon--issue-closed'), label: 'Closed issue' };
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

function isIssuesCommand(trimmed) {
  return trimmed === '/issues' || trimmed.startsWith('/issues ');
}

/** `/pr` and `/prs` (any case); `/prs` checked before `/pr` for filter text. */
function isPrCommand(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower === '/prs' || lower.startsWith('/prs ')) return true;
  if (lower === '/pr' || lower.startsWith('/pr ')) return true;
  return false;
}

function prCommandFilterText(trimmed) {
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('/prs ')) return trimmed.slice(5).trim();
  if (lower === '/prs') return '';
  if (lower.startsWith('/pr ')) return trimmed.slice(4).trim();
  if (lower === '/pr') return '';
  return '';
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
  resultsEl.innerHTML = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    if (i === activeIndex) li.classList.add('active');

    const row = document.createElement('div');
    row.className = 'result-row';

    const { el: iconWrap, label: statusLabel } = statusIconForSearchItem(item);

    const main = document.createElement('div');
    main.className = 'result-main';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const kind = item.pull_request ? 'PR' : 'Issue';
    meta.textContent = `${kind} · ${item.repository.full_name} #${item.number}`;

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

async function openSelected() {
  const row = items[activeIndex];
  if (!row?.html_url) return;
  await api().openExternal(row.html_url);
}

async function runSearch() {
  const seq = ++loadSeq;
  const endLoading = () => {
    if (seq === loadSeq) setLoading(false);
  };

  const inputLine = searchInput.value.trim();
  const q = buildSearchQuery();
  if (!q) {
    issuesListCache = null;
    prsListCache = null;
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
    const combinedFilter = buildPrLocalFilterText(inputLine);
    setHint('');
    const needFetch = !prsListCache;
    setLoading(needFetch);
    try {
      if (!prsListCache) {
        const data = await api().listAccessibleIssues({
          state: 'all',
          pullRequestsOnly: true,
        });
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
    const combinedFilter = buildIssuesLocalFilterText(inputLine);
    setHint('');
    const needFetch = !issuesListCache;
    setLoading(needFetch);
    try {
      if (!issuesListCache) {
        const data = await api().listAccessibleIssues();
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

  issuesListCache = null;
  prsListCache = null;
  setHint('');
  setLoading(true);
  try {
    const data = await api().searchIssues(buildSearchQuery());
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
  const instantIssues =
    t === '/issues' ||
    t.startsWith('/issues ') ||
    isPrCommand(t);
  const delay = instantIssues ? 0 : 220;
  debounceTimer = setTimeout(runSearch, delay);
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
  if (!buildSearchQuery().trim()) return;
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
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (tryCommitSearchFilter()) return;
    void openSelected();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (filterQualifierMenuEl && !filterQualifierMenuEl.classList.contains('hidden')) {
      setFilterQualifierMenuOpen(false);
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
  if (!window.gitcp) {
    hintEl.textContent =
      'Internal error: preload failed. Quit and reinstall, or run from the repo with bun run start.';
    appEl.classList.remove('hidden');
    return;
  }

  window.gitcp.onAuthChanged((state) => updateAuthUi(state));

  window.gitcp.onFocusSearch(() => {
    searchInput.focus();
    searchInput.select();
    updateWindowHeight();
  });

  window.gitcp
    .authStatus()
    .then((status) => {
      updateAuthUi(status);
      appEl.classList.remove('hidden');
      renderFilterPills();
      updateRefreshHint();
      searchInput.focus();
      updateWindowHeight();
    })
    .catch(() => {
      appEl.classList.remove('hidden');
      hintEl.textContent = 'Could not load GitCP bridge.';
    });
}

bootstrap();
