import http from 'node:http';
import { URL } from 'node:url';
import { shell } from 'electron';
import { createPkcePair, randomState } from './pkce.js';
import { clearToken, loadToken, saveToken } from './token-store.js';

const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_USER = 'https://api.github.com/user';

/** GitHub OAuth apps require an exact redirect URI; use a fixed port users register as http://127.0.0.1:<port>/callback */
const LOOPBACK_PORT = (() => {
  const n = parseInt(process.env.GITCP_OAUTH_PORT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 53_682;
})();

function getEnv() {
  const clientId = process.env.GITCP_GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITCP_GITHUB_CLIENT_SECRET?.trim();
  return { clientId, clientSecret };
}

export function getOAuthAppConnectionsUrl() {
  const { clientId } = getEnv();
  if (!clientId) return null;
  return `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`;
}

function fetchJson(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gitcp/0.1.0',
      ...opts.headers,
    },
  }).then(async (r) => {
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!r.ok) {
      const msg = data.message || data.error_description || data.error || r.statusText;
      throw new Error(msg || `HTTP ${r.status}`);
    }
    return data;
  });
}

function startLoopbackServer(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not bind loopback server'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

async function exchangeCode({ code, verifier, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const tokenData = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || 'No access token in response');
  }

  const user = await fetchJson(API_USER, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  const row = {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type || 'bearer',
    scope: tokenData.scope || '',
    login: user.login || null,
    avatar_url: user.avatar_url ?? null,
  };
  saveToken(row);
  return row;
}

export async function loginWithOAuth() {
  const { clientId, clientSecret } = getEnv();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set GITCP_GITHUB_CLIENT_ID and GITCP_GITHUB_CLIENT_SECRET (GitHub OAuth App credentials).',
    );
  }

  const previous = loadToken();

  clearToken();

  const { verifier, challenge } = createPkcePair();
  const state = randomState();

  const redirectUri = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

  const { server, port } = await startLoopbackServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (requestUrl.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const returned = requestUrl.searchParams.get('state');
    const errParam = requestUrl.searchParams.get('error');
    const htmlOk =
      '<body style="font-family:sans-serif;padding:24px"><p>You can close this tab and return to GitCP.</p></body>';
    const sendHtml = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    if (errParam) {
      sendHtml(
        200,
        `<body style="font-family:sans-serif;padding:24px"><p>Authorization failed: ${errParam}</p></body>`,
      );
      server.close();
      return;
    }

    if (!code || returned !== state) {
      sendHtml(200, '<body style="font-family:sans-serif;padding:24px"><p>Invalid callback.</p></body>');
      server.close();
      return;
    }

    try {
      await exchangeCode({
        code,
        verifier,
        clientId,
        clientSecret,
        redirectUri,
      });
      sendHtml(200, htmlOk);
    } catch {
      sendHtml(
        200,
        '<body style="font-family:sans-serif;padding:24px"><p>Could not complete sign-in.</p></body>',
      );
    }
    server.close();
  }, LOOPBACK_PORT);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo read:org',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  });

  await shell.openExternal(`${AUTH_URL}?${params.toString()}`);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 120_000;
    const poll = setInterval(() => {
      const stored = loadToken();
      if (stored?.access_token) {
        clearInterval(poll);
        resolve(stored);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        if (previous?.access_token) {
          saveToken(previous);
        }
        reject(new Error('Login timed out'));
      }
    }, 200);
  });
}

export function getAuthState() {
  const t = loadToken();
  if (!t?.access_token) {
    return { loggedIn: false, login: null, avatarUrl: null };
  }
  return {
    loggedIn: true,
    login: t.login ?? null,
    avatarUrl: t.avatar_url ?? null,
  };
}

export function logout() {
  clearToken();
}

export { loadToken };
