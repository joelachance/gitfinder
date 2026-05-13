/**
 * GitHub REST: repository-scoped lists and summary (releases, Actions, tags, branches, commits, events).
 * @see https://docs.github.com/en/rest
 */

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
 * @param {string} url
 * @param {string} token
 */
async function ghGet(url, token) {
  const res = await fetch(url, { headers: authHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const ghMsg = data.message || data.error || res.statusText || 'Request failed';
    let hint = '';
    if (res.status === 404) {
      hint = ' — Check owner/repo spelling and that the repository exists.';
    } else if (res.status === 403) {
      hint = ' — You may lack access; confirm the repo and your token permissions.';
    }
    throw new Error(`${ghMsg} (HTTP ${res.status})${hint}`);
  }
  return data;
}

/**
 * @param {string | null | undefined} linkHeader
 * @returns {string | null}
 */
export function nextUrlFromLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const m = p.trim().match(/^<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * HEAD-equivalent check: Actions runs endpoint returns 200 with JSON body.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 */
async function actionsRunsEndpointOk(token, owner, repo) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=1`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.workflow_runs);
}

/**
 * Scan repos the user can access, then common OSS repos, until one responds to GET …/actions/runs.
 * @param {string} token
 * @param {{ excludeFullName?: string; maxUserRepos?: number }} [options]
 * @returns {Promise<{ full_name: string } | null>}
 */
export async function findAccessibleRepoWithActions(token, options = {}) {
  const exclude = (options.excludeFullName || '').toLowerCase();
  const maxUserRepos = options.maxUserRepos ?? 40;
  let checked = 0;

  let url =
    'https://api.github.com/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator,organization_member';

  while (url && checked < maxUserRepos) {
    const res = await fetch(url, { headers: authHeaders(token) });
    const data = await res.json().catch(() => []);
    if (!res.ok || !Array.isArray(data)) break;

    for (const repo of data) {
      if (checked >= maxUserRepos) break;
      checked += 1;
      const fn = typeof repo.full_name === 'string' ? repo.full_name : '';
      if (!fn || fn.toLowerCase() === exclude) continue;
      const i = fn.indexOf('/');
      if (i <= 0) continue;
      const o = fn.slice(0, i);
      const r = fn.slice(i + 1);
      try {
        if (await actionsRunsEndpointOk(token, o, r)) {
          return { full_name: fn };
        }
      } catch {
        /* try next */
      }
    }
    if (checked >= maxUserRepos) break;
    url = nextUrlFromLinkHeader(res.headers.get('Link'));
  }

  const fallbacks = [
    'electron/electron',
    'microsoft/vscode',
    'vercel/next.js',
    'facebook/react',
    'rust-lang/rust',
  ];
  for (const fn of fallbacks) {
    if (fn.toLowerCase() === exclude) continue;
    const i = fn.indexOf('/');
    if (i <= 0) continue;
    try {
      if (await actionsRunsEndpointOk(token, fn.slice(0, i), fn.slice(i + 1))) {
        return { full_name: fn };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCiActionsEndpointBlocked(err) {
  const m = String(/** @type {any} */ (err)?.message ?? '');
  return /\((HTTP 403|HTTP 404)\)/.test(m);
}

/**
 * @param {string} fullName
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseOwnerRepo(fullName) {
  const s = fullName.trim();
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  const owner = s.slice(0, i);
  const repo = s.slice(i + 1);
  if (!owner || !repo || owner.includes('/') || repo.includes('/')) return null;
  return { owner, repo };
}

/**
 * @param {string | null | undefined} d
 */
function shortDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return String(d);
  }
}

/**
 * @param {string} sha
 */
function shortSha(sha) {
  if (!sha || typeof sha !== 'string') return '';
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} fullName owner/repo
 */
function eventToUrl(event, fullName) {
  const t = event.type;
  const p = /** @type {Record<string, unknown>} */ (event.payload) || {};
  switch (t) {
    case 'IssuesEvent':
      return /** @type {any} */ (p.issue)?.html_url;
    case 'IssueCommentEvent':
      return /** @type {any} */ (p.comment)?.html_url;
    case 'PullRequestEvent':
    case 'PullRequestReviewEvent':
      return (
        /** @type {any} */ (p.pull_request)?.html_url || /** @type {any} */ (p.comment)?.html_url
      );
    case 'PullRequestReviewCommentEvent':
      return /** @type {any} */ (p.comment)?.html_url || /** @type {any} */ (p.pull_request)?.html_url;
    case 'PushEvent': {
      const before = /** @type {any} */ (p).before;
      const head = /** @type {any} */ (p).head;
      if (before && head) {
        return `https://github.com/${fullName}/compare/${before}...${head}`;
      }
      return /** @type {any} */ (p).compare;
    }
    case 'ReleaseEvent':
      return /** @type {any} */ (p.release)?.html_url;
    case 'ForkEvent':
      return /** @type {any} */ (p.forkee)?.html_url;
    case 'CreateEvent': {
      const refType = /** @type {any} */ (p).ref_type;
      const ref = /** @type {any} */ (p).ref;
      if (refType === 'tag' && ref) {
        return `https://github.com/${fullName}/releases/tag/${ref}`;
      }
      if (refType === 'branch' && ref) {
        return `https://github.com/${fullName}/tree/${ref}`;
      }
      return `https://github.com/${fullName}`;
    }
    case 'DeleteEvent':
    case 'WatchEvent':
    case 'PublicEvent':
    default:
      return `https://github.com/${fullName}`;
  }
}

/**
 * @param {string} kind
 * @param {string} owner
 * @param {string} repo
 * @param {string} token
 * @returns {Promise<{ title: string, subtitle: string, html_url: string, rowKind: string }[]>}
 */
export async function fetchRepoViewItems(kind, owner, repo, token) {
  const fullName = `${owner}/${repo}`;
  const enc = (s) => encodeURIComponent(s);

  switch (kind) {
    case 'repo': {
      const r = await ghGet(`https://api.github.com/repos/${enc(owner)}/${enc(repo)}`, token);
      const desc = (r.description && String(r.description)) || 'No description';
      const bits = [
        r.stargazers_count != null ? `★ ${r.stargazers_count}` : '',
        r.language ? String(r.language) : '',
        r.open_issues_count != null ? `${r.open_issues_count} open issues` : '',
      ].filter(Boolean);
      return [
        {
          title: fullName,
          subtitle: bits.length ? `${desc} · ${bits.join(' · ')}` : desc,
          html_url: r.html_url || `https://github.com/${fullName}`,
          rowKind: 'repo',
        },
      ];
    }
    case 'releases': {
      const list = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/releases?per_page=20`,
        token,
      );
      if (!Array.isArray(list)) return [];
      return list.map((rel) => ({
        title: (rel.name && String(rel.name).trim()) || rel.tag_name || 'Release',
        subtitle: [rel.tag_name, rel.prerelease ? 'pre' : null, shortDate(rel.published_at)]
          .filter(Boolean)
          .join(' · '),
        html_url: rel.html_url,
        rowKind: 'release',
      }));
    }
    case 'ci': {
      const data = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/actions/runs?per_page=20`,
        token,
      );
      const runs = data.workflow_runs;
      if (!Array.isArray(runs)) return [];
      return runs.map((run) => ({
        title: run.name || 'Workflow run',
        subtitle: [
          run.status,
          run.conclusion,
          run.head_branch,
          shortDate(run.created_at),
        ]
          .filter(Boolean)
          .join(' · '),
        html_url: run.html_url,
        rowKind: 'ci',
        repoFullName: fullName,
        runId: run.id,
        runStatus: run.status || '',
        runConclusion: run.conclusion || '',
      }));
    }
    case 'tags': {
      const list = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/tags?per_page=20`,
        token,
      );
      if (!Array.isArray(list)) return [];
      return list.map((tag) => {
        const sha = /** @type {any} */ (tag.commit)?.sha;
        return {
          title: tag.name,
          subtitle: shortSha(sha) || 'tag',
          html_url: sha
            ? `https://github.com/${fullName}/commit/${sha}`
            : `https://github.com/${fullName}/releases/tag/${encodeURIComponent(tag.name)}`,
          rowKind: 'tag',
        };
      });
    }
    case 'branches': {
      const list = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/branches?per_page=20`,
        token,
      );
      if (!Array.isArray(list)) return [];
      return list.map((br) => {
        const sha = /** @type {any} */ (br.commit)?.sha;
        const refPath = String(br.name)
          .split('/')
          .map((p) => encodeURIComponent(p))
          .join('/');
        return {
          title: br.name,
          subtitle: shortSha(sha),
          html_url: `https://github.com/${fullName}/tree/${refPath}`,
          rowKind: 'branch',
        };
      });
    }
    case 'commits': {
      const list = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/commits?per_page=20`,
        token,
      );
      if (!Array.isArray(list)) return [];
      return list.map((c) => {
        const msg = /** @type {any} */ (c.commit)?.message;
        const first = typeof msg === 'string' ? msg.split('\n')[0].trim() : 'Commit';
        const who =
          /** @type {any} */ (c.commit)?.author?.name ||
          /** @type {any} */ (c.author)?.login ||
          '';
        return {
          title: first || 'Commit',
          subtitle: [shortSha(c.sha), who].filter(Boolean).join(' · '),
          html_url: c.html_url,
          rowKind: 'commit',
        };
      });
    }
    case 'activity': {
      const list = await ghGet(
        `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/events?per_page=20`,
        token,
      );
      if (!Array.isArray(list)) return [];
      return list.map((ev) => {
        const who = /** @type {any} */ (ev.actor)?.login || '';
        return {
          title: `${ev.type || 'Event'}${who ? ` · ${who}` : ''}`,
          subtitle: shortDate(ev.created_at),
          html_url: eventToUrl(ev, fullName) || `https://github.com/${fullName}`,
          rowKind: 'activity',
        };
      });
    }
    default:
      return [];
  }
}

const MAX_USER_REPOS_LIST = 400;

/**
 * Repositories the authenticated user can access (`owner`, `collaborator`, `organization_member`),
 * newest push first (same query as the `/repos` palette catalog).
 *
 * @param {string} token
 * @param {{ maxRepos?: number }} [opts] Omit `maxRepos` to fetch every page until GitHub returns no more results.
 */
export async function listUserReposPaginated(token, opts = {}) {
  const maxRepos =
    typeof opts.maxRepos === 'number' && Number.isFinite(opts.maxRepos) && opts.maxRepos >= 0
      ? opts.maxRepos
      : Number.MAX_SAFE_INTEGER;
  const headers = authHeaders(token);
  const all = [];
  let url =
    'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
  while (url && all.length < maxRepos) {
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => []);
    if (!res.ok || !Array.isArray(data)) break;
    for (const r of data) {
      if (all.length >= maxRepos) break;
      all.push(r);
    }
    if (all.length >= maxRepos) break;
    url = nextUrlFromLinkHeader(res.headers.get('Link'));
  }
  all.sort((a, b) => {
    const ta = a.pushed_at ? new Date(a.pushed_at).getTime() : 0;
    const tb = b.pushed_at ? new Date(b.pushed_at).getTime() : 0;
    return tb - ta;
  });
  return all;
}

/**
 * Organizations the authenticated user can access. Uses active org memberships when available so
 * role information can be shown in the palette.
 *
 * @param {string} token
 */
export async function listAccessibleOrgs(token) {
  const headers = authHeaders(token);
  const memberships = [];
  let url = 'https://api.github.com/user/memberships/orgs?state=active&per_page=100';

  while (url) {
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const ghMsg =
        (Array.isArray(data) ? null : data?.message || data?.error) ||
        res.statusText ||
        'Could not list organizations';
      throw new Error(ghMsg);
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    memberships.push(...data);
    url = nextUrlFromLinkHeader(res.headers.get('Link'));
  }

  const seen = new Set();
  const items = memberships
    .map((membership) => {
      const org = membership?.organization ?? {};
      const login = typeof org.login === 'string' ? org.login.trim() : '';
      if (!login) return null;
      const dedupeKey = login.toLowerCase();
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);

      const displayName = typeof org.name === 'string' ? org.name.trim() : '';
      const description = typeof org.description === 'string' ? org.description.trim() : '';
      const role = typeof membership.role === 'string' ? membership.role.trim() : '';
      const subtitleParts = [];
      if (displayName && displayName.toLowerCase() !== dedupeKey) {
        subtitleParts.push(displayName);
      }
      if (description) {
        subtitleParts.push(description);
      }
      if (role) {
        subtitleParts.push(`Role: ${role}`);
      }

      return {
        title: login,
        subtitle: subtitleParts.join(' · ') || 'Organization',
        html_url: org.html_url || `https://github.com/${login}`,
        rowKind: 'org',
        orgLogin: login,
      };
    })
    .filter((item) => item != null);

  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return { items };
}

/**
 * @param {string} token
 */
async function fetchAllUserRepos(token) {
  return listUserReposPaginated(token, { maxRepos: MAX_USER_REPOS_LIST });
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 */
async function summarizeRepoWorkflows(token, owner, repo) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=1`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) {
    return 'CI: unavailable (Actions disabled or no access)';
  }
  if (!res.ok) {
    return `CI: unknown (HTTP ${res.status})`;
  }
  const data = await res.json().catch(() => ({}));
  const n =
    typeof data.total_count === 'number'
      ? data.total_count
      : Array.isArray(data.workflows)
        ? data.workflows.length
        : 0;
  if (n === 0) return 'CI: no workflow files';
  return `CI: yes · ${n} workflow${n === 1 ? '' : 's'}`;
}

/**
 * @template T, R
 * @param {T[]} arr
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 */
async function mapWithConcurrency(arr, limit, fn) {
  if (arr.length === 0) return [];
  const results = /** @type {R[]} */ (new Array(arr.length));
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= arr.length) break;
      results[i] = await fn(arr[i], i);
    }
  }
  const nWorkers = Math.min(limit, arr.length);
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return results;
}

/**
 * Lists repos the token can access (paginated, capped) and checks GitHub Actions workflows per repo.
 * @param {string} token
 */
export async function listReposWithCi(token) {
  const repos = await fetchAllUserRepos(token);
  const mapped = await mapWithConcurrency(repos, 8, async (repo) => {
    const fn = typeof repo.full_name === 'string' ? repo.full_name : '';
    const idx = fn.indexOf('/');
    if (idx <= 0) return null;
    const owner = fn.slice(0, idx);
    const name = fn.slice(idx + 1);
    const subtitle = await summarizeRepoWorkflows(token, owner, name);
    return {
      title: fn,
      subtitle,
      html_url: repo.html_url || `https://github.com/${fn}`,
      rowKind: 'repos-catalog',
    };
  });
  return { items: mapped.filter((x) => x != null) };
}

/**
 * @param {string} url
 * @param {string} token
 */
async function safeGhGet(url, token) {
  const res = await fetch(url, { headers: authHeaders(token) });
  const data = await res.json().catch(() => null);
  if (!res.ok) return null;
  return data;
}

/**
 * @param {string | null | undefined} type
 * @param {string | null | undefined} action
 */
function humanizeEventTitle(type, action) {
  const base = String(type || 'Event').replace(/Event$/, '');
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (!action) return spaced;
  return `${spaced} · ${action}`;
}

const HOME_ACTIVITY_MAX_REPOS = 6;
const HOME_ACTIVITY_MAX_FAILED_RUNS = 3;
const HOME_ACTIVITY_MAX_COMMITS = 3;
const HOME_ACTIVITY_MAX_EVENTS = 4;

/**
 * Aggregated home feed from recently pushed repos the user can access.
 * Failed CI runs are surfaced first, then recent commits, then recent activity.
 *
 * @param {string} token
 */
export async function listHomeActivity(token) {
  const repos = await listUserReposPaginated(token, { maxRepos: HOME_ACTIVITY_MAX_REPOS });
  const repoBlocks = await mapWithConcurrency(repos, 4, async (repo) => {
    const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
    const idx = fullName.indexOf('/');
    if (idx <= 0) return { failed: [], commits: [], events: [] };
    const owner = fullName.slice(0, idx);
    const name = fullName.slice(idx + 1);
    const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const [runsData, commitsData, eventsData] = await Promise.all([
      safeGhGet(`${baseUrl}/actions/runs?per_page=4`, token),
      safeGhGet(`${baseUrl}/commits?per_page=1`, token),
      safeGhGet(`${baseUrl}/events?per_page=1`, token),
    ]);

    const failed = Array.isArray(runsData?.workflow_runs)
      ? runsData.workflow_runs
          .filter((run) => run?.conclusion === 'failure')
          .map((run) => ({
            sortAt: run.created_at || '',
            item: {
              title: run.name || 'Workflow run',
              subtitle: ['Failed CI', fullName, run.head_branch, shortDate(run.created_at)]
                .filter(Boolean)
                .join(' · '),
              html_url: run.html_url || `https://github.com/${fullName}/actions`,
              rowKind: 'ci',
              repoFullName: fullName,
              runId: run.id,
              runStatus: run.status || '',
              runConclusion: run.conclusion || '',
            },
          }))
      : [];

    const commits = Array.isArray(commitsData)
      ? commitsData.slice(0, 1).map((commit) => {
          const msg = /** @type {any} */ (commit.commit)?.message;
          const first = typeof msg === 'string' ? msg.split('\n')[0].trim() : 'Commit';
          const who =
            /** @type {any} */ (commit.commit)?.author?.name ||
            /** @type {any} */ (commit.author)?.login ||
            '';
          const at =
            /** @type {any} */ (commit.commit)?.author?.date ||
            /** @type {any} */ (commit.commit)?.committer?.date ||
            '';
          return {
            sortAt: at,
            item: {
              title: first || 'Commit',
              subtitle: ['Commit', fullName, who, shortDate(at)].filter(Boolean).join(' · '),
              html_url: commit.html_url || `https://github.com/${fullName}/commits`,
              rowKind: 'commit',
            },
          };
        })
      : [];

    const events = Array.isArray(eventsData)
      ? eventsData.slice(0, 1).map((event) => {
          const actor = /** @type {any} */ (event.actor)?.login || '';
          const action = /** @type {any} */ (event.payload)?.action || '';
          const at = event.created_at || '';
          return {
            sortAt: at,
            item: {
              title: [humanizeEventTitle(event.type, action), actor].filter(Boolean).join(' · '),
              subtitle: ['Activity', fullName, shortDate(at)].filter(Boolean).join(' · '),
              html_url: eventToUrl(event, fullName) || `https://github.com/${fullName}`,
              rowKind: 'activity',
            },
          };
        })
      : [];

    return { failed, commits, events };
  });

  const sortDesc = (a, b) => new Date(b.sortAt || 0).getTime() - new Date(a.sortAt || 0).getTime();
  const failed = repoBlocks
    .flatMap((block) => block.failed)
    .sort(sortDesc)
    .slice(0, HOME_ACTIVITY_MAX_FAILED_RUNS)
    .map((entry) => entry.item);
  const commits = repoBlocks
    .flatMap((block) => block.commits)
    .sort(sortDesc)
    .slice(0, HOME_ACTIVITY_MAX_COMMITS)
    .map((entry) => entry.item);
  const events = repoBlocks
    .flatMap((block) => block.events)
    .sort(sortDesc)
    .slice(0, HOME_ACTIVITY_MAX_EVENTS)
    .map((entry) => entry.item);

  return {
    items: [...failed, ...commits, ...events],
    scannedRepos: repos.length,
  };
}
