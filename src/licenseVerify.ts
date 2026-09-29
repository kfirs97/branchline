/** Gumroad license verification. Kept free of the vscode API so it can be unit tested. */

/** Gumroad product that sells Branchline Pro licenses (dealership6.gumroad.com/l/branchline-pro). */
export const GUMROAD_PRODUCT_ID = 'J5wcB2F0WJjaIy434QRECg==';
export const BUY_URL = 'https://dealership6.gumroad.com/l/branchline-pro';

export type VerifyResult = { ok: true } | { ok: false; reason: string; network?: boolean };

interface GumroadVerifyResponse {
  success: boolean;
  message?: string;
  purchase?: {
    refunded?: boolean;
    chargebacked?: boolean;
    disputed?: boolean;
    subscription_ended_at?: string | null;
    subscription_cancelled_at?: string | null;
    subscription_failed_at?: string | null;
  };
}

export async function verifyWithGumroad(key: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetchImpl('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ product_id: GUMROAD_PRODUCT_ID, license_key: key.trim(), increment_uses_count: 'false' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, reason: 'Could not reach the license server. Check your connection and try again.', network: true };
  }
  if (res.status >= 500) return { ok: false, reason: 'The license server is unavailable. Try again later.', network: true };
  let body: GumroadVerifyResponse;
  try {
    body = (await res.json()) as GumroadVerifyResponse;
  } catch {
    return { ok: false, reason: 'Unexpected response from the license server.', network: true };
  }
  if (!body.success || !body.purchase) return { ok: false, reason: 'That license key is not valid.' };
  const p = body.purchase;
  if (p.refunded || p.chargebacked || p.disputed) return { ok: false, reason: 'This license was refunded or disputed.' };
  if (p.subscription_ended_at || p.subscription_cancelled_at || p.subscription_failed_at) {
    return { ok: false, reason: 'The subscription for this license is no longer active.' };
  }
  return { ok: true };
}
