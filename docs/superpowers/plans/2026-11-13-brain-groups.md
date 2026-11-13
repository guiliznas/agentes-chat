# Grupos de IA (brain groups): plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ Este arquivo vive só no fork (`guiliznas/agentes-chat`, branch `feat/brain-groups`). Ele **sai antes do PR upstream**:
> o repositório é público e o `check:boundaries` recusa ids de planejamento interno (CLAUDE.md do repo, "Non-negotiables").

**Goal:** um agente pensa com um **grupo ordenado de contas de plano, no máximo uma por provedor**, no mesmo computador.
Cada turno usa o primeiro membro com folga (ou o de mais folga). Com o grupo inteiro no limite, vale o fallback que
já existe: a chave do workspace se `brainFallback` estiver ligado, senão espera.

**Architecture:** o grupo é resolvido num único ponto, como o braço direito já faz com a IA de cada pessoa
(`withPersonalBrain`, `packages/engine/src/right-hand.ts:405`). Um novo `withGroupBrain` devolve o agente com
`brain`/`brainModel`/`brainEffort`/`brainAccountId` trocados pelos do membro escolhido. Todo o resto do motor
(`computerBrainUnavailable`, `plan_limit`, fallback, espera) continua igual e passa a enxergar o membro como "a conta
do agente". O membro escolhido gruda na conversa enquanto tiver folga, para não perder a sessão da CLI a cada turno.

**Tech Stack:** Bun + TypeScript, Drizzle (Postgres; testes em PGlite), Hono + zod-openapi, React (web), React Native/Expo (phone), `@agenteschat/i18n`.

**Spec:** não há spec separada. A decisão de produto está na conversa de 2026-11-13 e vira o ADR da Task 0. Referências: ADR 0041 (§"Account", l.67 e l.95), ADR 0059 (§3, §156; emenda de 2026-11-12, `servingPlanFor`), ADR 0053 §6.4 (sem fallback em background), issues upstream #319 e #320.

## Decisões assumidas (cada uma com o custo de reverter)

| # | Decisão | Alternativa | Custo de reverter |
|---|---|---|---|
| D1 | Grupo pertence a **um computador** (`brain_groups.machine_id`), e os membros são contas desse computador | Grupo do workspace, filtrado pelo computador do agente | Médio: coluna e validação. Motivo da escolha: `brainAccountFor` exige a conta no computador do agente (`select.ts:553`), e o frame do runner é por computador |
| D2 | **Uma conta por provedor**, chave `coalesce(provider, kind)` com índice único. Duas assinaturas Claude são recusadas | Permitir N do mesmo provedor | Baixo no código, **alto no risco**: ADR 0041 l.95 e ADR 0059 l.156 recusam rodízio de assinaturas, e isso pode violar os termos do provedor |
| D3 | Membro precisa ser conta **`shared`** (pensa por todos os agentes do dono), `active`, e utilizável pelo agente (`planIsOwners`: serve todos ou é do dono do agente) | Aceitar login por agente | Baixo. `SHARED_SIGN_INS` é `true` para claude_code, codex, antigravity e key (`plans.ts:546`), então no modo sistema isso cobre o caso real. Evita toda a regra `account.in_use` / `moveAccount` |
| D4 | Estratégia `order` (padrão) ou `room` (mais folga, `planRoom` de `machine-accounts.ts:168`) | Só ordem | Baixo |
| D5 | **Gruda na conversa:** o membro do último run da mesma conversa é preferido enquanto não estiver no limite | Escolher do zero a cada turno | Médio. Sem isso, `room` troca de provedor a cada turno e perde a sessão da CLI |
| D6 | `agents.brain_group_id` **sobrepõe** os campos `brain*` do agente sem apagá-los. Tirar o grupo volta à configuração anterior | Copiar o membro para os campos `brain*` | Baixo |
| D7 | Grupo esgotado = comportamento atual (`brainFallback` em run atendido; espera em background) | Fallback também em background | É a Fase 4, opcional, e precisa de emenda ao ADR 0053 §6.4 |
| D8 | Turno cortado no meio por `plan_limit` continua estacionando como hoje. O próximo turno já escolhe outro membro | Retomar na hora em outro membro | É a Fase 3, porque refazer ferramentas já executadas é risco (`executor.ts:3220-3223`) |
| D9 | Braço direito fica **fora** na v1 | Incluir | O braço direito já tem `servingPlanFor` e regras próprias (ADR 0137 §7, §11) |
| D10 | Modelo e esforço **por membro** (`model` null = `auto`) | Um modelo para o grupo | Baixo. Modelos não são intercambiáveis entre provedores |

## Global Constraints

- Migrations são imutáveis. Gerar com `bun run db:generate brain_groups`, que deve virar `0266_brain_groups.sql` (a última hoje é `0265_right_hand_proactive.sql`).
- Toda tabela do tenant tem `org_id`, e um teste verifica isso.
- Operadores Drizzle vêm de `@agenteschat/db`, nunca de `drizzle-orm`.
- Texto para o usuário passa por `packages/i18n` (`en.ts` e `pt-BR.ts`). O phone reutiliza essas chaves.
- Comentários públicos citam o ADR novo (`0180`), nunca este plano.
- Antes de dar por pronto: `bun run lint`, `bun run typecheck`, `bun run check:boundaries`, `bun test <arquivos tocados>`. No fim, `bun run ci:local`.
- Conventional Commits com escopo (`feat(engine): …`). Push no fork a cada commit (`git push origin <sha>:refs/heads/feat/brain-groups`).

## Review Focus

1. **Conta do grupo removida ou desconectada** com o agente no meio da conversa: o próximo turno pula para o próximo membro, sem `no_ai` enquanto houver outro membro ativo. Teste na Task 3.
2. **Todos os membros no limite**: o run atendido cai na chave do workspace (`brainFallback`), e o de rotina espera com o `resetsAt` **mais próximo** entre os membros, não o do primeiro. Testes nas Tasks 3 e 5.
3. **Agente muda de computador** com grupo atribuído: o grupo é desligado do agente, como `brainAccountId` já é limpo (`agents.ts:215`). Teste na Task 6.
4. **Dono muda o `serves` da conta para "Só eu"**: o membro deixa de valer para agentes de outras pessoas, e o resolvedor pula ele. Teste na Task 3.
5. **Estratégia `room` alternando** entre dois membros com uso parecido: a regra de grudar (D5) segura o membro da conversa. Teste na Task 3.

---

## Fase 0: decisão (antes de código)

### Task 0: ADR 0180 e conversa upstream

**Files:**
- Create: `docs/adr/0180-brain-groups.md`
- Modify: `docs/adr/README.md` (linha da tabela, depois da 0179)

- [ ] **Step 1:** escrever o ADR no formato da 0176: `Status: Proposed`, `Amends: ADR 0041 (an agent may move between the accounts of a group its owner made, one per provider), ADR 0059 §156`. Seções Context, Decision (D1–D10, nas palavras do ADR) e Consequences. O ADR diz com todas as letras que duas contas do mesmo provedor nunca entram num grupo, e por quê.
- [ ] **Step 2:** rascunhar o comentário na issue upstream #319, propondo D1–D10 e linkando o ADR. **Publicar só com o ok do usuário.**
- [ ] **Step 3:** commit `docs(adr): 0180 brain groups, one account per provider` e push no fork.

Portão: se o upstream recusar, o usuário decide entre seguir num fork próprio e parar aqui.

---

## Fase 1: motor (entregável: agente com grupo resolve o membro certo; nada na tela ainda)

### Task 1: schema e migration

**Files:**
- Create: `packages/db/src/schema/brain-groups.ts`
- Modify: `packages/db/src/schema/index.ts` (adicionar `export * from "./brain-groups"`)
- Modify: `packages/db/src/schema/agents.ts:220` (nova coluna, ao lado de `brainAccountId`)
- Modify: `packages/db/src/schema/runtime.ts` (`agent_runs.brain_account_id`)
- Create: `packages/db/migrations/0266_brain_groups.sql` (gerada)
- Test: `packages/db/test/brain-groups-schema.test.ts`

**Interfaces:**
- Produces:
  - `brainGroups`: `id uuid`, `orgId`, `machineId`, `name text (≤40)`, `strategy text default 'order'` (check `in ('order','room')`), `createdBy text → users.id set null`, `createdAt`, `updatedAt`. PK `(org_id, id)`. FK `(org_id, machine_id) → machines` com cascade.
  - `brainGroupMembers`: `orgId`, `groupId`, `accountId`, `position int`, `providerKey text` (= `coalesce(provider, kind)` da conta, gravado pelo motor), `model text null`, `effort text null`. PK `(org_id, group_id, account_id)`. Únicos `(org_id, group_id, position)` e `(org_id, group_id, provider_key)`. FKs `(org_id, group_id) → brain_groups` cascade e `(org_id, account_id) → machine_accounts` cascade.
  - `agents.brainGroupId uuid null`, FK `(org_id, brain_group_id) → brain_groups` com `on delete set null`, e índice `(org_id, brain_group_id)`.
  - `agentRuns.brainAccountId uuid null`: a conta com que o run pensou por último (D5).

- [ ] **Step 1: teste que falha.** `test("a group holds one account per provider, and goes with its computer")`: insere grupo e membro Claude. Um segundo membro com o mesmo `providerKey` rejeita (violação do índice único). Apagar a máquina apaga grupo e membros. Apagar a conta apaga só o membro.
- [ ] **Step 2:** `bun test packages/db/test/brain-groups-schema.test.ts`. Esperado: FAIL, `brainGroups` não exportado.
- [ ] **Step 3:** escrever o schema e rodar `bun run db:generate brain_groups`.
- [ ] **Step 4:** rodar o teste de novo (PASS), mais o teste do repo que exige `org_id` (`bun test packages/db`).
- [ ] **Step 5:** commit `feat(db): brain groups and their members (ADR 0180)`.

### Task 2: CRUD de grupos no motor

**Files:**
- Create: `packages/engine/src/brains/groups.ts`
- Modify: `packages/engine/src/index.ts` (exportar)
- Test: `packages/engine/test/brain-groups.test.ts`

**Interfaces:**
- Produces:
  - `type BrainGroupStrategy = "order" | "room"`
  - `interface BrainGroupMemberInput { accountId: string; model?: string | null; effort?: string | null }`
  - `interface BrainGroupView { id; machineId; name; strategy; members: { accountId; label; kind; provider: string | null; model: string | null; effort: string | null; status; usage: PlanUsage | null }[]; usedBy: { id; name }[]; canEdit: boolean }`
  - `listBrainGroups(db, userId, orgId): Promise<BrainGroupView[]>`
  - `createBrainGroup(db, userId, orgId, input: { machineId; name; strategy?; members: BrainGroupMemberInput[] }): Promise<BrainGroupView>`
  - `updateBrainGroup(db, userId, orgId, groupId, input: Partial<…>)`. Os membros chegam como lista completa e ordenada, e a posição é o índice.
  - `deleteBrainGroup(db, userId, orgId, groupId)`
  - Códigos de erro: `brain_group.same_provider`, `brain_group.not_shared`, `brain_group.other_computer`, `brain_group.not_yours` (conta que não serve a quem cria), `brain_group.empty`, `brain_group.not_editor`
- Regra de quem edita: quem criou, ou admin (`can(membership, …)`, a mesma chave que gerencia agentes). Auditar com `recordAudit` (`brain_group.create|update|delete`).

- [ ] **Step 1: testes que falham.**
  - `test("a group takes one account of each provider on its computer")`: Claude + Codex criados. Um segundo Claude → `brain_group.same_provider`.
  - `test("only shared accounts that serve the person join a group")`: login por agente → `brain_group.not_shared`; conta de outra pessoa com `serves: "owner"` → `brain_group.not_yours`; conta de outro computador → `brain_group.other_computer`.
  - `test("only its creator or an admin changes a group")`.
- [ ] **Step 2:** rodar e confirmar FAIL.
- [ ] **Step 3:** implementar. A validação de conta reaproveita `planIsOwners` (`select.ts:589`) e `servesOf`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(engine): create and edit brain groups (ADR 0180)`.

### Task 3: escolha do membro (`pickGroupMember`, `withGroupBrain`)

**Files:**
- Modify: `packages/engine/src/brains/groups.ts`
- Test: `packages/engine/test/brain-groups.test.ts`

**Interfaces:**
- Consumes: `planLimitOf(machineId, kind, accountId, usage, now)` (`select.ts:170`), `planRoom` (`machine-accounts.ts:168`), `planIsOwners` (`select.ts:589`)
- Produces:
  - `pickGroupMember(db, agent: Pick<Agent,"orgId"|"ownerUserId"|"machineId"|"brainGroupId">, opts: { threadRootId?: string; now?: number }): Promise<{ accountId; kind: BrainKind; model: string | null; effort: string | null; exhausted: boolean } | null>`
    - Elegíveis: membros com conta `active`, `shared`, no `agent.machineId`, e `planIsOwners` verdadeiro.
    - Com folga = `planLimitOf(...) === null`.
    - D5: se o último `agent_runs.brain_account_id` da mesma `threadRootId` for um elegível com folga, é ele.
    - Senão, `order` pega o primeiro com folga pela `position`, e `room` pega o de maior `planRoom` (empate vai pela `position`).
    - Nenhum com folga: devolve o elegível cujo limite reseta antes, com `exhausted: true`, para o caminho atual de `plan_limit` cuidar (fallback ou espera com o reset mais próximo).
    - Nenhum elegível: `null`.
  - `withGroupBrain<T extends ThinkingAgent>(db, agent: T, opts): Promise<T>`: sem `brainGroupId`, ou braço direito, devolve `agent`. Com membro, devolve `{ ...agent, brain: kind, brainModel: model ?? AUTO_MODEL, brainEffort: effort, brainAccountId: accountId, brainAccountLentBy: null }`. Com `null`, devolve `agent` sem mudança, ou seja, os campos `brain*` guardados (D6).

- [ ] **Step 1: testes que falham** (baseados no padrão de `right-hand-own-ai.test.ts:158`, que monta `usage` com `windows`):
  - `test("in order, the first member with room thinks; at its limit the next one does")`: Claude a 100% (`usedPercent: 100`) → Codex.
  - `test("by room, the roomiest member thinks")`: 90/10/50 → o de 10.
  - `test("a conversation keeps its member while it has room")`: run anterior da thread com Codex, e `room` preferiria Gemini → Codex. Codex no limite → Gemini.
  - `test("a member signed out, removed or kept to its owner is skipped")`: cobre os Review Focus 1 e 4.
  - `test("every member at its limit: the one back first, marked exhausted")`: cobre o Review Focus 2.
  - `test("the right hand and an agent with no group are themselves")`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(engine): an agent's group picks the member that thinks (ADR 0180)`.

### Task 4: ligar o grupo no caminho do run

**Files:**
- Modify: `packages/engine/src/brains/select.ts:71` (`recordRunBrain` passa a receber `accountId?`) e `:777` (`resolveBrain`: aplicar `withGroupBrain` logo depois de `thinkingAgent`)
- Modify: `packages/engine/src/executor.ts:1704` (aplicar `withGroupBrain` no agente do run) e os chamadores de `recordRunBrain` (gravar `plan.account?.id`)
- Modify: `packages/engine/src/ai-status.ts:123` (`agentAiState`: agente com grupo e algum membro elegível não está "sem IA")
- Modify: `packages/engine/src/machines.ts:674-730` (`machineAgents`: os membros do grupo entram em `accounts`, para o modo sistema emprestar as pastas ao usuário do agente, como já faz com o braço direito em `:717`)
- Test: `packages/engine/test/brain-groups-run.test.ts`

**Interfaces:**
- Consumes: `withGroupBrain` (Task 3)
- Produces: `recordRunBrain(db, runId, kind, accountId?: string | null)`; `agent_runs.brain_account_id` preenchido em todo turno de computador.

- [ ] **Step 1: testes que falham:**
  - `test("a run of an agent on a group thinks with the member's account and model")`: `resolveBrain(...)` → `{ kind: "codex", account: { id: CODEX }, model: "gpt-…" }`.
  - `test("the computer's frame lends every member of the agent's group")`: `machineAgents(...)` → `accounts` contém os membros.
  - `test("with every member at its limit, a person's run falls back to the workspace key")`: com `brainFallback: true` e chave no workspace, o run termina com `brainFallback` em `agent_run_steps`.
  - `test("with every member at its limit, a routine's run waits for the first reset")`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS, e rodar de novo `engine-brains.test.ts`, `right-hand-own-ai.test.ts` e `brain-settings.test.ts`, que não podem regredir.
- [ ] **Step 5:** commit `feat(engine): runs think with the agent's group (ADR 0180)`.

### Task 5: dar o grupo ao agente (`setAgentBrain` e view)

**Files:**
- Modify: `packages/engine/src/brain-settings.ts`:
  - `AgentBrainInput` (`:941`): `group?: string | null`
  - `setAgentBrain` (`:997`): validar com `brain_group.other_computer` se o grupo não é do computador do agente, e `brain_group.right_hand` no braço direito. Gravar `brainGroupId`.
  - Mudança de `machineId` limpa `brainGroupId` (Review Focus 3).
  - `getAgentBrain`/`view`: `group: { id; name; current: { accountId; label; kind } | null } | null`
  - `agentBrainSummaries` (`:1754`): resumo com o membro atual.
  - `AgentSetup` copia `group`.
- Test: `packages/engine/test/brain-settings.test.ts` (novos casos)

- [ ] **Step 1: testes que falham:**
  - `test("an agent takes a group of its computer, and drops it when it moves")`
  - `test("the brain view names the group and the member thinking now")`
  - `test("taking the group off brings back the account it had")` (D6)
- [ ] **Steps 2–4:** FAIL, implementar, PASS.
- [ ] **Step 5:** commit `feat(engine): give an agent a brain group (ADR 0180)`.

---

## Fase 2: API e telas (entregável: o usuário cria um grupo e o atribui na tela)

### Task 6: rotas

**Files:**
- Create: `apps/server/src/routes/app/brain-groups.ts`: `GET/POST /organizations/{orgId}/brain-groups`, `PUT/DELETE …/brain-groups/{groupId}`. Registrar no app.
- Modify: `apps/server/src/routes/app/agents.ts:1896-1931` (body do `PUT …/brain`: `group: z.string().uuid().nullable().optional()`)
- Modify: `apps/server/src/routes/app/schemas.ts:976` (`AgentBrain.group`), `:1060` (`AgentSetup.group`), e o novo `BrainGroup`
- Modify: `apps/server/test/operator-openapi.json` (se tocar o operador; senão, nada)
- Test: `apps/server/test/brain-groups.test.ts` (harness `createTestServer`, `seedOrg`, `pairComputer`)

- [ ] **Step 1: teste que falha.** `test("a member creates a group of their plans and gives it to their agent")`: POST → 201; PUT `brain` com `group` → 200 e `group.id`; GET `brain` → `group.current`. Segundo Claude → 409 `brain_group.same_provider`. Agente mudando de computador → `group: null` (Review Focus 3).
- [ ] **Steps 2–4:** FAIL, implementar, PASS.
- [ ] **Step 5:** publicar `publishMachineAgentsChanged` ao mudar membros, para o runner receber o novo frame. Commit `feat(server): brain group routes (ADR 0180)`.

### Task 7: cliente compartilhado

**Files:**
- Modify: `packages/client/src/api/types.ts` (`BrainGroup`, `AgentBrain.group`, `AgentBrainInput.group`)
- Modify: `packages/client/src/api/http-client.ts` (`brainGroups.list|create|update|remove`)
- Modify: `packages/client/src/api/keys.ts`, `queries.ts` (`useBrainGroups`, mutações que invalidam `agentBrain` e `brainGroups`)
- Create: `packages/client/src/lib/brain-groups.ts`:
  - `groupCandidates(accounts, machineId, userId)`: contas `shared`, ativas, do computador, que servem a pessoa, agrupadas por provedor
  - `groupProviderKey(account)`
  - `groupLine(group)`: "Claude → Codex → Gemini · em ordem"
- Test: `packages/client/test/brain-groups-lib.test.ts`

- [ ] TDD como acima: candidatos excluem login por agente e conta "Só eu" de outra pessoa; dois Claude aparecem como alternativas do mesmo provedor, não como dois membros. Commit `feat(client): brain groups (ADR 0180)`.

### Task 8: web, card "Grupos" em IA e uso

**Files:**
- Create: `apps/web/src/components/ai/BrainGroups.tsx`: `BrainGroupsCard` (lista de grupos, linha `groupLine`, "Novo grupo") e `BrainGroupDialog` (nome, computador, estratégia `Segmented` Em ordem / Mais folga, membros reordenáveis com `ProviderLogo` + `Meter`, modelo por membro reutilizando o `PickList` de `pages/agent/brain/pieces.tsx:237`)
- Modify: `apps/web/src/pages/SettingsPage.tsx:1124` (`UsageSection`: o card entre `PlanUsageCards` e `ApiCard`)
- Modify: `packages/i18n/src/en.ts`, `pt-BR.ts`: prefixo novo `brainGroups.*`
- Test: `apps/web/test/brain-groups.test.tsx` (`createFakeApi`, `renderApp`); estender `fakes/machines.ts`

- [ ] TDD: criar o grupo, reordenar, e ver o erro de mesmo provedor com o texto do i18n.
- [ ] Seguir `.claude/skills/ui-polish` do repo e olhar a tela (screenshot) antes de dar por pronto.
- [ ] Commit `feat(web): brain groups in AI and usage (ADR 0180)`.

### Task 9: web, "Quem pensa" escolhe um grupo

**Files:**
- Modify: `apps/web/src/pages/agent/brain/state.tsx:76` (`BrainRow.kind` ganha `"group"`; linhas de grupo vindas de `useBrainGroups`, filtradas pelo computador)
- Modify: `apps/web/src/pages/agent/brain/BrainDialog.tsx`: `saveRow` (`:223`) envia `{ group }`. A tela "glance" mostra `group.current` e "pensando com Codex agora". A tela "limit" (`:822`) mostra a ordem do grupo em vez de `offers` quando há grupo.
- Modify: `apps/web/src/components/ai/ModelPicker.tsx`: com grupo, o picker in-place leva ao grupo, sem trocar a conta.
- Test: `apps/web/test/agent-brain-dialog.test.tsx` (casos novos com `brainDialog`, `pickRow`)

- [ ] TDD mais screenshot. Commit `feat(web): an agent thinks with a brain group (ADR 0180)`.

### Task 10: phone

**Files:**
- Modify: `apps/mobile/src/features/ai/AgentAiScreen.tsx` (linha de grupo na lista, `useSaveBrain` com `group`) e `logic.ts` (`accountInput` aceita grupo)
- Create: `apps/mobile/src/features/ai/BrainGroupScreen.tsx` mais a rota `app/(app)/brain-group/[id].tsx`. Seção "Grupos" em `AiAccountsScreen.tsx`.
- Test: `apps/mobile/test/features/agent-ai.test.ts`

- [ ] TDD. Commit `feat(mobile): brain groups (ADR 0180)`.

---

## Fase 3 (opcional): trocar de membro no meio do turno

### Task 11

- Em `executor.ts:3674` (`waitForUsage`), quando o corte é `plan_limit` e o agente tem grupo com outro membro com folga: em vez de estacionar até o reset, reenfileirar o run agora. O próximo `resolveBrain` escolhe o outro membro e reenvia `interruptedTurn.prompt` numa sessão nova, com a lista `executed` no prompt, para o agente não repetir o que já fez.
- Teste: `test("a turn its plan cut goes on at once on the group's next member, told what already ran")`.
- **Risco:** o motor hoje recusa refazer turno com ferramentas executadas (`executor.ts:3220-3223`). Isso precisa de uma linha própria no ADR 0180.

## Fase 4 (opcional, precisa do upstream): fallback em trabalho sem ninguém olhando

### Task 12

- Nova coluna `agents.brain_fallback_unattended boolean default false`, mais um teto mensal (reaproveitar o orçamento do agente, ADR 0118).
- `mayFallBack` (`select.ts:79`) passa a aceitar background e `workId` quando ela está ligada.
- **Exige** emenda ao ADR 0053 §6.4, que proíbe isso de propósito.

---

## Verificação final (REGRA ZERO)

Promessa: *"o Theo, no grupo Claude AAWZ → Gemini, continua respondendo quando o Claude bate o limite, e só cai no OpenRouter quando os dois acabam"*.

1. `bun run ci:local` verde.
2. Subir a imagem do fork na instância local (`~/agentes`), atrás de uma tag própria, sem tocar no banco de produção (`bun run dev` com `DATABASE_URL` próprio, ou um compose separado).
3. Criar o grupo na tela, atribuir ao Theo, forçar o Claude no limite (gravar `usage` limitado na conta de teste) e mandar mensagem. Esperado: responde pelo Gemini, e `agent_runs.brain_account_id` mostra o Gemini.
4. Os dois no limite: com `brainFallback` ligado, responde pela chave; com ele desligado, espera e mostra o reset mais próximo.
5. O que não puder ser exercitado é declarado como **não verificado**.
