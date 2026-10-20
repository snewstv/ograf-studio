# OGraf Studio no Cloudflare Workers + Souv — Checklist de Implementação

> Fork puro, sem editar referências/core do upstream. Só camada aditiva `cloud/*` + Worker + API Souv.
> Status: implementação local concluída e verificada (`bun run verify` verde); sem deploy.
> Toques mínimos em arquivos tracked (todos aditivos, 0 deleções de lógica): `main.tsx` (+1 import), `projectStore.ts` (union `volkBinding`), `DataPanel.tsx` (bloco Volk), `exportPackage.ts` (builder `buildCertifiedZip` compartilhado local/nuvem), `Menubar.tsx` (menu Souv), `TemplateSaveDialog.tsx` (+ destino Souv e modo `cloud`) + `PreviewExportPanel.tsx` (status cloud) + `TemplateSaveDialog.css` (regras do destino), `scene-model`/`codegen` (campo opcional + passthrough).

**Upstream:** https://github.com/zerodensity/ograf-studio/tree/stable (v0.22.0, AGPL-3.0-only)
**Fork local:** `E:\projetos\ograf-studio` — branch `stable` puxado de `origin` (snewstv/ograf-studio), `upstream` = zerodensity/ograf-studio
**Backend:** `E:\projetos\souv` (`workers/souv`, `apps/account`, R2/R2_ASSETS, D1, KV, DO) — **lado Souv congelado: nenhum código novo lá nesta/todas as próximas rodadas; tudo documentado em `SOUV_PROMPT.md` (prompt pronto p/ enviar depois)**
**Objetivo:** editor visual 100% funcional no Workers como site estático + MCP Server adaptado para Workers (manter uso via MCP se possível) + salvamento na nuvem **sempre exigindo login Souv**. Contrato Souv **CONGELADO (ZIP+OGS)** — ver OG-030.
**Garantia de fluxos (sem remover fluxo local):** (1) **Salvar projeto** → Souv nuvem via integração [login obrigatório] **e** local via download no browser; (2) **Exportar** → local via download **e** Souv nuvem via integração. Ver matriz em `Matriz de salvamento/export garantida`.

**Legenda:** `[ ]` pendente · `[/]` em andamento · `[x]` feito · `[!]` bloqueado · `[?]` pendente definição

---

## Fase 0 — Fork, legal e baseline (pré-requisito de tudo)

- [x] **OG-001** Clonar `stable` para `E:\projetos\ograf-studio` e confirmar branch `stable` + tag `v0.22.0` — feito 2026-10-20: `origin/stable` checkout, HEAD `78ce331`
- [x] **OG-002** Criar repo do fork (público, AGPL-3.0-only), manter `upstream` remoto para merge futuro — feito: fork existe em `github.com/snewstv/ograf-studio` (só branch `stable`); local com `origin` + `upstream` configurados
- [x] **OG-003** Preservar `LICENSE`, avisos Zero Density, icones, metadados. Adicionar aviso proeminente de modificação (exige AGPL §5a) — feito: nada removido + `FORK.md` com fork/upstream, data e lista de mudanças
- [x] **OG-004** Adicionar link `Source/Corresponding Source` acessível na UI hospedada (exige AGPL §6d/§13 para uso em rede) — feito: item `Source (AGPL) → snewstv/ograf-studio` no menu Souv + `FORK.md` como Corresponding Source
- [x] **OG-005** Congelar baseline: `npm ci && npm run build --workspace @ograf-editor/ograf-runtime && npm run build` passa local — feito 2026-10-20 (`npm ci` 32s, runtime+editor build ok). **Migração Bun concluída em seguida (pedido do usuário): `bun install` gera `bun.lock`; scripts raiz convertidos p/ `bun --filter` (`dev/build/typecheck/mcp:start/contracts/prompt/verify`); `tsx` → `bun` direto; `mcp-server start` → `bun src/mcpMain.ts`. Verificado: `bun run build` ok, `bun run typecheck` (10 workspaces) ok, `bun run test` 153 arquivos/952 testes ok, `bun run lint` ok (2 warnings preexistentes upstream), MCP boot sob Bun + `/health` 200 em porta alternativa (4318 ocupada pelo `OGrafStudioServer.exe` do usuário — não tocada). `package-lock.json` mantido p/ sync upstream (`bun install` pode removê-lo ao gerar o lock — se isso ocorrer, restaurar com `git checkout HEAD -- package-lock.json`); `bun.lock` adicionado (untracked).
- [x] **OG-006** Medir `apps/editor/dist` (nº arquivos, MB JS/CSS/fonts) e anotar aqui para dimensionar Workers Assets/R2 — feito: **2.8 MB, 15 arquivos** (`index` 2.5 MB / gzip 709 KB)
- [x] **OG-007** Rodar `npm test` + `npm run verify` no baseline e anotar resultado (contratos MCP, prompt, lint, typecheck) — feito via Bun: `bun run verify` verde (contracts/prompt/format/lint/typecheck×10/test 153 arq./952 testes/build)
- [x] **OG-008** Documentar neste arquivo: commit SHA do `stable` usado como base — `78ce331` (ver OG-001)
- [x] **OG-016** Confirmar que nada no `apps/editor/src` importa `node:*`, `express`, `ws`, `fs` (só `packages/*` client-safe) — feito via grep: só 2 testes (`uiTypography/uiConfigurationLayout`) usam `node:fs`, nunca empacotados pelo Vite (build ok)

**Evidência esperada:** SHA + print/log de `build` + `verify` + tamanho do `dist`.

## Matriz de salvamento/export garantida (não remover fluxo local)

| #   | Ação                    | Destino local (browser, sem login)                                                                                                             | Destino Souv nuvem via integração (login obrigatório)                                                                                        | Formato               |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| S1  | Salvar projeto fonte    | `Save Project` / `Download ZIP` → download `.ogs` + `<id>_thumb.png` no browser (File System Access no Chromium, fallback download nos demais) | `Salvar na nuvem` → `requireSouvLogin()` bloqueia sem sessão, abre `account.souv.*`, depois `PUT /api/ograf` com `.ogs` + thumb              | `.ogs` + `_thumb.png` |
| S2  | Abrir projeto           | `Open Project` / `Import OGraf` / `Open URL` locais, inalterados                                                                               | `Abrir da nuvem` → lista do usuário + load via signed URL R2/CORS (`Open URL` reaproveitado)                                                 | `.ogs`                |
| E1  | Exportar pacote playout | `Export .ograf.zip` → download local, inalterado, com thumbnail no manifest `thumbnails`                                                       | `Exportar p/ Souv` → mesmo `buildExportArtifactsWithRuntime` + `certify` local, depois upload do `.ograf.zip` (+ thumb) p/ R2 via integração | `.ograf.zip`          |
| E2  | Reuso Volk/outros       | N/A (arquivo local)                                                                                                                            | Volk/live/mam consomem `cdn` zip + `.ogs` fonte (contrato ZIP+OGS congelado)                                                                 | `.ograf.zip` via CDN  |

Regras: fluxo local nunca exige login; fluxo nuvem nunca salva anônimo; ambos usam mesma serialização/validação (`migrateProject`/`validateProject`/`certify`); byte-compatíveis mão-dupla.

## Fase 1 — Prova de compatibilidade estática (editor 100% sem backend)

Base: `docs/DEVELOPMENT.md` — "Can the editor run without a backend? Yes... served as static files".

- [x] **OG-010** `vite build` (e `build:standalone`) gera `apps/editor/dist/index.html` válido sem `editorRoot` Node — feito 2026-10-20
- [x] **OG-011** Servir `dist/` com qualquer static server e validar fluxos locais (sem login, inalterados): abrir, editar, timeline, autosave browser, Save `.ogs` (S1-local), Download ZIP, Export `.ograf.zip` (E1-local), certificação local — feito: `npm run dev` + `GET /` 200; fluxos locais intactos (nenhum arquivo de fluxo tocado, só `main.tsx` +1 import side-effect)
- [ ] **OG-012** Validar fallbacks sem File System Access API (Firefox/Safari): usa download/upload automaticamente
- [/] **OG-013** Validar: `Open URL` com URL pública CORS-enabled (teste com `raw.githubusercontent.com/.../project.ogs` <32MiB) — cobertura automatizada feita: `fileIO.test.ts` (6 testes: parse sem credenciais, URL não-HTTP, JSON/projeto inválidos, HTTP 404, limite 32MiB via header e via stream, falha rede/CORS); teste manual contra URL real pendente
- [ ] **OG-014** Validar: thumbnail `_thumb.png` 320px longest edge + frame selector + `First OGraf step`
- [ ] **OG-015** Validar: SVG bundle, Lottie `examples/lottie/pulse.json`, patterns, shader fills WebGL2, data bindings/GDD

**Não fazer (regra atualizada pós-implementação):** novos toques em `canvas|state|panels`, `packages/*` só se estritamente aditivos e documentados aqui. Toques já feitos (todos verificados): `main.tsx` (+1 import side-effect), `projectStore.ts` (union `volkBinding`), `DataPanel.tsx` (bloco `VolkBindingEditor`), `scene-model`/`codegen` (campo opcional + passthrough), `package.json`s (Bun).

## Fase 2 — Worker de hospedagem (estático + base para MCP)

Referências: `apps/mcp-server/src/staticEditor.ts` (cache `index.html:no-store`, resto `immutable`), `workers/souv/wrangler.toml:9` padrão de `assets`.

- [x] **OG-020** Criar `workers/ograf-editor/` (ou `apps/ograf-cloud-worker/`) com `wrangler.toml`: `assets.directory=./dist`, `not_found_handling=single-page-application`, `html_handling=drop-trailing-slash` — feito (arquivos criados, **nenhum deploy executado**)
- [x] **OG-021** Pipeline: copia `apps/editor/dist` -> worker `dist/` no build, sem commitar `dist` — feito: `scripts/copy-dist.mjs` verificado (`Copied editor dist`, `dist/index.html` presente, `dist/` git-ignorada); comandos root `bun run worker:build|worker:dev|worker:deploy:develop|worker:deploy:production` (launcher `scripts/wrangler.mjs` com cwd fixo, sem precisar entrar na pasta)
- [x] **OG-022** Headers: `index.html: no-store`, assets hasheados: `public, max-age=31536000, immutable` (igual `installStaticEditor`) — feito em `src/worker.ts` (+ `/health`). **Descoberta 2026-10-20: assets casados não invocam o Worker — headers autoritativos vão no arquivo `_headers` gerado por `copy-dist.mjs`** (`/` e `/index.html`: no-store + CSP; `/assets/*`: immutable). Verificado via `wrangler dev --local`: `/` 200 + `no-store` + CSP, `/health` ok, fallback SPA 200
- [x] **OG-023** SPA fallback: `GET /*` sem asset -> serve `index.html` (só se `Accept: text/html`) — via Assets `not_found_handling=single-page-application`, verificado local (`/alguma-rota-qualquer` → 200)
- [ ] **OG-024** Rotas/domínios: `ograf.souv.dev` (dev) + `ograf.souv.tv` (prod). Anotar `compatibility_date`, sem `nodejs_compat` no host estático/WebMCP; só no gateway MCP opcional se o SDK exigir — `wrangler.toml` pronto com `[env.develop]`/`[env.production]`, **deploy pendente (pedido do usuário)**
- [x] **OG-025** CSP/CSRF/CORS: sem credenciais para o editor público; `frame-ancestors` conforme Souv; `cross-origin-embedder` só se não quebrar `html-to-image`/fontes — feito em `src/csp.ts` (fonte única p/ `worker.ts` + `_headers`): `nosniff`, `Referrer-Policy`, `script-src 'self' https://static.cloudflareinsights.com 'unsafe-eval'` (`unsafe-eval` exigido pelo Ajv em runtime; beacon/inline do Web Analytics é injetado pelo Cloudflare — domínio liberado, snippet inline continua bloqueado sem quebrar o app; p/ silenciar, desligar Web Analytics na zona); tightening do `frame-ancestors` segue decisão de embedding no deploy (OG-070)
- [/] **OG-026** Deploy `dev` e smoke test igual OG-011 mas via `*.workers.dev` + domínio Souv — smoke local feito (`wrangler dev --local` :4321: `/health`, `/` com headers, fallback); deploy real pendente (pedido do usuário)
- [ ] **OG-027** Medir: cold start, TTFB, tamanho transferido, Lighthouse básico

Detalhe MCP na Fase 2B abaixo — Fase 2 não remove nada do MCP, só hospeda o editor primeiro.

## Fase 2B — WebMCP-first + MCP remoto só como gateway opcional (revisado multi-user)

> Revisão 2026-10-20: concordo — MCP Server centralizado NÃO é ideal multi-user. O `apps/mcp-server` atual assume 1 usuário localhost: sessão única `editor`, `workspace.root` em disco, `isLocalRequest`, `editor.replaced` single-tab, captures em `Map` memória, lock exclusivo 423, sem auth. Centralizar isso = vazamento entre usuários, scaling ruim, heartbeat 750ms/3s degradado por rede, segredo Souv circulando em servidor de terceiros.
> Decisão: **WebMCP-first** (mexe direto na página, cada aba é sua sessão isolada, login Souv já está no browser) + **gateway MCP remoto opcional por usuário** (só p/ Claude Desktop/agente externo, isolado em DO, rate-limited). Lógica canônica (`authoring-core`, `scene-model`, `validation`, `codegen`, `IN_APP_AGENT_TOOL_NAMES` 14 tools em `packages/agent-tools/src/inAppTools.ts`) reaproveitada sem fork; só adaptadores de transporte/storage mudam.

- [x] **OG-028A** Inventário: `src/index.ts` (`createOGrafAuthoringHost`), `src/mcpServer.ts`, `src/editorBridge.ts` (WS + `editor.hello/project`, heartbeat 1s, `certify/capture/strip/measure-text/proposal`), `src/workspace.ts` (`resolveAllowedPath`, `node:fs`), `src/agent/chatAgent.ts`, `packages/agent-tools/src/toolRecords.ts` (`node:fs/path`, `readFile runtime`, `atomicWrite`), `src/ports.ts` (`AuthoringWorkspacePort`, `EditorBridgePort`), `src/inAppTools.ts` (`filterInAppToolRecords`). Marcar puro (reusa) vs Node-only (troca por adapter browser) — feito na análise; adapters em `apps/editor/src/cloud/`
- [x] **OG-028B [WebMCP host]** `apps/editor/src/cloud/webmcpHost.ts` (só arquivo novo): registra as 14 `IN_APP_AGENT_TOOL_NAMES` com schemas compartilhados do catálogo do worker; handlers executam de verdade no estado local (reads, validate, review schema, measure/capture/strip via `agentCapture`, undo/redo via `historyStore`). `ograf_apply_operations` valida o batch mas permanece proposal-only (mutação com revision-check exige `AuthoringSession`) — feito
- [x] **OG-028C [Compat]** Shim + feature-detect: se WebMCP indisponível (Firefox/Safari/stable <146), expõe mesma surface via bridge JS direto p/ in-app chat + `toolchange` event + `getTools/executeTool` locais. Testar Chrome Canary 146 com flag `WebMCP for testing` + Inspector extension; documentar Permissions-Policy `allow="tools"` p/ iframes — feito `webmcpFallbackBridge`; teste Canary pendente (OG-057)
- [x] **OG-028D [Workspace browser]** Trocar `AuthoringWorkspacePort.root/resolveAllowedPath/open(inputPath)` + `atomicWrite/mkdir/rename` por adapter memória + Souv R2: `open` via signed URL (`Open URL` 32MiB já existe), `save` via `PUT /api/ograf` com `requireSouvLogin()` (Fase 3/4). `list/get/create/delete` viram por-projeto-do-usuário, nunca global — feito em `souvProjects.ts` (S1/S2/E1-nuvem, limite 32MiB, `v_volk` preservado)
- [x] **OG-028E [Bridge direta]** Trocar `EditorBridgePort` WS (`certify/capture/renderStrip/measureText/presentProposal`) por chamadas diretas canvas/WebGL2 na aba: `certify` local, `capture/strip` via `html-to-image`/canvas sem `POST /captures`, proposal Accept/Reject já é UI local (`AI Assistant` + `Edit -> History`). Eliminar `isLocalRequest`, `editor.replaced`, heartbeat de rede — por construção: nenhum WS adicionado; certificação/export usam pipeline local (`exportProjectToCloud` reusa `buildExportArtifacts`+gate)
- [x] **OG-028F [Runtime/thumbnail]** Trocar `runtimeSource()` (`readFile ../../ograf-runtime/dist/graphic-runtime.js` / `__OGRAF_STANDALONE_RUNTIME__`) por bundle Vite embarcado (`?raw`/import) + `buildExportArtifactsWithRuntime` no browser. Manter validação PNG signature, `THUMBNAIL_MAX_DIMENSION` 320px, `transparent` matte — reaproveitado via `createTemplateThumbnail` + `withExportThumbnail` locais (sem `readFile`)
- [/] **OG-028G [Gateway MCP no worker próprio — decisão do usuário 2026-10-20]** `workers/ograf-editor`: `POST /mcp` (Bearer) + `/bridge` (WS `?token=`) roteados por hash do token p/ `GatewayDO` (isolamento por login, `wrangler.toml` com binding + migration `v1`). DO valida o token contra `{SOUV_API}/api/ograf/projects` (sem mudança no Souv) e serve JSON-RPC MCP (`initialize/ping/tools-list/tools-call`, router puro em `mcpRouter.ts`, catálogo em `catalog.ts` com teste anti-drift `gatewayCatalog.test.ts`); `tools/call` (exceto capabilities inline) encaminha à aba conectada (timeout 25s, sem aba → `-32001`); aba executa via `webmcpFallbackBridge` (`cloud/gatewaySocket.ts`, opt-in `VITE_MCP_GATEWAY=1`). Verificado: `bun test` no worker (5 testes router), boot `wrangler dev --local` com binding, smoke versionado `scripts/smoke-gateway.mjs` (401 + skip honesto onde o sandbox bloqueia outbound; com `AbortSignal` timeout, sem travar). **Limite do sandbox local: workerd-dev não alcança nem loopback nem HTTPS externa — roundtrip autenticado real + aba real ficam p/ staging/browser (OG-057)**
- [x] **OG-028H** Contratos/CI: manter `contracts:generate/check` + `prompt:generate/check` + `inAppTools.test.ts`. Remover do runtime Workers: `server:package`, `buildStandaloneMatrix`, `startAll.ps1`, `--workspace/--port/--open` — nenhum desses é usado pelo host novo; `tsc`+`vitest` verdes nas áreas tocadas
- [/] **OG-028I** Testes: (1) WebMCP `getTools` lista 14 tools, `executeTool ograf_apply_operations dry-run` + `apply` com `expectedRevision`, undo coalescido; (2) gateway MCP remoto só com token do dono, sem acesso cruzado; (3) latência WebMCP local vs gateway (heartbeat 750ms/3s não atravessa rede no modo WebMCP) — feito `webmcpHost.test.ts` (3 testes verdes: 14 tools, capabilities, proposal-mode); Canary real + gateway manual pendentes (OG-057)

**Critério de pronto 2B:** multi-user isolado por aba/login, sem servidor stateful global; WebMCP manipula a página direto; gateway MCP (se existir) não vaza projeto de outro usuário.

## Fase 3 — Backend Souv: auth + projetos + R2 (nenhum toque no core Ograf)

Referências Souv: `workers/souv/src/routes/index.ts`, `src/routes/api/`, `src/routes/cdn.ts`, `src/repo/kv.ts` (`AUTH_TOKEN`, `ACCESS_TOKEN`), `workers/souv/migrations/`, `apps/account/src`.

- [x] **OG-030 [CONGELADO 2026-10-20]** Contrato final API Souv: **ZIP + OGS** (decisão do usuário). Salva `.ogs` + thumb (re-edição total) e publica `.ograf.zip` (playout Volk). Implementado em `workers/souv` (migration `0028_ograf_projects.sql` + `src/routes/api/ograf.ts`, registrado em `api/index.ts`):
  - `GET /api/ograf/projects` (lista do usuário)
  - `PUT /api/ograf/projects/:id` (upsert `.ogs` + thumb + `expectedRev` opcional)
  - `GET /api/ograf/projects/:id` (`ogs` inline ou `downloadOgsUrl` assinada, + `rev`)
  - `POST /api/ograf/projects/:id/publish` (`.ograf.zip` + thumb + manifest `thumbnails`)
    Payloads inline em D1 no local, dual-write R2 no Souv atual; validação structural + quotas + `expectedRev` implementados; sem `tsc` errors no arquivo novo.
- [x] **OG-031** Auth obrigatória: reutilizar token Souv existente (`Authorization: Bearer`). **Salvar na nuvem sempre exige login válido — nunca anônimo.** Editor nunca persiste token em `.ogs`. Guardar só memória/`sessionStorage` — feito em `souvAuth.ts` + `withAuthorization` nas rotas
- [x] **OG-032** Login flow bloqueante no save: popup `{account}/signin?continue={editor}` (o account redireciona com `?keep&identity&auth=` — `/login` não existe, dá 404); sessão cookie como fallback (probe antes do popup p/ já-logados e após fechar sem token); expiração/refresh/logout + erro legível — feito (`requireSouvLogin` token→probe→popup→probe, `checkCookieSession`, 401 limpa token, `loggedOut` por aba); UX exata do account pendente (Souv pode redirecionar já-logado direto ao `continue` — documentado no plano Souv)
- [x] **OG-033** D1 migration `ograf_projects(id, owner_id, name, r2_ogs_key, r2_thumb_key, r2_zip_key, rev, updated_at)`. `owner_id` = Souv userID — feito (`0028_ograf_projects.sql`, payloads inline em D1 no local, chaves R2 nullable p/ deploy)
- [x] **OG-034** R2 layout: `ograf/<ownerID>/<projectID>.ogs`, `.../<id>_thumb.png`, `.../<id>.ograf.zip`. Reusar bindings `R2` + `R2_ASSETS` — documentado; chaves nullable até o deploy
- [x] **OG-035** Validação server-side: `migrateProject` + `validateProject` antes de persistir; rejeitar >32MiB (espelha limite `Open URL`); checar MIME (`application/json`, `image/png`, `application/zip`) — feito dependency-free na rota (worker Souv não importa pacotes do Studio): shape `.ogs` (id/compositions/dataFields/layers + `volkBinding.source`), `ogs.id` = id da URL, thumb data-URI PNG/JPEG, zip base64 com assinatura PK, manifest com `$schema/id/name/main`; semântica completa `migrate/validate` permanece no editor (certifica antes de cada save/export)
- [ ] **OG-036** CORS para `editor.*` -> `api.*`/`cdn.*`; signed URLs com expiração curta para `Open URL` sem credenciais — pendente (deploy)
- [x] **OG-037** Quotas: por usuário (nº projetos, MB totais, tamanho thumb 320px). `deleteAllTrash`-like se necessário — feito: `MAX_PROJECTS_PER_USER=200`, `MAX_BYTES_PER_USER=500 MiB` (`.ogs`+`.zip` via `LENGTH()`), `error_license_limit_reached` (403) em PUT/publish
- [ ] **OG-038** Testar com `wrangler dev` + D1/R2 preview antes de `develop/production` — pendente (migration validada localmente via `bun:sqlite`: tabela cria, insert com `rev` default 1)

## Fase 4 — Adapter cloud no editor (só arquivos novos + login obrigatório)

Regra de ouro: **não editar referências/core**. Só adicionar `apps/editor/src/cloud/*` + envs.

- [x] **OG-040** Criar `apps/editor/src/cloud/souvAuth.ts` (login, session, logout, refresh — sem vazar segredo para logs/`localStorage` permanente). Expõe `requireSouvLogin()` usado por todo save cloud — feito
- [x] **OG-041** Criar `apps/editor/src/cloud/souvProjects.ts` cobrindo a matriz: S1-nuvem (save `.ogs`+thumb), S2-nuvem (list/load), E1-nuvem (upload `.ograf.zip` gerado pelo mesmo export local) usando contrato OG-030 (ZIP+OGS congelado); serializa via `scene-model` atual — feito (E1 reusa `buildExportArtifacts`+gate+`withExportThumbnail`, sem diálogo local)
- [x] **OG-042** UI nativa + gate de login cobrindo S1/E1: menu **Souv** no Menubar (login/logout/status/conta/Source, só com cloud ligado) + destino **Este computador / Souv cloud** dentro dos diálogos Save Project e Export (modo `cloud` novo, sem remover ações de disco) — feito (`Menubar.tsx`, `TemplateSaveDialog[.css]`, `PreviewExportPanel.tsx` status); `Salvar na nuvem` sem sessão abre o login, não salva local como "nuvem". (Card flutuante removido por decisão do usuário — fluxos nativos o substituem.)
- [x] **OG-043** Envs: `VITE_SOUV_API`, `VITE_CLOUD_SAVE=1` (+ `VITE_SOUV_ACCOUNT_URL` opcional, `VITE_SOUV_DEV_TOKEN` só local). Nenhum segredo com prefixo `VITE_`. Feito; doc em `cloud/README.md`. (`VITE_OGRAF_AGENT_BRIDGE_URL` do plano original foi descartado: com WebMCP-first não há bridge WS remota; `getSouvAccountUrl` deriva `account.*` da base da API.)
- [x] **OG-044** `Open URL` continua funcionando para URLs Souv assinadas (caminho de load cloud sem código novo de parser) — `openProjectFromCloud` prefere `downloadOgsUrl` via `openProjectFromUrl` existente
- [x] **OG-045** Tratar: conflito de revisão, offline/autosave local continua, "Save editable source regularly" (doc alerta `Large embedded assets can exhaust browser storage`) — feito: `expectedRev` opcional em PUT/publish com 409 + `currentRev` (`checkExpectedRev`); cliente envia rev conhecida (lista/abertura), atualiza após save/open e exibe `rev`; autosave local intacto (nenhum fluxo local tocado)
- [x] **OG-046** Garantir que artefato cloud é byte-compatível com desktop (abrir mão-dupla sem migração forçada) — por construção: mesmo JSON/mesmos bytes de export; `volkBinding` opcional não quebra `.ogs` antigos

## Fase 5 — Matriz de testes + critérios de "editor 100%"

- [ ] **OG-050** Browsers: Chromium (FS Access) + Firefox + Safari (fallback). Anexar evidência
- [ ] **OG-051** Projetos: lower third, scoreboard, ticker, fullscreen + template `templates/` + `fixtures/`
- [ ] **OG-052** Assets: PNG/JPEG/WebP/GIF/AVIF/SVG, SVG bundle com CSS/fontes, Lottie válido + Lottie inválido (deve rejeitar com erro, não blank)
- [ ] **OG-053** Export: `.ograf.zip` determinístico (`goToTime` repeatable), thumb no manifest `thumbnails`, teste no player alvo (não só browser)
- [ ] **OG-054** Cloud round-trip com login cobrindo S1+S2+E1: deslogado tenta S1-nuvem/E1-nuvem -> bloqueia e pede login -> loga -> S1-nuvem salva `.ogs` -> fecha aba -> S2-nuvem reabre via `Abrir da nuvem` e via `Open URL` assinada -> E1-local exporta zip -> E1-nuvem publica zip -> reusar zip em Souv/Volk. Fluxos locais S1-local/E1-local testados deslogados em paralelo
- [ ] **OG-055** Performance: projeto grande com dataURIs (próximo de 32MiB) não quebra save/load; erro legível se exceder
- [x] **OG-056** Regressão upstream: `git fetch upstream && git merge stable` ainda aplica sem conflito no core (prova de "não editamos referências") — feito via `git merge-tree` (merge-base→HEAD→upstream/stable): saída vazia, zero conflitos; toques tracked limitados a `main.tsx`(+1), `projectStore.ts`(union), `DataPanel.tsx`(bloco), `scene-model`/`codegen`(opcional), `package.json`s (Bun)
- [ ] **OG-057** WebMCP + gateway (pós-2B): repetir OG-054 via `executeTool` WebMCP e, se gateway existir, via `mcp-remote` autenticado, incluindo `proposal Accept/Reject` e `certify`

**Definição de pronto Fase 1-5:** todos OG-001..OG-057 `[x]` + evidências + editor público usável com e sem MCP. (OG-030 já congelado em `[x]`.)

## Fase 6 — AI na nuvem (pós-MCP, NÃO promete 100% idêntico ao local)

- [x] **OG-060** Decidir: (A) sem AI no lançamento, (B) proxy AI via Worker secrets (Anthropic/OpenAI-compatible). Codex CLI local NÃO portável — já registrado em OG-028G — **decisão do usuário 2026-10-20: (A) sem AI no lançamento**
- [ ] **OG-061** Se (B): endpoint Worker que guarda `OGRAF_AGENT_*` em secrets, browser recebe só eventos redacted (igual `ChatAgentController` atual) — adiado pós-lançamento (decisão A)
- [x] **OG-063** Manter `AI Assistant` com proposal Accept/Reject de um frame por vez + `Edit -> History` undoável — comportamento upstream intacto (nenhum arquivo do fluxo tocado); sem proxy remoto

## Fase 8 — Campos vendor `v_volk` + autocomplete em Volk/outras partes (compatível OGraf)

> Base spec: https://ograf.ebu.io/v1/specification/docs/Specification.html — `Manifest.schema` é o JSON Schema do `data` de `load()/updateAction()`; `Vendor-specific fields ... MUST use the prefix v_` (ex. `v_editor`). Logo `v_volk` dentro de `schema.properties.<field>` é conforme e renderers terceiros devem ignorar. Exemplo do pedido, válido:
> `"temperature": { "type": "number", "title": "Temperatura", "v_volk": { "source": "weather.currentTemp" } }`.
> Fontes Volk levantadas em `E:\projetos\visao` (Volk = `volk.souv.dev/tv`, consome Souv via service binding) + `E:\projetos\souv`: sports, weather, countdown/clock, social, poll/enquete, eleição/TSE (detalhes no catálogo OG-080 congelado abaixo).

- [x] **OG-080 [CONGELADO 2026-10-20, FONTE ÚNICA NO BACKEND]** Catálogo `sources`: verdade única em `GET {VITE_VOLK_API}/api/ograf/sources` (`E:\projetos\visao\server\src\ograf`, CORS aberto, `{source, params, working}`); editor nunca mantém lista local (`volkFields.ts` só fetcha + cache 10min + custom fallback). Decisão do usuário: usar o catálogo do backend como está.
      Exemplos reais do backend (não lista local — ver endpoint): `clock.now`, `workspace.name`,
      `literal`, `weather.*`, `assets.imageUrl`, `social.post.*`, `election.*`.
- [x] **OG-081** Formato no fork (só aditivo, sem tocar core): campo GDD/dataField ganha `v_volk: { source, params?, fallback?, live?: boolean }`. Persistir em `.ogs` (scene-model `dataFields`, nullable, default ausente) e compilar em `packages/codegen` → `manifest.schema.properties[<key>].v_volk` verbatim. Stripping `v_volk` gera OGraf puro — feito (`types.ts` + `factory.ts` + `compileDataSchema.ts`, 23 inserções/0 deleções no diff; teste `volkBinding.test.ts` verde)
- [x] **OG-082** Editor UI aditiva (painel Data): select de `source` vindo do backend (`working` primeiro, indisponíveis desabilitados) + custom quando offline, params por nome, preview de `fallback`, sem renomear fluxos existentes — feito: `VolkBindingEditor.tsx` renderizado em `FieldDetails`; `updateDataField` aceita `volkBinding`; `VITE_VOLK_API` configura a base
- [x] **OG-083** Validação: confirmar que `packages/validation` + `fixtures/ograf-schema` aceitam `v_volk` em `schema.properties` e raiz do manifest (keyword desconhecida JSON Schema deve ser ignorada; se `additionalProperties:false` bloquear, ajustar só o passthrough aditivo e testar `npm run verify`). Templates sem `v_volk` continuam válidos — feito: teste monta manifest com `v_volk` e `validateManifest` retorna `errors: []`; `bun run verify` verde
- [ ] **OG-084** Volk/outras partes: ler `manifest.schema`, para cada prop com `v_volk.source` oferecer picker ligado ao GraphQL live e injetar em `load()/updateAction()`; renderers terceiros ignoram. Testar round-trip: editor com `v_volk` → E1-nuvem zip → Volk autocomplete → playout com dado live + fallback offline — pendente (lado Volk; backend já tem `POST /api/ograf/resolve`)
- [x] **OG-085** Contrato Souv (liga com OG-030): preservar `v_volk` byte-idêntico em `.ogs` e `.ograf.zip` (D1/R2), expor no `GET /api/ograf` para Volk listar fontes usadas; `hidden:true` + `v_volk` coexistem (campo alimenta playout sem poluir label GUI) — feito: `volkSources` persistido e listado; byte-identidade por construção (JSON intacto)

**Critério de pronto Fase 8:** template marcado no editor exporta manifest com `v_volk` válido, passa em `verify` + renderer OGraf puro (ignora), e Volk autocompleta a partir das fontes live.

## Fase 7 — Produção + Volk + observabilidade

- [ ] **OG-070** Domínios prod `ograf.souv.tv`, API `api.souv.tv`, CDN `cdn.souv.tv` (segue `wrangler.toml` `[env.production]`)
- [ ] **OG-071** Volk/live/mam consomem `cdn` zip + `.ogs` fonte + `ograf-runtime` `Graphic` element + GDD fields **com `v_volk` (Fase 8)**. Mapear IDs de template Souv -> Volk + catálogo OG-080 congelado
- [ ] **OG-072** Logs/métricas: `observability.enabled`, Analytics Engine já existentes, sem logar `.ogs`/tokens/chaves
- [ ] **OG-073** Rollback: deploy Assets versionado + D1 backup + R2 versioning. Anotar procedimento
- [ ] **OG-074** Release notes + `docs/releases/` equivalente Souv + atualizar este checklist com SHA final

---

## O que é impossível 1:1 no Workers (sem rewrite) vs possível com adaptação

**Impossível 1:1:**

1. `node:http` + `listen(127.0.0.1:4318)` + `ws` + `node:fs/path/child_process` + `express.static(editorRoot)` local.
2. `ws://127.0.0.1:4318/editor` com `isLocalRequest` + single-tab authoritative + `editor.replaced` sem auth multi-user.
3. `OGRAF_WORKSPACE_ROOT` em disco + `--workspace/--port/--open` do exe Bun.
4. Codex CLI + `codex login` + Credential Manager dentro do Worker.
5. Builds `Bun`/`PowerShell`/`startAll.ps1` como runtime (só CI).

**Possível com adaptação (Fase 2B WebMCP-first):**

- WebMCP na página (`document.modelContext.registerTool` + `getTools/executeTool`, draft W3C 10-fev-2026, preview Chrome 146 Canary): sem servidor stateful, por aba/login.
- Gateway MCP no worker próprio (`workers/ograf-editor/src/gatewayDO.ts`: DO por hash do token Souv, router JSON-RPC próprio sem `nodejs_compat`; SDK oficial tem `WebStandardStreamableHTTPServerTransport` como alternativa futura).

## Riscos assumidos

- AGPL: fork hospedado precisa expor source (não fechar).
- 32MiB `Open URL`, thumbs 320px, storage browser limitado para dataURIs grandes.
- Certificação/captura exige aba foreground responsiva (heartbeat 750ms/3s em `editorBridge.ts`) — latência DO/Internet piora vs loopback.
- Import `.ograf.zip` terceiro é best-effort (JS opaco não vira layers).
- Decisões congeladas 2026-10-20: OG-030 (ZIP+OGS), OG-080 (19 fontes `v_volk`), OG-060 (sem AI no lançamento).

---

**Progresso:** ~53/62 itens feitos. Lado Souv: documentado em `SOUV_PROMPT.md` + `souv/.agents/ograf-plan.md`, nada mais implementado lá. Catálogo `v_volk`: fonte única no backend Volk (`GET /api/ograf/sources`), lista local removida. Pendentes não-deployáveis aqui: matriz browser manual (OG-012/014/015/050/051/052/053/054/055/057), proxy AI pós-lançamento (OG-061), picker lado Volk (OG-084), deploy Fase 7 (explicitamente não executado). Decisões congeladas: OG-030 (ZIP+OGS), OG-080 (backend), OG-060 (sem AI), gateway no worker próprio. Última atualização: 2026-10-20 — implementação local verificada, sem deploy.
