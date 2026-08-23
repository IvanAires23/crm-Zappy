# crm-Zappy — Backend

CRM de WhatsApp multi-tenant. Fastify + Prisma + PostgreSQL + Redis/BullMQ,
integrado à Cloud API oficial da Meta. Este é o **backend**; o frontend vive
num repositório irmão, veja "Repositório irmão" no final.

## Arquitetura

```
Meta (Cloud API) --webhook--> [Fastify /webhook] --enfileira--> [Redis/BullMQ]
                                                                       |
                                                                       v
                                                          [Worker: webhook.worker.ts]
                                                          resolve tenant, persiste, idempotente
                                                                       |
                                                                       v
                                                                 [PostgreSQL]

[API REST] --enfileira envio--> [Redis/BullMQ] --> [Worker: outbound.worker.ts] --> Graph API
                                                --> [Worker: automation.worker.ts] --> webhooks de saída (n8n, etc.)
```

- **Multi-tenant real**: todo tenant compartilha o mesmo app único no Meta
  for Developers (`META_APP_ID`/`META_APP_SECRET`), mas cada um conecta seu
  próprio WABA/número via Embedded Signup. Toda query é filtrada por
  `tenantId` — nunca confie em um recurso sem checar o tenant do request.
- **Filas** (`src/queue/queue.ts`, BullMQ + ioredis): `whatsapp-webhook-events`,
  `whatsapp-outbound-messages`, `crm-automation-dispatch`, `crm-scheduler-tick`.
  O endpoint HTTP do webhook só empurra pra fila e responde 200 na hora —
  processamento pesado e idempotência ficam no worker.
- **Auth**: JWT (`jsonwebtoken`), payload `{ sub, tenantId, role }`, expira em
  8h, sem refresh (ver "Lacunas conhecidas"). Todo plugin de rota autenticado
  usa `app.addHook("preHandler", authenticate)` de `src/auth/auth.plugin.ts`,
  que popula `request.auth`.

## Estrutura de pastas (`src/`)

Uma pasta por domínio, cada uma com `*.routes.ts` registrado em
`src/server.ts`: `auth`, `onboarding`, `conversations`, `pipelines`, `deals`,
`tags`, `contacts`, `tasks`, `calendar`, `automation` (+ `rules.routes.ts`),
`templates`, `broadcasts`, `customFields`, `dashboard`,
`integrations/googleCalendar`, `notes`, `quickReplies`, `webhook`.

`workers/` roda como processo separado do servidor HTTP (ver scripts abaixo).

## Convenções

- **Zod em toda rota de entrada** (`safeParse`, nunca `parse` cru) — erro de
  validação vira `400` com `{ error: "<mensagem legível>" }`.
- **Nunca devolva o objeto `flatten()` do Zod direto como `error`** — vira
  `[object Object]` no front. Sempre extraia uma mensagem string (ver
  `firstZodMessage` em `customFieldDefinitions.routes.ts` como padrão).
- **Toda query Prisma é escopada por `tenantId`** (`request.auth.tenantId`).
  Não existe query "global" nas rotas de negócio.
- **Comentários em português, curtos, só quando explicam o "porquê"** (uma
  decisão não óbvia, uma pegadinha da API da Meta, etc.) — nunca o "o quê".
- **Schema muda só por migration.** Editou `prisma/schema.prisma`? Rode
  `npx prisma migrate dev --name <descrição>` — isso gera o SQL em
  `prisma/migrations/` e aplica no seu banco local. **Nunca use `prisma db
  push`** neste projeto: ele foi abandonado de propósito (ver "Deploy"), e
  o CI falha o PR se o schema mudar sem uma migration correspondente.
- **Sem testes automatizados ainda** — validação é `tsc --noEmit` +
  teste manual (curl/Playwright). Ver roadmap.

## Rodando localmente

```bash
cp .env.example .env        # preencha META_*, TOKEN_ENCRYPTION_KEY, etc.
docker compose up -d postgres redis
npm install
npx prisma migrate deploy    # aplica as migrations versionadas
npm run dev                  # API em :3000
npm run worker:dev           # noutro terminal — processa webhooks inbound
npm run worker:outbound:dev  # noutro terminal — processa envio outbound
npm run worker:automation:dev
```

Login de teste (seed): `admin@demo.com` / `admin123`.

Checagens antes de commitar: `npx tsc -p tsconfig.json --noEmit` e
`npx oxlint src`. O CI (`.github/workflows/ci.yml`) roda isso mais o
build e uma checagem de migrations em todo PR.

## Migrations

Convertido de `prisma db push` pra migrations versionadas em 23/08/2026,
depois de um incidente em produção causado exatamente pela falta delas
(coluna que o código já exigia, mas nunca tinha sido aplicada no banco real).

- **Criar uma migration nova**: `npx prisma migrate dev --name <descrição>`
  localmente, commitar a pasta gerada em `prisma/migrations/`.
- **Nunca edite um arquivo de migration já commitado** — se precisar
  corrigir algo, crie uma nova migration.
- **CI valida que schema.prisma e migrations nunca ficam dessincronizados**
  (aplica as migrations num Postgres limpo e compara com o schema via
  `prisma migrate diff --exit-code`) — é o mesmo tipo de checagem que teria
  pego o incidente de 22/08 antes do merge.
- A migration `0_init` é o **baseline**: representa o schema inteiro no
  momento em que migrations foram adotadas, gerada com
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
  --script` (não precisa de banco vivo pra gerar). Ela já está marcada como
  aplicada em produção — não precisa rodar de novo lá.

## Deploy (produção)

VPS própria rodando **Docker Swarm**, banco no **Supabase**, sem plataforma
gerenciada (Render/Railway/Vercel). Comandos reais usados no deploy:

```bash
cd ~/crm-Zappy
git pull
docker build -t crm-api:latest .
docker stack deploy --prune --detach=false --resolve-image never -c docker-stack.yml crm
docker service update --force crm_crm_api
docker service update --force crm_crm_worker_webhook
docker service update --force crm_crm_worker_outbound
docker service update --force crm_crm_worker_automation
```

- **`docker-entrypoint.sh`**: só o serviço `crm_crm_api` usa esse comando
  (`docker-stack.yml`); ele roda `npx prisma migrate deploy` (aplica as
  migrations pendentes, sem perguntar nada) e só então sobe
  `node dist/server.js`. Os workers sobem direto com `node dist/workers/*.js`,
  sem repetir o passo de migration (evita DDL concorrente de 4 processos no
  mesmo banco a cada deploy).
- **`healthcheck`** no serviço `crm_crm_api` bate em `http://127.0.0.1:3000/health`
  — sem ele o Swarm considerava "saudável" um container travado no meio da
  migration ou com a API não respondendo de verdade. **Use `127.0.0.1`, nunca
  `localhost`**: em Alpine, `localhost` pode resolver pra `::1` (IPv6)
  primeiro, e o server só escuta em IPv4 (`host: "0.0.0.0"`) — isso já
  matou um container saudável com "unhealthy container" (exit 137) na
  primeira vez que o healthcheck foi ligado.
- **`DATABASE_URL` vs `DIRECT_URL` (Supabase)**: `DATABASE_URL` usa o
  *Transaction pooler* (porta 6543) — é o que a app usa em runtime.
  `DIRECT_URL` é usada só por operações de schema (`migrate deploy`,
  `migrate dev`) e **precisa ser o *Session pooler*** (mesmo host do
  pooler, porta 5432), **nunca** a conexão direta
  (`db.<projeto>.supabase.co:5432`) — essa costuma exigir IPv6 e falha com
  `P1001: Can't reach database server` em VPS comuns. Painel Supabase:
  Settings → Database → Connection string → aba "Session pooler".
- **`env_file` do `docker-stack.yml` só é lido em `docker stack deploy`,
  não em `docker service update --force`**: esse `--force` só recria a
  task com o environment que já estava congelado no serviço desde o
  último `stack deploy` — editar o `.env` e rodar só `--force` não muda
  nada de verdade (já pegou a gente ao adicionar `FRONTEND_URL`: o CORS
  continuou bloqueando porque a variável nova nunca chegou no container).
  Depois de editar o `.env`, sempre rode `docker stack deploy` de novo
  (não só `--force`) pra recongelar as variáveis.
- **CORS depende de `FRONTEND_URL` bater exatamente com a URL real do
  frontend** (com `https://`, sem barra no final) — desde que o CORS
  deixou de ser `origin: true` (ver Fase 4 do roadmap), um `FRONTEND_URL`
  errado ou ausente no `.env` de produção derruba o login inteiro sem
  erro nenhum no backend (o preflight `OPTIONS` simplesmente não recebe o
  header de volta, e o navegador nunca chega a mandar o `POST`). Pra
  testar direto, sem depender do navegador:
  `curl -s -i -X OPTIONS https://api.agenciatalks.online/auth/login -H "Origin: <url-do-front>" -H "Access-Control-Request-Method: POST" | grep -i access-control-allow-origin`
  — se não vier nada, é isso.
- **Cuidado com rollback do Swarm**: se o `command:` de um serviço no
  `docker-stack.yml` mudar e o deploy falhar (ex: entrypoint sai com
  código != 0), o Swarm faz rollback **da definição do serviço inteira**,
  revertendo até o `command:` — não só o container. Depois disso, um
  simples `docker service update --force` só recria a task com a
  configuração antiga (sem passar pelo entrypoint de novo). Se isso
  acontecer, rode `docker stack deploy` de novo (não só `--force`) pra
  reaplicar o `docker-stack.yml` corrigido.
- Pra depurar sem afetar o serviço rodando, um container avulso (a rede do
  Swarm não é "attachable" por padrão, então rode sem `--network`, já que o
  banco é externo/Supabase):
  ```bash
  docker run --rm --env-file .env crm-api:latest npx prisma migrate deploy
  ```

## Modelos principais (`prisma/schema.prisma`)

`Tenant`, `TenantWhatsappAccount`, `User`, `Contact`, `Conversation`,
`Message`, `Note`, `QuickReply`, `Template`, `Broadcast`/`BroadcastRecipient`,
`WebhookEvent`, `Pipeline`/`PipelineStage`, `Deal`/`DealTag`/`DealStageHistory`,
`DealCustomFieldDefinition` (campos personalizados: `text`/`number`/`date`/
`select`/`multi_select`, valores ficam em `Deal.customFields` como JSON
chaveado pelo id da definição), `Tag`/`ContactTag`, `Task`, `CalendarEvent`,
`GoogleCalendarAccount`, `AutomationWebhook`/`AutomationRule`/`AutomationRuleRun`/
`AutomationDelivery`.

## Lacunas conhecidas / roadmap

Auditoria completa feita em 22-23/08/2026, comparando com CRMs consolidados
(Kommo, SocialHub, RMChat, Agendor). Documento completo publicado como
artifact — peça pro usuário o link se precisar, ou refaça a auditoria.

**P0 — impedem a operação real:**
- Chat não é ao vivo: `socket.io` está no `package.json` mas nunca é
  chamado, e não há polling. Mensagem nova só aparece com reload.
- `GET /conversations` e `GET /conversations/:id/messages` sem paginação —
  carregam tudo de uma vez.
- Janela de 24h da Meta não é tratada (texto livre fora da janela é
  rejeitado pela Meta sem mensagem clara pro atendente).
- Sem suporte a mídia (imagem/áudio/vídeo/documento) — só texto.
- ~~Deploy sem migrations versionadas, sem CI, sem healthcheck no Swarm,
  sem captura de erro~~ — **Fase 0 concluída em 23/08/2026**: CI
  (typecheck/build/lint/migrations em dia) + healthcheck (usando
  `127.0.0.1`, não `localhost` — ver nota abaixo) + migrations versionadas
  substituindo `db push` + Sentry (`src/config/sentry.ts`, `initSentry()`
  chamado no server e nos 3 workers; só ativa se `SENTRY_DSN` estiver
  setada). `app.setErrorHandler` no `server.ts` captura qualquer exceção
  que escape de uma rota antes de virar um 500 genérico no log.

**P1 — impedem operar em equipe:**
- Sem cadastro de usuários (só existe login; criar atendente é manual no banco).
- Sem contador de não lidas.
- Sem atribuição/transferência de conversa (o campo existe no schema, falta rota+tela).
- Papéis `admin`/`agent` existem no schema mas nenhuma rota valida permissão.

**P2 — qualidade:**
- Zero testes automatizados, zero CI.
- Sem rate limit, sem cabeçalhos de segurança, CORS aberto (`origin: true`).
- JWT expira em 8h sem refresh — sessão cai no meio do expediente.

Ordem sugerida de ataque: (0) fundação de deploy — migrations + CI +
healthcheck; (1) tempo real + paginação; (2) janela de 24h + mídia;
(3) atendimento em equipe (usuários, filas, atribuição, papéis);
(4) performance/polish; (5) diferenciais (chatbot, agendamento de
mensagem, relatórios).

## Repositório irmão

Frontend em `IvanAires23/Crm-Zappy-Frontend` (React 19 + Vite + TS), path
local típico `/home/user/crm-zappy-frontend`. Tem seu próprio `CLAUDE.md`.
Mudanças de API (rota nova, campo novo) quase sempre exigem tocar os dois
repositórios — checar `src/lib/api.ts` no frontend ao mexer numa rota aqui.
