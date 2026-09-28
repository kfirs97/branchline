import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithGumroad } from '../src/licenseVerify';

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('valid purchase activates', async () => {
  assert.deepEqual(await verifyWithGumroad('KEY', reply(200, { success: true, purchase: { refunded: false } })), { ok: true });
});

test('unknown key is rejected, not treated as a network problem', async () => {
  const r = await verifyWithGumroad('BAD', reply(404, { success: false, message: 'That license does not exist for the provided product.' }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.network);
});

test('refunds, disputes and ended subscriptions are rejected', async () => {
  for (const purchase of [{ refunded: true }, { chargebacked: true }, { disputed: true }, { subscription_cancelled_at: '2026-01-01' }]) {
    const r = await verifyWithGumroad('KEY', reply(200, { success: true, purchase }));
    assert.equal(r.ok, false, JSON.stringify(purchase));
  }
});

test('network failures and server errors are flagged so a cached license keeps working', async () => {
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  for (const f of [down, reply(503, {}), (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch]) {
    const r = await verifyWithGumroad('KEY', f);
    assert.ok(!r.ok && r.network === true);
  }
});

test('sends product id, trimmed key, and does not count a use', async () => {
  let sent = '';
  const spy = (async (_url: string, init: RequestInit) => {
    sent = String(init.body);
    return new Response(JSON.stringify({ success: true, purchase: {} }));
  }) as unknown as typeof fetch;
  await verifyWithGumroad('  KEY-1 \n', spy);
  const params = new URLSearchParams(sent);
  assert.equal(params.get('license_key'), 'KEY-1');
  assert.equal(params.get('increment_uses_count'), 'false');
  assert.ok(params.has('product_id'));
});
