import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDbSignupStore } from './db/store.js';
import type { EmailSignupStore } from './db/store.js';
import {
  getClientIp,
  getIngestApiKeys,
  getLogHashSecret,
  hashLogValue,
  isAuthorizedRequest,
  resolveServiceVersion,
  trimUserAgent,
} from './security.js';
import { parseIngestPayload } from './validation.js';

const MAX_BODY_BYTES = 4 * 1024;
const SERVICE_NAME = 'collect-emails';
const encoder = new TextEncoder();

type LoggerPayload = Record<string, string | number | null>;

type AppOptions = {
  version?: string;
  getStore?: () => EmailSignupStore;
  getApiKeys?: () => readonly string[];
  getLogHashSecret?: () => string;
  logger?: (event: string, payload: LoggerPayload) => void;
};

function empty(status: number) {
  return new Response(null, { status });
}

function infoJson(version: string) {
  return { service: SERVICE_NAME, version };
}

function byteLength(input: string) {
  return encoder.encode(input).byteLength;
}

function defaultLogger(event: string, payload: LoggerPayload) {
  console.info(JSON.stringify({ event, ...payload }));
}

function ingestPathHandler(
  getStore: () => EmailSignupStore,
  getApiKeys: () => readonly string[],
  getHashSecret: () => string,
  logger: (event: string, payload: LoggerPayload) => void,
) {
  return async (c: Context) => {
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      return empty(415);
    }

    let apiKeys: readonly string[];
    let hashSecret: string;
    try {
      apiKeys = getApiKeys();
      hashSecret = getHashSecret();
    } catch {
      return empty(500);
    }

    const ip = getClientIp(c.req.raw.headers);
    const ipHash = ip ? hashLogValue(ip, hashSecret) : null;

    if (!isAuthorizedRequest(c.req.raw.headers, apiKeys)) {
      logger('ingest.unauthorized', { ipHash });
      return empty(401);
    }

    const declaredLength = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      logger('ingest.too_large', { ipHash });
      return empty(413);
    }

    let raw = '';
    try {
      raw = await c.req.text();
    } catch {
      logger('ingest.invalid_json', { ipHash });
      return empty(400);
    }

    if (byteLength(raw) > MAX_BODY_BYTES) {
      logger('ingest.too_large', { ipHash });
      return empty(413);
    }

    const payload = parseIngestPayload(raw);
    if (!payload.ok) {
      logger('ingest.invalid_payload', { ipHash });
      return empty(400);
    }

    const emailHash = hashLogValue(payload.value.email, hashSecret);

    try {
      await getStore().upsertSignup({
        email: payload.value.email,
        name: payload.value.name,
        source: payload.value.source,
        gxVersion: payload.value.gxVersion,
        lastIpHash: ipHash,
        lastUserAgent: trimUserAgent(c.req.header('user-agent')),
      });
    } catch {
      logger('ingest.store_failed', {
        emailHash,
        ipHash,
        source: payload.value.source,
      });
      return empty(500);
    }

    logger('ingest.accepted', {
      emailHash,
      ipHash,
      source: payload.value.source,
      gxVersion: payload.value.gxVersion,
    });
    return empty(204);
  };
}

export function createApp(options: AppOptions = {}) {
  const version = options.version ?? resolveServiceVersion();
  const getStore = options.getStore ?? createDbSignupStore;
  const getApiKeys = options.getApiKeys ?? getIngestApiKeys;
  const getHashSecret = options.getLogHashSecret ?? getLogHashSecret;
  const logger = options.logger ?? defaultLogger;

  const app = new Hono();
  const info = infoJson(version);
  const handleIngest = ingestPathHandler(getStore, getApiKeys, getHashSecret, logger);

  app.get('/', (c) => c.json(info));
  app.get('/api', (c) => c.json(info));
  app.get('/healthz', (c) => c.json(info));
  app.get('/api/healthz', (c) => c.json(info));

  app.post('/v1/ingest', handleIngest);
  app.post('/api/v1/ingest', handleIngest);

  return app;
}

const app = createApp();

export default app;
