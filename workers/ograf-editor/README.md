# workers/ograf-editor — Cloudflare host (develop live, production ready)

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

## Deploy

| env        | comando                            | domínio        | Souv API             | workers.dev |
| ---------- | ---------------------------------- | -------------- | -------------------- | ----------- |
| develop    | `bun run worker:deploy:develop`    | ograf.souv.dev | https://api.souv.dev | sim         |
| production | `bun run worker:deploy:production` | ograf.souv.tv  | https://api.souv.tv  | não         |

Ambos repetem os bindings no toml (bindings não são herdados por env):
GATEWAY (Durable Object) + AI + ASSETS; `GIT_REV` é injetado pelo
`scripts/wrangler.mjs` a cada deploy e aparece no `/health`.
Produção NUNCA é publicada sem ordem explícita — valide antes com dry-run
(não publica nada):

```powershell
npx wrangler deploy --env develop    # ograf.souv.dev
npx wrangler deploy --env production # ograf.souv.tv
```

```powershell
# rows acima via wrapper (repo root), com GIT_REV + cwd certo:
bun workers/ograf-editor/scripts/wrangler.mjs deploy --env production --dry-run
```

Nota de ambiente: o build Vite exige Node 20+ no PATH (o Node 16 do sistema
quebra o `vite build` com `node:util has no export styleText`); use o
Node 24 do nvm. Builds/deploys sempre via Bun (`bun run`), nunca npm/tsx.

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

## AI chat (default-on, no deploy)

`POST /ai/chat` (SSE) runs the Workers AI model (`ai` binding,
`AI_MODEL`, default DeepSeek Flash) with the
14 MCP tools as functions; tool calls fan out to the ORIGIN TAB's
GatewayDO stub (`/internal/tool-call`, routed by `tabId`) so concurrent
tabs on different projects never mix. Same Souv Bearer gate as `/mcp`.

```powershell
# terminal 1 (worker):
bun run worker:dev
# terminal 2 (editor, same-origin or VITE_GATEWAY_URL):
bun workers/ograf-editor/scripts/smoke-ai.mjs
```

Editor side: the AI Assistant talks to this route by default (no flag or
query param needed; needs the `AI` binding + a paid Workers plan or AI
Gateway credits). Kill-switches: `$env:VITE_AI_CHAT = "0"` at build time,
or `?ai_chat=0` for one tab (`?ai_chat=1` forces it back on). The panel
reuses the tab Souv login (same token as cloud save and the tab bridge);
only a token-less tab shows a login button, once per tab.

Multi-tab: each tab generates its own `tabId` (`sessionStorage`, survives
reloads) and sends it on the bridge connect and in every turn, so prompts in
different tabs edit only their own open project. Close or replace the origin
tab mid-turn and the worker fails the turn loudly instead of touching
another tab. `VITE_GATEWAY_URL` points the editor at the worker; both envs
are baked at editor build time. `AI_MODEL` can be overridden per worker env
in `wrangler.toml` (`[vars]` / `[env.*.vars]`).
