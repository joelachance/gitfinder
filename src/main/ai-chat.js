/**
 * OpenAI / Anthropic chat with GitHub API context (no local git binary).
 */
import { buildGithubContextBlock } from './github-context.js';

/**
 * @returns {{ configured: boolean, provider: string }}
 */
export function getAiStatus() {
  const c = getAiConfig();
  const configured = Boolean(
    (c.provider === 'openai' && c.openaiKey) ||
      (c.provider === 'anthropic' && c.anthropicKey),
  );
  return { configured, provider: c.provider || '' };
}

export function getAiConfig() {
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  let provider = (process.env.GITCP_AI_PROVIDER || '').trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'anthropic') {
    if (openaiKey && !anthropicKey) provider = 'openai';
    else if (anthropicKey && !openaiKey) provider = 'anthropic';
    else if (openaiKey && anthropicKey) provider = 'openai';
    else provider = '';
  }
  return {
    provider: /** @type {'openai' | 'anthropic' | ''} */ (provider),
    openaiKey,
    anthropicKey,
    openaiModel: process.env.GITCP_OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    anthropicModel:
      process.env.GITCP_ANTHROPIC_MODEL?.trim() || 'claude-3-5-haiku-20241022',
  };
}

const SYSTEM_PROMPT = `You are GitCP's assistant. You receive live summaries from the GitHub REST API: open issues/PRs, repositories the user can access, and GitHub Actions workflow runs when relevant.

**Naming a repository:** Per-repo data is loaded when **owner/repo** appears in the user’s message (e.g. \`myorg/my-repo\`). The snapshot may include a line **“Repository inferred from the user question”** — if that line is present, the user **already** named the repo; **never** tell them to “ask again with owner/repo” or imply they forgot it.

If there is **no** inferred repository line and they ask about CI for “my app” without naming a repo, explain that you need **owner/repo** in the question for that repository’s Actions data.

If **owner/repo** was inferred but Actions data is missing or shows no failures, explain **that** (API error text in context, no workflows, permissions, or no failed runs in the returned batch) — do not default to “add the repo name”.

Answer clearly and concisely. Reference repositories as owner/repo and cite issue/PR numbers when relevant. Use workflow run lines from the context (status, conclusion, branch, URL) — do not invent outcomes.`;

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {{ role: string, content: string }[]} messages
 */
async function callOpenAI(apiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error?.message || data?.message || res.statusText || 'OpenAI request failed';
    throw new Error(err);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenAI returned an empty reply.');
  }
  return text.trim();
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {{ role: string, content: string }[]} messages
 */
async function callAnthropic(apiKey, model, messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const rest = messages.filter((m) => m.role !== 'system');
  const anthropicMessages = rest.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: anthropicMessages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error?.message || data?.message || res.statusText || 'Anthropic request failed';
    throw new Error(err);
  }
  const blocks = data?.content;
  if (!Array.isArray(blocks)) {
    throw new Error('Anthropic returned an unexpected payload.');
  }
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) {
    throw new Error('Anthropic returned an empty reply.');
  }
  return text.trim();
}

/**
 * @param {string} githubToken
 * @param {string} userMessage
 */
export async function runAiChat(githubToken, userMessage) {
  const cfg = getAiConfig();
  if (!cfg.provider) {
    throw new Error(
      'Configure AI: set OPENAI_API_KEY and/or ANTHROPIC_API_KEY (.env / .env.local), paste keys in GitCP (/api-keys), or set GITCP_AI_PROVIDER when both providers have keys.',
    );
  }
  if (cfg.provider === 'openai' && !cfg.openaiKey) {
    throw new Error('OPENAI_API_KEY is missing.');
  }
  if (cfg.provider === 'anthropic' && !cfg.anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is missing.');
  }

  const contextBlock = await buildGithubContextBlock(githubToken, userMessage);
  const userPayload = `GitHub data snapshot:\n\n${contextBlock}\n\n---\n\nUser question:\n${userMessage}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPayload },
  ];

  if (cfg.provider === 'openai') {
    return callOpenAI(cfg.openaiKey, cfg.openaiModel, messages);
  }
  return callAnthropic(cfg.anthropicKey, cfg.anthropicModel, messages);
}
