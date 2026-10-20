# workers/ograf-editor — deploy-ready host (no deploy yet)

Static host for the fork. Everything runs from the repo root — never `cd`.
Deploy scripts ALWAYS rebuild first (`worker:build` = editor build + dist copy),
so there is nothing to remember before deploying:

```powershell
bun run worker:build              # editor build + copy dist (+ _headers)
bun run worker:dev                 # wrangler dev --local (preview, no deploy)
bun run worker:deploy:develop      # rebuild + deploy to ograf.souv.dev
bun run worker:deploy:production   # rebuild + deploy to ograf.souv.tv
```

## Local (Bun)

```powershell
# 1) editor (Vite, cloud panel on)
$env:VITE_SOUV_API = "https://api.souv.live:8787"
$env:VITE_SOUV_ACCOUNT_URL = "https://account.souv.live:8787"
$env:VITE_CLOUD_SAVE = "1"
bun run dev

# 2) preview the exact deploy bundle (no deploy)
bun run worker:build
bun run worker:dev
```

## Deploy (later, NOT in this task)

```powershell
npx wrangler deploy --env develop    # ograf.souv.dev
npx wrangler deploy --env production # ograf.souv.tv
```

## Gateway smoke (no deploy)

```powershell
# terminal 1 (worker + gateway, Souv reachable for auth-positive checks):
npx wrangler dev --local --port 4321 --var SOUV_API:https://api.souv.dev
# terminal 2:
bun workers/ograf-editor/scripts/smoke-gateway.mjs
# with a fake tab roundtrip:
$env:WITH_TAB = "1"; bun workers/ograf-editor/scripts/smoke-gateway.mjs
# where the sandbox blocks workerd outbound (auth unverifiable locally):
$env:EXPECT_AUTH_FAIL = "1"; bun workers/ograf-editor/scripts/smoke-gateway.mjs
```

Notes: `dist/` is generated (git-ignored). `/health` is served by
`src/worker.ts`; everything else comes from Static Assets with SPA fallback.
The tab bridge (`/bridge?token=`) carries the Souv token in the query string
(WebSocket upgrades cannot set headers) — prefer short-lived tokens.
