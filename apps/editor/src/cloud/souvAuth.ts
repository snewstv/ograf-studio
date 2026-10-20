/**
 * Souv authentication for the cloud save integration.
 *
 * Two session shapes (both work with zero Souv changes):
 * - Token session: `?continue=` login returns `?auth=<token>`; kept in memory +
 *   `sessionStorage`, sent as `Authorization: Bearer`.
 * - Cookie session: Souv login sets an HttpOnly `Domain=.souv.*` cookie
 *   (`SameSite=None; Secure`); every cloud call uses `credentials: 'include'`.
 * All cloud fetches send cookies AND Bearer-when-available, so either shape
 * (or both) authenticates. Cloud save NEVER works anonymously.
 * Token/rules: never written to `.ogs`, `localStorage`, logs, or `.ograf.zip`.
 */

export function isCloudSaveEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_CLOUD_SAVE === '1' && getSouvApiBase() !== '';
}

const TOKEN_KEY = 'souv.auth.token';

let memoryToken: string | null = null;
let cookieSession = false;
/** Explicit per-tab logout intent: while set, cookie probes stay negative. */
let loggedOut = false;
const listeners = new Set<(token: string | null) => void>();

function notify(): void {
  for (const listener of listeners) listener(memoryToken);
}

export function onSouvAuthChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSouvApiBase(): string {
  const base =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SOUV_API ??
    '';
  return base.replace(/\/$/, '');
}

export function getSouvAccountUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_SOUV_ACCOUNT_URL) return env.VITE_SOUV_ACCOUNT_URL;
  // Derive from the API base (`api.` -> `account.`), preserving host + port for
  // local runs (e.g. api.souv.live:8787 -> account.souv.live:8787).
  try {
    const url = new URL(getSouvApiBase());
    url.hostname = url.hostname.replace(/^api\./, 'account.');
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'https://account.souv.tv';
  }
}

export function getSouvToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

export function setSouvToken(token: string | null): void {
  memoryToken = token && token.trim() ? token.trim() : null;
  if (memoryToken) loggedOut = false;
  try {
    if (memoryToken) sessionStorage.setItem(TOKEN_KEY, memoryToken);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // sessionStorage unavailable (private mode) — memory token still works for the tab.
  }
  notify();
}

export function clearSouvToken(): void {
  // Local tab only: the browser (HttpOnly) session in the Souv account stays
  // active. Fully signing out requires logging out in the Souv account itself.
  loggedOut = true;
  setSouvToken(null);
  if (cookieSession) {
    cookieSession = false;
    notify();
  }
}

export function isSouvLoggedIn(): boolean {
  return !!getSouvToken() || cookieSession;
}

/** Dev-only escape hatch: `VITE_SOUV_DEV_TOKEN` lets local runs skip the popup. */
function devToken(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const token = env?.VITE_SOUV_DEV_TOKEN;
  return token && token.trim() ? token.trim() : null;
}

/**
 * Ensures a valid Souv session. Resolves with the token, or `null` for a
 * cookie-only session. Rejects when the user cancels. Call this at the start
 * of EVERY cloud save/publish (S1-nuvem, E1-nuvem).
 * Concurrent callers share the same in-flight popup instead of opening one each.
 */
let pendingLogin: Promise<string | null> | null = null;

export function requireSouvLogin(): Promise<string | null> {
  const existing = getSouvToken() ?? devToken();
  if (existing) {
    if (!getSouvToken() && existing) setSouvToken(existing);
    return Promise.resolve(existing);
  }
  pendingLogin ??= (async () => {
    // Already logged in via cookie (e.g. Souv open in another tab)? Skip the popup.
    if (await checkCookieSession()) return null;
    return loginWithSouvPopup();
  })().finally(() => {
    pendingLogin = null;
  });
  return pendingLogin;
}

/**
 * Probes for a cookie session (Souv HttpOnly cookie, no token string needed).
 * Used before opening the popup (already-logged-in users skip it) and after
 * the popup closes without delivering a token.
 */
export async function checkCookieSession(): Promise<boolean> {
  const base = getSouvApiBase();
  if (!base || loggedOut) return false;
  let ok = false;
  try {
    const response = await fetch(`${base}/api/ograf/projects`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    ok = response.ok;
  } catch {
    ok = false;
  }
  if (ok !== cookieSession) {
    cookieSession = ok;
    notify();
  }
  return ok;
}

/**
 * Opens the Souv account sign-in in a popup. The account app redirects back to
 * `{editor}/…?keep=&identity=&auth=<token>` (`?continue=` flow, no Souv
 * changes needed). Resolves the token, `null` for a cookie-only session, or
 * rejects on cancel/timeout.
 */
export function loginWithSouvPopup(): Promise<string | null> {
  // Explicit login intent overrides a previous per-tab logout.
  loggedOut = false;
  const accountUrl = getSouvAccountUrl();
  const returnTo = `${window.location.origin}${window.location.pathname}#/souv-callback`;
  const url = `${accountUrl}/signin?continue=${encodeURIComponent(returnTo)}`;
  const popup = window.open(url, 'souv-login', 'width=480,height=720,menubar=no,toolbar=no');
  if (!popup) {
    throw new Error(
      'The browser blocked the Souv login popup. Allow popups for this site and try again.',
    );
  }
  return new Promise<string | null>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => {
        cleanup();
        reject(new Error('Souv login timed out. Try again.'));
      },
      10 * 60 * 1000,
    );
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin && event.origin !== accountUrl) return;
      // The token must come from the popup this flow opened — not from any
      // other same-origin frame.
      if (event.source !== popup) return;
      const data = event.data as { type?: string; token?: string } | null;
      if (!data || data.type !== 'souv-auth' || !data.token) return;
      cleanup();
      setSouvToken(data.token);
      resolve(data.token);
    };
    const onClose = window.setInterval(() => {
      if (!popup.closed) return;
      cleanup();
      // Popup closed: a token may have arrived via postMessage/redirect, or a
      // cookie session may now exist (e.g. the user was already logged in).
      const token = getSouvToken();
      if (token) {
        resolve(token);
        return;
      }
      void checkCookieSession().then((ok) =>
        ok ? resolve(null) : reject(new Error('Souv login was cancelled before completing.')),
      );
    }, 500);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(onClose);
      window.removeEventListener('message', onMessage);
      if (!popup.closed) popup.close();
    };
    window.addEventListener('message', onMessage);
  });
}

/** Reads `?souv_token=` / `?auth=` (account `?continue=` redirect) / `#souv_token=`. */
export function consumeTokenFromLocation(): boolean {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('souv_token') ?? url.searchParams.get('auth');
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const fromHash = hash.get('souv_token');
    const token = (fromQuery ?? fromHash)?.trim();
    if (!token) return false;
    setSouvToken(token);
    url.searchParams.delete('souv_token');
    url.searchParams.delete('auth');
    url.searchParams.delete('keep');
    url.searchParams.delete('identity');
    hash.delete('souv_token');
    const cleanHash = hash.toString();
    window.history.replaceState(
      null,
      '',
      `${url.pathname}${url.search}${cleanHash ? `#${cleanHash}` : ''}`,
    );
    // Notify an opener waiting in `loginWithSouvPopup`.
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'souv-auth', token }, window.location.origin);
    }
    return true;
  } catch {
    return false;
  }
}

/** Fetch wrapper for Souv API calls: cookies always, Bearer when a token exists. */
export async function souvFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getSouvApiBase();
  if (!base) {
    throw new Error(
      'Cloud save is not configured. Set VITE_SOUV_API (and VITE_CLOUD_SAVE=1) and restart the editor.',
    );
  }
  const token = getSouvToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(`${base}${path}`, { ...init, headers, credentials: 'include' });
}
