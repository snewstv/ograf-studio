# AGENTS.md — regras do fork (valem para qualquer agente/sessão aqui)

## 1. Siga o padrão atual do projeto

- Antes de criar qualquer coisa, leia o código vizinho e imite: mesmos imports,
  mesmos helpers (`buildCertifiedZip`, `requireSouvLogin`, `gqlErrorMessages`), mesmos
  padrões de erro (mensagens legíveis em PT/EN como as existentes, nunca pilhas).
- Bun é o installer/runner (`bun run`, `bun --filter`, `bun test` no worker).
  Não reintroduza `npm`/`tsx` nos scripts.
- Editor: React + Zustand + Vite. Worker: Web Standards puros (sem `nodejs_compat`,
  sem SDKs não verificados no workerd). Souv: Hono + D1/R2 (outro repo — ver §4).

## 2. PROIBIDO: fallbacks e migrações não pedidos

- NÃO crie caminhos alternativos/degradados (ex.: lista local quando o backend
  falha, modos `EXPECT_*`, transportes paralelos, duplo-write) a não ser que o
  usuário peça explicitamente. Um caminho abençoado, que falha alto e legível.
- NÃO migre implementações (REST↔GraphQL, troca de libs, reescritas de transporte)
  a não ser que o usuário peça explicitamente. Ajuste o código ao contrato
  vigente, não o contrário.
- Erro de ambiente (sandbox sem outbound, porta ocupada, credencial ausente)
  NÃO é motivo para embutir bypass no código: documente o limite e siga.

## 3. Fork aditivo e verificável

- Toques em arquivos tracked do upstream: mínimos, aditivos, documentados no
  cabeçalho do `CHECKLIST_OGRAF_WORKERS.md`. Nunca apague teste/código upstream
  (restaure + estenda).
- Nada de `node:*`/`express`/`ws`/`fs` em código que vai ao browser. Nada de
  segredo em `VITE_*`, `.ogs` ou logs. Token só em memória + `sessionStorage`.
- Antes de encerrar: `bun run verify` verde + `bun test` em
  `workers/ograf-editor`. Se algo só roda em staging/browser real, escreva isso
  no checklist em vez de improvisar stub no código.

## 4. Limites fixos (não renegocie sozinho)

- **Sem deploy** sem pedido explícito. **Lado Souv: só docs** (`souv/.agents/ograf-plan.md`,
  nunca código). **Repo `visao`: não mexer** (só ler como referência).
- Decisões congeladas estão no checklist (contrato ZIP+OGS, catálogo no backend
  Volk, sem AI, gateway no worker próprio). Mudança de decisão = pergunta ao usuário.
