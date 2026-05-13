/**
 * Compact GitHub API snapshots for AI context (issues, repos, optional CI).
 */
import { fetchRepoViewItems, listUserReposPaginated, parseOwnerRepo } from './github-repo.js';

const USER_AGENT = 'gitfinder/0.1.0';

/**
 * @param {string} token
 * @returns {Record<string, string>}
 */
function authHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * @param {unknown} item
 */
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
 * Open issues + PRs across accessible repos (same source as palette `/issues`).
 * @param {string} token
 * @param {{ maxItems?: number }} [opts]
 */
export async function fetchOpenIssuesDigest(token, opts = {}) {
  const maxItems = opts.maxItems ?? 60;
  const headers = authHeaders(token);
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const url = new URL('https://api.github.com/issues');
    url.searchParams.set('filter', 'repos');
    url.searchParams.set('state', 'open');
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
    if (!Array.isArray(data) || data.length === 0) break;
    for (const item of data) {
      all.push(normalizeIssueListItem(item));
      if (all.length >= maxItems) break;
    }
    if (all.length >= maxItems || data.length < 100) break;
  }

  const lines = all.map((item) => {
    const repo = item.repository?.full_name ?? 'unknown';
    const num = item.number != null ? String(item.number) : '?';
    const kind = item.pull_request ? 'PR' : 'issue';
    const title = (item.title && String(item.title).slice(0, 200)) || '(no title)';
    return `[${kind}] ${repo}#${num}: ${title}`;
  });
  return lines.join('\n');
}

/**
 * Recently pushed repos (metadata only; no per-repo workflow scan).
 * Follows GitHub `Link: rel="next"` pagination so counts and names match the API (not a single page).
 *
 * @param {string} token
 * @param {{ maxRepos?: number }} [opts] Optional cap (defaults to all pages).
 */
export async function fetchRecentReposDigest(token, opts = {}) {
  const maxRepos =
    typeof opts.maxRepos === 'number' && Number.isFinite(opts.maxRepos) && opts.maxRepos >= 0
      ? opts.maxRepos
      : undefined;
  const repos = await listUserReposPaginated(
    token,
    maxRepos !== undefined ? { maxRepos } : {},
  );
  const lines = repos.map((r) => {
    const fn = typeof r.full_name === 'string' ? r.full_name : '';
    const pushed = r.pushed_at ? String(r.pushed_at).slice(0, 10) : '';
    const desc =
      r.description && typeof r.description === 'string'
        ? String(r.description).replace(/\s+/g, ' ').slice(0, 120)
        : '';
    const lang = r.language ? String(r.language) : '';
    const branch = r.default_branch ? String(r.default_branch) : '';
    const descPart = desc ? ` · ${desc}` : '';
    return `${fn}${descPart} · pushed ${pushed}${lang ? ` · ${lang}` : ''}${branch ? ` · default ${branch}` : ''}`;
  });
  const header = `Total: ${repos.length} repositories (complete list from GET /user/repos; sorted by last push, newest first)`;
  return `${header}\n\n${lines.join('\n')}`;
}

/**
 * @param {string} text
 * @returns {string | null} owner/repo
 */
export function inferOwnerRepoFromText(text) {
  /* Trailing `\b` breaks names like `org/my-repo` (word boundary between `my` and `-`).
   * Require end-of-token with lookahead instead; take last match when several owner/repo appear. */
  const re = /\b([\w.-]{1,39}\/[\w.-]{1,100})(?=\s|$|[.,;:!?'")\]}])/g;
  /** @type {string | null} */
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1];
    if (parseOwnerRepo(candidate)) last = candidate;
  }
  return last;
}

/**
 * Recent workflow runs for CI context (may 403 on some repos).
 * @param {string} token
 * @param {string} fullName owner/repo
 */
const README_MAX_CHARS = 12_000;

/**
 * Default-branch README body (GitHub picks README.md / README.rst / etc.).
 * @param {string} token
 * @param {string} fullName owner/repo
 */
export async function fetchReadmeDigest(token, fullName) {
  const pair = parseOwnerRepo(fullName);
  if (!pair) return '';
  const enc = (s) => encodeURIComponent(s);
  const url = `https://api.github.com/repos/${enc(pair.owner)}/${enc(pair.repo)}/readme`;
  const res = await fetch(url, {
    headers: {
      ...authHeaders(token),
      Accept: 'application/vnd.github.raw',
    },
  });
  if (res.status === 404) {
    return '(No README at repository root, or not accessible with your token.)';
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 160);
    return `(README request failed: HTTP ${res.status}${snippet ? ` — ${snippet}` : ''})`;
  }
  const raw = await res.text();
  const origLen = raw.length;
  let text = raw.trim();
  if (!text) {
    return '(README file is empty.)';
  }
  if (text.length > README_MAX_CHARS) {
    text = `${text.slice(0, README_MAX_CHARS)}\n\n… (truncated; full README was ${origLen} characters)`;
  }
  return text;
}

export async function fetchCiRunsDigest(token, fullName) {
  const pair = parseOwnerRepo(fullName);
  if (!pair) return '';
  try {
    const rows = await fetchRepoViewItems('ci', pair.owner, pair.repo, token);
    const slice = rows.slice(0, 15);
    const lines = slice.map((r) => `${r.title} · ${r.subtitle}`);
    const failRow = slice.find((r) => /\bfailure\b/i.test(String(r.subtitle)));
    const preamble = failRow
      ? `Most recent run with conclusion "failure" in this fetch (newest runs listed first): ${failRow.title} · ${failRow.subtitle}`
      : `No run in this batch has conclusion "failure" (only success/cancelled/skipped/null — or no runs).`;
    return `${preamble}\n\n${lines.join('\n')}`;
  } catch (e) {
    const msg = String(/** @type {any} */ (e)?.message ?? e);
    return `(CI API unavailable for ${fullName}: ${msg.slice(0, 120)})`;
  }
}

/**
 * True when the question is likely about Actions/CI without naming owner/repo (we then scan recent repos).
 * @param {string} text
 */
export function mentionsCiWorkflowIntent(text) {
  const t = text.toLowerCase();
  return (
    /\b(ci run|ci runs|failed ci|ci failed|github actions|workflow run|workflow runs|continuous integration|actions tab)\b/.test(
      t,
    ) ||
    /\b(pipeline|build failed|failing build|broken build)\b/.test(t) ||
    /\b(last|recent)\s+.{0,24}\b(failed|failure)\b/.test(t) ||
    /\b(last|recent)\s+.{0,24}\b(workflow|actions|ci)\b/.test(t)
  );
}

/**
 * Fetch recent workflow runs across the user's most recently pushed repos (GitHub has no single "all failures" API).
 * @param {string} token
 * @param {{ maxRepos?: number; perPage?: number }} [opts]
 */
export async function fetchCiRunsAcrossRecentRepos(token, opts = {}) {
  const maxRepos =
    typeof opts.maxRepos === 'number' && opts.maxRepos > 0 ? Math.min(opts.maxRepos, 40) : 15;
  const perPage =
    typeof opts.perPage === 'number' && opts.perPage > 0 ? Math.min(opts.perPage, 30) : 15;

  const repos = await listUserReposPaginated(token, { maxRepos });
  if (repos.length === 0) return '(no repositories to scan)';

  /**
   * @param {unknown} repo
   */
  async function scanRepo(repo) {
    const fn = typeof repo.full_name === 'string' ? repo.full_name : '';
    const i = fn.indexOf('/');
    if (i <= 0) return { fn: fn || '(unknown)', error: 'bad full_name', runs: [] };
    const owner = fn.slice(0, i);
    const name = fn.slice(i + 1);
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=${perPage}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (typeof data === 'object' && data !== null && data.message && String(data.message)) ||
        res.statusText ||
        `HTTP ${res.status}`;
      return { fn, error: msg.slice(0, 160), runs: [] };
    }
    const runs = data.workflow_runs;
    if (!Array.isArray(runs)) return { fn, error: null, runs: [] };
    return { fn, error: null, runs };
  }

  const concurrency = 5;
  /** @type {{ fn: string; error: string | null; runs: unknown[] }[]} */
  const blocks = [];
  for (let i = 0; i < repos.length; i += concurrency) {
    const chunk = repos.slice(i, i + concurrency);
    const part = await Promise.all(chunk.map((r) => scanRepo(r)));
    blocks.push(...part);
  }

  /** @type {{ at: string; line: string }[]} */
  const failureLines = [];
  const sections = [];

  for (const block of blocks) {
    const { fn, error, runs } = block;
    if (error) {
      sections.push(`### ${fn}\n(Could not load Actions: ${error})`);
      continue;
    }
    const lines = runs.map((run) => {
      const r = /** @type {Record<string, unknown>} */ (run);
      const name = typeof r.name === 'string' ? r.name : 'Workflow run';
      const status = typeof r.status === 'string' ? r.status : '';
      const conclusion = typeof r.conclusion === 'string' ? r.conclusion : '';
      const branch = typeof r.head_branch === 'string' ? r.head_branch : '';
      const created = typeof r.created_at === 'string' ? r.created_at : '';
      const url = typeof r.html_url === 'string' ? r.html_url : '';
      const line = `- ${name} · ${status} · conclusion ${conclusion || '—'} · ${branch} · ${created} · ${url}`;
      if (conclusion === 'failure') {
        failureLines.push({
          at: created,
          line: `**${fn}** · ${name} · failure · ${branch} · ${created} · ${url}`,
        });
      }
      return line;
    });
    sections.push(`### ${fn}\n${lines.length ? lines.join('\n') : '(no runs)'}`);
  }

  failureLines.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const summaryFail =
    failureLines.length > 0
      ? `**Most recent failed run (among scanned repos):**\n${failureLines[0].line}\n`
      : `**No runs with conclusion \`failure\`** among the latest ${perPage} workflow runs per repository in this scan (runs may still be \`in_progress\`, or Actions may be disabled / unavailable for these repos).\n`;

  return [
    `Scanned **${repos.length}** most recently pushed repositories (GET /user/repos, then GET …/actions/runs per repo).`,
    '',
    summaryFail,
    '## Per-repository workflow runs (newest API order)',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * Builds a single user-message-sized context block for the LLM.
 * @param {string} token
 * @param {string} userQuestion
 */
export async function buildGithubContextBlock(token, userQuestion) {
  const parts = [];
  const focusRepo = inferOwnerRepoFromText(userQuestion);
  const wantCiAcrossRepos = !focusRepo && mentionsCiWorkflowIntent(userQuestion);

  const [issuesText, reposText, ciAcrossReposText] = await Promise.all([
    fetchOpenIssuesDigest(token, { maxItems: 55 }),
    fetchRecentReposDigest(token),
    wantCiAcrossRepos ? fetchCiRunsAcrossRecentRepos(token) : Promise.resolve(null),
  ]);

  parts.push('## Open issues & pull requests (your accessible repos, most recently updated first)');
  parts.push(issuesText || '(none listed)');
  parts.push('');
  parts.push('## Repositories you can access (recently pushed first)');
  parts.push(reposText || '(none)');

  if (focusRepo) {
    parts.push('');
    parts.push(
      `**Repository inferred from the user question:** \`${focusRepo}\` — README and Actions below are for this repo only.`,
    );
    const [readme, ci] = await Promise.all([
      fetchReadmeDigest(token, focusRepo),
      fetchCiRunsDigest(token, focusRepo),
    ]);
    parts.push('');
    parts.push(`## README for ${focusRepo} (repository root; default branch)`);
    parts.push(readme || '(unavailable)');
    parts.push('');
    parts.push(`## GitHub Actions workflow runs for ${focusRepo} (recent)`);
    parts.push(ci || '(no runs or unavailable)');
  } else if (ciAcrossReposText) {
    parts.push('');
    parts.push('## GitHub Actions workflow runs (no owner/repo in question — scanned your recently pushed repos)');
    parts.push(ciAcrossReposText);
  }

  parts.push('');
  parts.push('## Scoping data (read this when answering the user)');
  if (focusRepo) {
    parts.push(
      [
        `The user already named **\`${focusRepo}\`** — do **not** ask them to repeat owner/repo.`,
        'If the Actions section above is empty, says unavailable, or only shows successes, explain that (permissions, Actions disabled, no workflows, or no failed runs in the fetched batch) and link to the run URL if present — do not blame “missing repository name”.',
      ].join(' '),
    );
  } else {
    parts.push(
      [
        'Some GitHub data is **per repository** and is only loaded when the user names **`owner/repo`** (e.g. `acme/payments-api`) in their question.',
        '**With `owner/repo` in the prompt:** the snapshot can include the **README** (project overview) and **Actions/CI runs** for that repository (see sections above when present).',
        '**Without `owner/repo`:** only account-wide lists appear, plus an optional CI scan across recently pushed repos.',
        'If the question clearly needs one repo but no `owner/repo` appears anywhere in the user message, suggest they ask again and include it.',
      ].join(' '),
    );
  }

  return parts.join('\n');
}
