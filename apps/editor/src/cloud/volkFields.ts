/**
 * Volk live-data catalog — ALWAYS from the Volk backend, never local.
 * Single source of truth: `GET {VOLK_API}/api/ograf/sources`
 * (`E:\projetos\visao\server\src\ograf`, CORS open, no secrets).
 * This module holds no source list: it fetches, caches (10 min, tab-scoped),
 * and looks up. If the backend is unreachable, authoring falls back to a
 * free-form custom source instead of a stale local copy.
 */

export interface VolkSourceDef {
  source: string;
  /** Accepted param names (docs/UX only; resolution ignores extras). */
  params: string[];
  working: boolean;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY_PREFIX = 'volk.sources.cache.v1:';
const FETCH_TIMEOUT_MS = 15000;

let memoryCache: { base: string; exp: number; sources: VolkSourceDef[] } | null = null;

export function getVolkApiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_VOLK_API ?? '').replace(/\/$/, '');
}

function readCache(base: string): VolkSourceDef[] | null {
  if (memoryCache && memoryCache.base === base && memoryCache.exp > Date.now()) {
    return memoryCache.sources;
  }
  memoryCache = null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + base);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { exp: number; sources: VolkSourceDef[] };
    if (!Array.isArray(parsed.sources) || parsed.exp <= Date.now()) return null;
    memoryCache = { base, exp: parsed.exp, sources: parsed.sources };
    return parsed.sources;
  } catch {
    return null;
  }
}

function writeCache(base: string, sources: VolkSourceDef[]): void {
  const entry = { exp: Date.now() + CACHE_TTL_MS, sources };
  memoryCache = { base, ...entry };
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + base, JSON.stringify(entry));
  } catch {
    // sessionStorage unavailable — memory cache still works for the tab.
  }
}

function sanitizeSources(value: unknown): VolkSourceDef[] {
  if (!isRecord(value)) return [];
  const raw = (value as { sources?: unknown }).sources;
  if (!Array.isArray(raw)) return [];
  const out: VolkSourceDef[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.source !== 'string' || !entry.source.trim()) continue;
    out.push({
      source: entry.source.trim(),
      params: Array.isArray(entry.params)
        ? entry.params.filter((p): p is string => typeof p === 'string')
        : [],
      working: entry.working !== false,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fetches the backend catalog (CORS-open, no login). Throws with a legible
 * message when unconfigured or unreachable — callers must fall back to a
 * custom-source input, never to a local list.
 */
export async function fetchVolkSources(apiBase?: string): Promise<VolkSourceDef[]> {
  const base = (apiBase ?? getVolkApiBase()).replace(/\/$/, '');
  if (!base) {
    throw new Error(
      'Volk catalog is not configured. Set VITE_VOLK_API (e.g. https://volk.souv.dev) and restart the editor.',
    );
  }
  const cached = readCache(base);
  if (cached) return cached;
  let response: Response;
  try {
    response = await fetch(`${base}/api/ograf/sources`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      `Could not reach the Volk catalog at ${base}. Check VITE_VOLK_API and network/CORS.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Volk catalog request failed with HTTP ${response.status}.`);
  }
  const sources = sanitizeSources(await response.json().catch(() => null));
  writeCache(base, sources);
  return sources;
}

export function findVolkSource(
  sources: readonly VolkSourceDef[],
  source: string,
): VolkSourceDef | undefined {
  return sources.find((entry) => entry.source === source);
}
