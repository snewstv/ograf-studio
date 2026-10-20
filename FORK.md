# Fork notice (AGPL-3.0-only §5a)

This is a modified fork of **OGraf Studio** by Zero Density
(upstream: https://github.com/zerodensity/ograf-studio, branch `stable`).

Fork: https://github.com/snewstv/ograf-studio · modifications since 2026-10-20.

## What was changed

- `packages/scene-model`: optional `FieldDefinition.volkBinding` (opaque live-data record).
- `packages/codegen`: emits `volkBinding` verbatim as manifest `v_volk` (spec vendor field).
- `packages/codegen`: regression test `volkBinding.test.ts`.
- `apps/editor/src/cloud/*` (new): Souv login-gated cloud save/export, Volk catalog
  client (backend-driven, nunca lista local), WebMCP host, gateway tab socket.
  UI Souv vive nos fluxos nativos (menu Souv com link Source, diálogos Save/Export).
- `apps/editor/src/main.tsx`: one side-effect import of `./cloud/mount.tsx`.
- `apps/editor/src/state/projectStore.ts`: `updateDataField` accepts `volkBinding`.
- `apps/editor/src/panels/DataPanel.tsx`: renders `VolkBindingEditor` in field details.
- Root `package.json` + `apps/mcp-server/package.json`: Bun as installer/runner
  (`bun.lock` added; `package-lock.json` kept for upstream sync).
- `apps/editor/src/state/exportPackage.ts`: shared `buildCertifiedZip` + `blobToBase64`
  used by local export and cloud publish (byte-identical packages).
- `apps/editor/src/state/fileIO.test.ts`: upstream tests restored + fork edge cases appended.
- `workers/ograf-editor/*` (new): deploy-ready Cloudflare Worker host (not yet deployed)
  - per-token MCP gateway (`src/gatewayDO.ts`, `src/mcpRouter.ts`, `src/catalog.ts`,
    `src/auth.ts`; `bun test` in that folder covers the router;
    `scripts/smoke-gateway.mjs` covers the live worker).

No upstream feature was removed; local save/export flows are byte-identical.

## License

The whole work stays under **GNU Affero General Public License v3.0 only**
(see `LICENSE`). Corresponding Source of the running version is this repository
(AGPL §6d/§13); the hosted editor links here from its Souv cloud panel.
