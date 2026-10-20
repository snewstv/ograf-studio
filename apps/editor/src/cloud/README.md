# Souv cloud layer (fork-only, additive)

Editor-side additions live in this folder plus minimal hooks elsewhere
(`main.tsx` import, `Menubar.tsx` Souv menu, `TemplateSaveDialog[.css]` Souv
destination, `PreviewExportPanel.tsx` cloud status, `projectStore.ts`
`volkBinding` union). Upstream flows stay intact and mergeable.

## Files

- `souvAuth.ts` — Souv login (account `/signin?continue=` → `?auth=` token,
  HttpOnly cookie fallback), tab-scoped token (`sessionStorage`),
  `requireSouvLogin()`. Token never goes to `.ogs`, logs, or zip.
- `souvProjects.ts` — S1/S2/E1-nuvem REST client (`/api/ograf/projects`).
  Reuses local `.ogs` JSON + certified export bytes, preserving `v_volk`.
- `volkFields.ts` — Volk catalog client (`GET {VITE_VOLK_API}/api/ograf/sources`,
  backend é fonte única; cache 10min; sem lista local).
- `webmcpHost.ts` — WebMCP `registerTool`/`getTools`/`executeTool` host + fallback bridge.
- `mount.tsx` — side-effect mount (login callback, WebMCP, gateway bridge).

## Local run (Bun — package manager and runner of this fork)

```powershell
# from E:\projetos\ograf-studio
bun install
$env:VITE_SOUV_API = "https://api.souv.live:8787"
$env:VITE_SOUV_ACCOUNT_URL = "https://account.souv.live:8787"
$env:VITE_VOLK_API = "https://volk.souv.dev" # local Volk: visao `wrangler dev` URL
$env:VITE_CLOUD_SAVE = "1"
# optional local-only bypass (never production):
# $env:VITE_SOUV_DEV_TOKEN = "<paste a souv auth token>"
bun run dev
```

Without `VITE_CLOUD_SAVE=1` the editor behaves exactly like upstream
(the Souv menu is hidden, WebMCP registration is a no-op where unsupported).

## Native Souv flows (no popup-card needed)

- **Menubar → Souv**: login/logout/status + link to the Souv account. The tab
  logout clears only the tab token; the browser (cookie) session stays until
  you log out in the Souv account.
- **Save Project dialog**: destination radio **This computer / Souv cloud**
  (login-gated). **Export .ograf.zip dialog**: same destination radio;
  Souv publishes the certified zip.

> Security note: the `?souv_token=`/`#souv_token=` login callback puts a bearer
> token in the URL (history, and potentially referer headers/logs). Prefer
> short-lived Souv tokens; the token itself is kept in memory + `sessionStorage`
> only and never lands in `.ogs`, logs, or the exported zip.

## MCP gateway tab bridge (opt-in)

```powershell
$env:VITE_MCP_GATEWAY = "1"
# optional: point the tab socket elsewhere (default: same host, /bridge)
# $env:VITE_GATEWAY_URL = "ws://127.0.0.1:4321"
```

With a Souv token in session, the tab keeps `wss://<host>/bridge?token=`
open so the worker gateway (`workers/ograf-editor`) can forward MCP
`tools/call` from an external client holding the same token. Executions reuse
the WebMCP handlers (`webmcpFallbackBridge`). Covered by
`gatewayCatalog.test.ts` (catalog parity) and worker `mcpRouter.test.ts`
(`bun test` in `workers/ograf-editor`).
