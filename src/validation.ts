export type IngestPayload = {
  name: string;
  source: string;
  email: string;
  gxVersion: string | null;
};

type ParseResult =
  | { ok: true; value: IngestPayload }
  | { ok: false };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseIngestPayload(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!isPlainObject(data)) {
    return { ok: false };
  }

  const keys = Object.keys(data);
  const allowed = new Set(['name', 'source', 'email', 'gx_version']);
  if (keys.some((key) => !allowed.has(key))) {
    return { ok: false };
  }

  const name = normalizeString(data.name);
  const source = normalizeString(data.source);
  const email = normalizeString(data.email).toLowerCase();
  const gxVersionRaw = data.gx_version;
  const gxVersion =
    gxVersionRaw === undefined || gxVersionRaw === null ? null : normalizeString(gxVersionRaw);

  if (!name || name.length > 120) {
    return { ok: false };
  }
  if (!source) {
    return { ok: false };
  }
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    return { ok: false };
  }
  if (gxVersion !== null && (!gxVersion || gxVersion.length > 80)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      name,
      source,
      email,
      gxVersion,
    },
  };
}
