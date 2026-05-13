const DEFAULT_SOURCE = 'gitfinder';
const DEFAULT_VERSION = '0.1.0';
const DEFAULT_INGEST_URL = 'https://satori-collect-emails.vercel.app/v1/ingest';

function firstListValue(value) {
  return value
    ?.split(',')
    .map((part) => part.trim())
    .find(Boolean);
}

export function getEmailIngestConfig(env = process.env) {
  const url =
    env.GITFINDER_EMAIL_INGEST_URL?.trim() ||
    env.GITCP_EMAIL_INGEST_URL?.trim() ||
    env.GITFINDER_INGEST_URL?.trim() ||
    env.GITCP_INGEST_URL?.trim() ||
    DEFAULT_INGEST_URL;
  const apiKey =
    env.GITFINDER_EMAIL_INGEST_API_KEY?.trim() ||
    env.GITCP_EMAIL_INGEST_API_KEY?.trim() ||
    env.GITFINDER_INGEST_API_KEY?.trim() ||
    env.GITCP_INGEST_API_KEY?.trim() ||
    env.INGEST_API_KEY?.trim() ||
    firstListValue(env.INGEST_API_KEYS);

  if (!url || !apiKey) return null;
  return { url, apiKey };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeName(user, fallbackEmail) {
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  if (name) return name;

  const login = typeof user?.login === 'string' ? user.login.trim() : '';
  if (login) return login;

  return fallbackEmail;
}

export function selectPrimaryVerifiedEmail(emails) {
  if (!Array.isArray(emails)) return null;

  const primary = emails.find((entry) => {
    return entry?.primary === true && entry?.verified === true && normalizeEmail(entry.email);
  });
  if (primary) return normalizeEmail(primary.email);

  const verified = emails.find((entry) => {
    return entry?.verified === true && normalizeEmail(entry.email);
  });
  return verified ? normalizeEmail(verified.email) : null;
}

export async function collectGithubEmailSignup({
  user,
  emails,
  env = process.env,
  fetchImpl = fetch,
  logger = console.warn,
} = {}) {
  const config = getEmailIngestConfig(env);
  if (!config) {
    return { ok: false, reason: 'not_configured' };
  }

  const email = selectPrimaryVerifiedEmail(emails);
  if (!email) {
    return { ok: false, reason: 'no_verified_email' };
  }

  const res = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify({
      name: normalizeName(user, email),
      source: DEFAULT_SOURCE,
      email,
      gx_version: env.npm_package_version || DEFAULT_VERSION,
    }),
  });

  if (!res.ok) {
    logger?.(`GitFinder email ingest failed with HTTP ${res.status}`);
    return { ok: false, reason: 'request_failed', status: res.status };
  }

  return { ok: true, email };
}
