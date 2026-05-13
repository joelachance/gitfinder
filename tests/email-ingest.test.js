import { describe, expect, it } from 'bun:test';
import {
  collectGithubEmailSignup,
  getEmailIngestConfig,
  selectPrimaryVerifiedEmail,
} from '../src/main/email-ingest.js';

describe('email ingest collector', () => {
  it('requires an ingest URL and API key', () => {
    expect(getEmailIngestConfig({})).toBeNull();
    expect(getEmailIngestConfig({ INGEST_API_KEY: 'key' })).toEqual({
      url: 'https://satori-collect-emails.vercel.app/v1/ingest',
      apiKey: 'key',
    });
    expect(getEmailIngestConfig({ INGEST_API_KEYS: ' key-1, key-2 ' })).toEqual({
      url: 'https://satori-collect-emails.vercel.app/v1/ingest',
      apiKey: 'key-1',
    });
    expect(
      getEmailIngestConfig({
        GITFINDER_EMAIL_INGEST_URL: 'https://example.test/v1/ingest',
        GITFINDER_EMAIL_INGEST_API_KEY: 'key',
      }),
    ).toEqual({
      url: 'https://example.test/v1/ingest',
      apiKey: 'key',
    });
  });

  it('selects the primary verified GitHub email', () => {
    expect(
      selectPrimaryVerifiedEmail([
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: ' PRIMARY@Example.COM ', primary: true, verified: true },
      ]),
    ).toBe('primary@example.com');
  });

  it('falls back to any verified email but skips unverified emails', () => {
    expect(
      selectPrimaryVerifiedEmail([
        { email: 'unverified@example.com', primary: true, verified: false },
        { email: 'verified@example.com', primary: false, verified: true },
      ]),
    ).toBe('verified@example.com');
    expect(
      selectPrimaryVerifiedEmail([{ email: 'nope@example.com', primary: true, verified: false }]),
    ).toBeNull();
  });

  it('posts a normalized signup payload to the ingest service', async () => {
    const requests = [];
    const result = await collectGithubEmailSignup({
      env: {
        GITFINDER_EMAIL_INGEST_URL: 'https://collector.test/v1/ingest',
        GITFINDER_EMAIL_INGEST_API_KEY: 'secret-key',
      },
      user: { name: ' Ada Lovelace ', login: 'ada' },
      emails: [{ email: ' ADA@Example.COM ', primary: true, verified: true }],
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    });

    expect(result).toEqual({ ok: true, email: 'ada@example.com' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://collector.test/v1/ingest');
    expect(requests[0].init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'secret-key',
    });
    expect(JSON.parse(requests[0].init.body)).toEqual({
      name: 'Ada Lovelace',
      source: 'gitfinder',
      email: 'ada@example.com',
      gx_version: '0.1.0',
    });
  });

  it('does not call ingest when config or verified email is missing', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    expect(
      await collectGithubEmailSignup({
        env: {},
        emails: [{ email: 'ada@example.com', primary: true, verified: true }],
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: 'not_configured' });

    expect(
      await collectGithubEmailSignup({
        env: {
          GITFINDER_EMAIL_INGEST_URL: 'https://collector.test/v1/ingest',
          GITFINDER_EMAIL_INGEST_API_KEY: 'secret-key',
        },
        emails: [{ email: 'ada@example.com', primary: true, verified: false }],
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: 'no_verified_email' });

    expect(calls).toBe(0);
  });
});
