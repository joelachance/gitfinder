import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** @type {string} */
let storePath = '';

/** Values observed at startup (after `.env` / shell), used to restore when clearing app keys or resuming env. */
let startupSnapshot = { openai: '', anthropic: '' };

function snapshotStartupEnv() {
  startupSnapshot = {
    openai: process.env[ENV.openai] || '',
    anthropic: process.env[ENV.anthropic] || '',
  };
}

/**
 * @typedef {{ openai?: string; anthropic?: string; openaiSuppressEnv?: boolean; anthropicSuppressEnv?: boolean }} LlmStore
 */

/** @returns {LlmStore} */
function readStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return {};
    return data;
  } catch {
    return {};
  }
}

/** @param {LlmStore} data */
function writeStore(data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data), 'utf8');
}

function reapplyLlmKeysFromStore() {
  const s = readStore();
  for (const p of /** @type {const} */ (['openai', 'anthropic'])) {
    const name = ENV[p];
    if (typeof s[p] === 'string' && s[p].length > 0) {
      process.env[name] = s[p];
    } else if (s[`${p}SuppressEnv`]) {
      delete process.env[name];
    } else if (startupSnapshot[p]) {
      process.env[name] = startupSnapshot[p];
    } else {
      delete process.env[name];
    }
  }
}

export function initLlmKeys() {
  storePath = path.join(app.getPath('userData'), 'llm-keys.json');
  snapshotStartupEnv();
  reapplyLlmKeysFromStore();
}

function mask(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (v.length <= 8) return '********';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/**
 * @param {'openai' | 'anthropic'} provider
 */
function effectiveFor(provider) {
  const name = ENV[provider];
  const s = readStore();
  if (typeof s[provider] === 'string' && s[provider].length > 0) {
    return { raw: s[provider], source: /** @type {const} */ ('app') };
  }
  if (s[`${provider}SuppressEnv`]) {
    return { raw: '', source: /** @type {const} */ ('none') };
  }
  const env = process.env[name] || '';
  if (env) return { raw: env, source: /** @type {const} */ ('env') };
  return { raw: '', source: /** @type {const} */ ('none') };
}

export function llmKeysStatus() {
  const s = readStore();
  const openai = effectiveFor('openai');
  const anthropic = effectiveFor('anthropic');
  return {
    openai: {
      configured: Boolean(openai.raw),
      source: openai.source,
      preview: mask(openai.raw),
      startupEnvAvailable: Boolean(startupSnapshot.openai),
      suppressEnv: Boolean(s.openaiSuppressEnv),
    },
    anthropic: {
      configured: Boolean(anthropic.raw),
      source: anthropic.source,
      preview: mask(anthropic.raw),
      startupEnvAvailable: Boolean(startupSnapshot.anthropic),
      suppressEnv: Boolean(s.anthropicSuppressEnv),
    },
  };
}

/**
 * @param {'openai' | 'anthropic'} provider
 * @param {string} value
 */
export function setLlmKey(provider, value) {
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('Unknown provider');
  }
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new Error('Key cannot be empty');
  const s = readStore();
  s[provider] = v;
  s[`${provider}SuppressEnv`] = false;
  writeStore(s);
  reapplyLlmKeysFromStore();
}

/**
 * @param {'openai' | 'anthropic'} provider
 */
export function clearLlmAppKey(provider) {
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('Unknown provider');
  }
  const s = readStore();
  delete s[provider];
  writeStore(s);
  reapplyLlmKeysFromStore();
}

/**
 * @param {'openai' | 'anthropic'} provider
 */
export function unsetLlmEnvKey(provider) {
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('Unknown provider');
  }
  const s = readStore();
  s[`${provider}SuppressEnv`] = true;
  delete s[provider];
  writeStore(s);
  reapplyLlmKeysFromStore();
}

/**
 * @param {'openai' | 'anthropic'} provider
 */
export function resumeLlmEnv(provider) {
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error('Unknown provider');
  }
  const s = readStore();
  delete s[`${provider}SuppressEnv`];
  writeStore(s);
  reapplyLlmKeysFromStore();
}
