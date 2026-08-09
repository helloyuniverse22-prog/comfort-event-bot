import { describe, it, expect } from 'vitest';
import { verifyEd25519, handleInteraction } from '../src/interactions/index';
import type { Env } from '../src/env';

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeKeyPair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pubRaw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKeyHex: bytesToHex(new Uint8Array(pubRaw)), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body));
  return bytesToHex(new Uint8Array(sig));
}

describe('verifyEd25519 (Discord Interaction 署名検証)', () => {
  it('正しい鍵・署名 → true (PING 受け入れ)', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = await sign(privateKey, ts, body);
    expect(await verifyEd25519(body, sig, ts, publicKeyHex)).toBe(true);
  });

  it('body が改ざんされた → false', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    const sig = await sign(privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":2}', sig, '1700000000', publicKeyHex)).toBe(false);
  });

  it('別鍵の公開鍵で検証 → false', async () => {
    const a = await makeKeyPair();
    const b = await makeKeyPair();
    const sig = await sign(a.privateKey, '1700000000', '{"type":1}');
    expect(await verifyEd25519('{"type":1}', sig, '1700000000', b.publicKeyHex)).toBe(false);
  });

  it('公開鍵フォーマット不正 → false (throw しない)', async () => {
    expect(await verifyEd25519('body', 'aabb', '0', 'not-hex')).toBe(false);
    expect(await verifyEd25519('body', 'aabb', '0', 'abc')).toBe(false); // odd-length
    expect(await verifyEd25519('body', 'aabb', '0', '')).toBe(false);
  });

  it('署名フォーマット不正 → false (throw しない)', async () => {
    const { publicKeyHex } = await makeKeyPair();
    expect(await verifyEd25519('body', 'zz', '0', publicKeyHex)).toBe(false);
  });
});

describe('handleInteraction — ボタンは deferred (type 5) を即返す', () => {
  it('MESSAGE_COMPONENT → 即時 type 5 (ephemeral) + waitUntil で PATCH @original', async () => {
    const { publicKeyHex, privateKey } = await makeKeyPair();
    // custom_id に区切り '_' 無し → occurrenceId NaN → DB を触らず早期 ephemeral エラーで返る経路
    const body = JSON.stringify({
      type: 3,
      application_id: 'app123',
      token: 'tok456',
      data: { custom_id: 'garbage' },
      member: { user: { id: 'u1', username: 'alice' } },
    });
    const ts = '1700000000';
    const sig = await sign(privateKey, ts, body);
    const request = new Request('https://example.com/interactions', {
      method: 'POST',
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
      body,
    });

    const tasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
    } as unknown as Parameters<typeof handleInteraction>[2];

    const patches: { url: string; body: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      patches.push({ url: String(url), body: String(init?.body) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await handleInteraction(request, { DISCORD_PUBLIC_KEY: publicKeyHex } as Env, ctx);
      expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });

      // 実処理は waitUntil に 1 件だけ積まれ、完了後に PATCH @original が飛ぶ
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(patches).toHaveLength(1);
      expect(patches[0].url).toBe(
        'https://discord.com/api/v10/webhooks/app123/tok456/messages/@original',
      );
      expect(JSON.parse(patches[0].body).content).toContain('不正なインタラクション');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
