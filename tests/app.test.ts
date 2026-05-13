import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/app.js';
import type { EmailSignupStore, SignupUpsert } from '../src/db/store.js';

class MemoryStore implements EmailSignupStore {
  calls: SignupUpsert[] = [];

  async upsertSignup(input: SignupUpsert) {
    this.calls.push(input);
  }
}

function createTestApp(store: MemoryStore, logs: Array<Record<string, unknown>> = []) {
  return createApp({
    version: 'testsha',
    getApiKeys: () => ['key-1', 'key-2'],
    getLogHashSecret: () => 'hash-secret',
    getStore: () => store,
    logger: (event, payload) => logs.push({ event, ...payload }),
  });
}

describe('collect-emails app', () => {
  it('returns service info from root and healthz', async () => {
    const app = createTestApp(new MemoryStore());

    const root = await app.fetch(new Request('https://local/'));
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({
      service: 'collect-emails',
      version: 'testsha',
    });

    const health = await app.fetch(new Request('https://local/healthz'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: 'collect-emails',
      version: 'testsha',
    });
  });

  it('rejects non-json content types with 415', async () => {
    const store = new MemoryStore();
    const app = createTestApp(store);

    const res = await app.fetch(
      new Request('https://local/v1/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-api-key': 'key-1',
        },
        body: 'hello',
      }),
    );

    expect(res.status).toBe(415);
    expect(await res.text()).toBe('');
    expect(store.calls).toHaveLength(0);
  });

  it('rejects unauthorized requests with 401', async () => {
    const store = new MemoryStore();
    const app = createTestApp(store);

    const res = await app.fetch(
      new Request('https://local/v1/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Ada Lovelace',
          source: 'gitfinder',
          email: 'ada@example.com',
          gx_version: '1.2.3',
        }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(store.calls).toHaveLength(0);
  });

  it('rejects invalid JSON and invalid payloads with 400', async () => {
    const store = new MemoryStore();
    const app = createTestApp(store);

    const badJson = await app.fetch(
      new Request('https://local/v1/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'key-1',
        },
        body: '{"name"',
      }),
    );
    expect(badJson.status).toBe(400);

    const unknownField = await app.fetch(
      new Request('https://local/v1/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer key-2',
        },
        body: JSON.stringify({
          name: 'Ada Lovelace',
          source: 'gitfinder',
          email: 'ada@example.com',
          gx_version: '1.2.3',
          extra: 'nope',
        }),
      }),
    );
    expect(unknownField.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });

  it('accepts valid ingest payloads and normalizes email', async () => {
    const store = new MemoryStore();
    const logs: Array<Record<string, unknown>> = [];
    const app = createTestApp(store, logs);

    const res = await app.fetch(
      new Request('https://local/api/v1/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-api-key': 'key-1',
          'x-forwarded-for': '203.0.113.10, 10.0.0.1',
          'user-agent': 'Bun Test',
        },
        body: JSON.stringify({
          name: ' Ada Lovelace ',
          source: ' gitfinder ',
          email: ' ADA@Example.COM ',
          gx_version: ' 1.2.3 ',
        }),
      }),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store.calls).toEqual([
      {
        name: 'Ada Lovelace',
        source: 'gitfinder',
        email: 'ada@example.com',
        gxVersion: '1.2.3',
        lastIpHash: expect.any(String),
        lastUserAgent: 'Bun Test',
      },
    ]);
    expect(logs[0]?.event).toBe('ingest.accepted');
    expect(logs[0]?.emailHash).toEqual(expect.any(String));
    expect(JSON.stringify(logs)).not.toContain('ada@example.com');
    expect(JSON.stringify(logs)).not.toContain('203.0.113.10');
  });
});
