// Runs wrangler with cwd=workers/ograf-editor so `wrangler.toml`-relative
// paths (./dist, src/*) resolve correctly no matter where it is invoked from.
// Usage from the repo root: `bun workers/ograf-editor/scripts/wrangler.mjs <args>`
// (root package.json wraps this as `worker:dev`, `worker:deploy:*`).
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Bakes the current commit into the live worker as vars.GIT_REV so /health
// always answers which code a deployment runs (falls back to 'dev' when git
// is unavailable; never fails the invocation).
let gitRev = 'dev';
try {
  gitRev =
    execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: resolve(workerDir, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'dev';
} catch {
  // No git (e.g. source export): keep the 'dev' fallback.
}
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', ...process.argv.slice(2), '--var', `GIT_REV:${gitRev}`],
  {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(result.status ?? 1);
