/**
 * Souv token check shared by the Worker entry and the gateway DO.
 * A token is valid when the Souv API accepts it; sessions isolate by token
 * hash, so no owner lookup (and no Souv code change) is required.
 */

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
/**
 * Raw check (no cache): the caller (`GatewayDO.#valid`) caches per login
 * stub, so N worker isolates share one introspection per TTL instead of
 * one each.
 */
export async function verifySouvToken(
  env: Record<string, unknown>,
  token: string,
): Promise<string | null> {
  if (!token.trim()) return null;
  const hash = await sha256Hex(token);
  let ok = false;
  try {
    // Any authenticated query proves the token; keep it tiny. GraphQL errors
    // (expired/unknown token) arrive with HTTP 200, so the envelope decides.
    // NOTE: ografProjects is a Connection — a flat selection is rejected, so
    // this probes the edges shape (same as the editor's list query).
    // Fail fast: without a timeout a stalled Souv API would hang the
    // handshake forever (the tab watchdog closes it client-side, but the
    // worker must also settle so retries can proceed on a fresh attempt).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(`${souvApi(env)}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query OgrafList { ografProjects(first: 1) { edges { node { id } } } }',
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const envelope = (await response.json().catch(() => null)) as {
        errors?: Array<{ message?: string }>;
      } | null;
      ok = !envelope?.errors?.length;
    } else {
      ok = false;
    }
  } catch (error) {
    console.error(
      '[gateway] souv introspection failed:',
      error instanceof Error ? error.message : String(error),
    );
    ok = false;
  }
  return ok ? hash : null;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}
