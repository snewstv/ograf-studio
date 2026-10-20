// Runs wrangler with cwd=workers/ograf-editor so `wrangler.toml`-relative
// paths (./dist, src/*) resolve correctly no matter where it is invoked from.
// Usage from the repo root: `bun workers/ograf-editor/scripts/wrangler.mjs <args>`
// (root package.json wraps this as `worker:dev`, `worker:deploy:*`).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', ...process.argv.slice(2)],
  {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(result.status ?? 1);
