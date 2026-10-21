/**
 * Single source for the editor Content-Security-Policy, shared by the Worker
 * (`worker.ts`, defense for worker-served responses) and the deploy pipeline
 * (`scripts/copy-dist.mjs`, authoritative `_headers` for static assets, which
 * bypass the Worker at runtime).
 *
 * `connect-src` must cover every host the editor calls: Souv api/cdn per env,
 * local `.live` dev hosts, and the Volk catalog hosts (`VITE_VOLK_API`).
 * Same-host `wss://` bridge sockets are covered by `'self'`. A custom
 * `VITE_GATEWAY_URL` on another host requires extending this list.
 *
 * `script-src` notes (verified against the deployed app):
 * - Our `index.html` ships zero inline scripts (all bundles external).
 * - `unsafe-inline` IS required: certification (`importModuleInRealm`) injects
 *   an inline `<script type="module">` shim into a disposable iframe, with no
 *   timeout — without it, save/export hang forever instead of failing. This
 *   matches upstream posture (no CSP at all there); the content is the user's
 *   own project in a single-user authoring tool.
 * - `https://static.cloudflareinsights.com` lets the Cloudflare beacon load;
 *   its injected inline snippet stays blocked (harmless — only RUM data is
 *   lost). To silence that console error, disable Web Analytics for the zone.
 * - `blob:` is REQUIRED: the export/certification pipeline builds the OGraf
 *   runtime as a Blob URL and `import()`s it dynamically (including inside
 *   the certification iframe). Without it, save/export hang or fail with
 *   "Failed to fetch dynamically imported module: blob:...". Blob URLs can
 *   only be created by the page's own code, so the risk stays contained.
 * - `unsafe-eval` is REQUIRED at runtime: Ajv (bundled in the capture chunk)
 *   compiles JSON schemas via `new Function`.
 */
export const CSP_SCRIPT_SRC = [
  "'self'",
  'https://static.cloudflareinsights.com',
  "'unsafe-inline'",
  "'unsafe-eval'",
  'blob:',
].join(' ');
export const CSP_CONNECT_SRC = [
  "'self'",
  'https://api.souv.dev',
  'https://api.souv.tv',
  'https://cdn.souv.dev',
  'https://cdn.souv.tv',
  'https://api.souv.live:8787',
  'https://account.souv.live:8787',
  'https://volk.souv.dev',
  'https://volk.souv.tv',
].join(' ');

export const EDITOR_CSP = [
  "default-src 'self'",
  `script-src ${CSP_SCRIPT_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${CSP_CONNECT_SRC}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
