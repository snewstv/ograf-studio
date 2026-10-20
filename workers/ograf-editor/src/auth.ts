/**
 * Souv token check shared by the Worker entry and the gateway DO.
 * A token is valid when the Souv API accepts it; sessions isolate by token
 * hash, so no owner lookup (and no Souv code change) is required.
 */

const cache = new Map<string, { ok: boolean; exp: number }>();
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function souvApi(env: Record<string, unknown>): string {
  const base = (env.SOUV_API as string | undefined) ?? '';
  if (!base) throw new Error('SOUV_API is not configured on this worker.');
  return base.replace(/\/$/, '');
}

/** Returns the token hash when the token is accepted by Souv, else null. */
export async function verifySouvToken(
  env: Record<string, unknown>,
  token: string,
): Promise<string | null> {
  if (!token.trim()) return null;
  const hash = await sha256Hex(token);
  const hit = cache.get(hash);
  if (hit && hit.exp > Date.now()) return hit.ok ? hash : null;
  let ok = false;
  try {
    const response = await fetch(`${souvApi(env)}/api/ograf/projects`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    // Only 2xx proves the token is accepted. Anything else (401 expired,
    // 403/404/5xx) is invalid — a Souv outage therefore fails closed.
    ok = response.status >= 200 && response.status < 300;
    // Drain so sockets are reused.
    await response.arrayBuffer().catch(() => undefined);
  } catch (error) {
    console.error(
      '[gateway] souv introspection failed:',
      error instanceof Error ? error.message : String(error),
    );
    ok = false;
  }
  cache.set(hash, { ok, exp: Date.now() + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return ok ? hash : null;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}
