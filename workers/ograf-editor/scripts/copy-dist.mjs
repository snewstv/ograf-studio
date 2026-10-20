// Copies the Vite build (`apps/editor/dist`) into the Worker's `./dist`.
// Static assets bypass the Worker at runtime, so cache + security headers are
// emitted here as a Cloudflare `_headers` file (authoritative for assets).
// Run: `bun run build` (root) then `bun workers/ograf-editor/scripts/copy-dist.mjs`.
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITOR_CSP } from '../src/csp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, '..');
const editorDist = resolve(workerDir, '..', '..', 'apps', 'editor', 'dist');
const outDir = resolve(workerDir, 'dist');

try {
  await stat(resolve(editorDist, 'index.html'));
} catch {
  console.error(`Editor build not found at ${editorDist}. Build the editor first (bun run build).`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(editorDist, outDir, { recursive: true });

const headers = `\
/
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: ${EDITOR_CSP}
/index.html
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: ${EDITOR_CSP}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
await writeFile(resolve(outDir, '_headers'), headers);
console.log(`Copied editor dist -> ${outDir} (+ _headers)`);
