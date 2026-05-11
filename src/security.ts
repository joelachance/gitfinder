import crypto from 'node:crypto';

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function resolveServiceVersion() {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'local';
}

export function getIngestApiKeys() {
  const raw = [process.env.INGEST_API_KEYS, process.env.INGEST_API_KEY]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const keys = Array.from(new Set(raw));
  if (keys.length === 0) {
    throw new Error('INGEST_API_KEYS or INGEST_API_KEY is required.');
  }
  return keys;
}

export function getLogHashSecret() {
  return requireEnv('LOG_HASH_SECRET');
}

export function hashLogValue(value: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function getClientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const direct = headers.get('x-real-ip') ?? headers.get('cf-connecting-ip');
  return direct?.trim() || null;
}

export function trimUserAgent(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 512) : null;
}

export function isAuthorizedRequest(headers: Headers, validKeys: readonly string[]) {
  const xApiKey = headers.get('x-api-key')?.trim();
  if (xApiKey && validKeys.includes(xApiKey)) {
    return true;
  }

  const auth = headers.get('authorization')?.trim();
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return validKeys.includes(match[1]!.trim());
}
