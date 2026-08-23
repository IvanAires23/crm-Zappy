# Plano de arquitetura escalável — crm-Zappy

> Escrito em 23/08/2026, a partir de uma leitura completa de `src/`,
> `prisma/schema.prisma`, `docker-stack.yml` e `.github/workflows/ci.yml`.
> Objetivo: sair de "funciona pra um cliente" para "aguenta dezenas de
> clientes trocando mensagem ao vivo, com resposta rápida".

---

## 0. Resumo executivo — as 5 decisões que mudam tudo

Se você só puder fazer cinco coisas, faça estas, nesta ordem:

| # | Decisão | Ganho esperado |
|---|---------|----------------|
| 1 | **Trazer o Postgres pra perto da aplicação** (mesma máquina ou mesma rede privada, em vez do Supabase remoto) | 5× a 50× em quase toda rota. É o maior ganho isolado disponível. |
| 2 | **Desligar o `pino-pretty` em produção** e cachear no Redis o que hoje é lido do banco a cada mensagem | 20–40% de CPU nos workers, ~3 round-trips a menos por mensagem |
| 3 | **API com 2+ réplicas, sem `node.role == manager`** (ela já é stateless — o Socket.io já funciona multi-réplica pelo pub/sub do Redis) | Deploy sem downtime + dobra a capacidade de request |
| 4 | **Shardar o worker do Baileys por tenant** e subir o limite de memória dele | Hoje ele é um ponto único de falha e trava em ~10 tenants |
| 5 | **Métricas de verdade** (p95 por rota, tamanho de fila, lag do worker) antes de comprar VPS maior | Você para de comprar máquina no escuro |

---

## 1. Diagnóstico: onde o projeto está hoje

### O que já está bom (não mexa)

O código está mais maduro do que o `CLAUDE.md` sugere. Já existe:

- **Paginação por cursor** em conversas e mensagens (`conversations.routes.ts:85` e `:144`) — feita do jeito certo, com `take: limit + 1` e `nextCursor`.
- **Tempo real de verdade**: Socket.io na API + Redis pub/sub (`realtime/socket.ts`, `realtime/bus.ts`). O desenho está correto — os workers publicam no Redis e a API re-emite. Isso já é seguro pra múltiplas réplicas.
- **Webhook responde 200 na hora e enfileira** (`webhook.routes.ts`) — exatamente o padrão certo, com validação de HMAC antes.
- **Idempotência** via `WebhookEvent.whatsappEventKey`.
- **Migrations versionadas + CI que valida schema vs migrations** — isso é raro e vale ouro.
- **Índices compostos coerentes** com as queries mais quentes (`(tenantId, lastMessageAt)`, `(conversationId, createdAt)`).
- **Isolamento por tenant** aplicado com disciplina em todas as rotas.

A fundação está sólida. O que falta é quase todo **infraestrutura e caminho quente**, não redesenho.

### O gargalo #1, que domina todos os outros: latência do banco

Hoje o Postgres está no **Supabase**, fora da VPS. Isso significa que cada
query paga um round-trip de rede. Ordem de grandeza:

| Onde está o Postgres | RTT por query |
|---|---|
| Supabase em outra região (ex: `us-east-1`) | **100–160 ms** |
| Supabase em São Paulo, VPS em São Paulo (provedores diferentes) | 8–30 ms |
| Postgres na rede privada da mesma nuvem | 0,3–1 ms |
| Postgres na mesma máquina (socket local) | 0,1–0,3 ms |

Agora conte quantas queries cada operação faz:

**`GET /conversations`** (a tela que o atendente mais usa) faz ~5 round-trips:
o `findMany` de conversas, mais os `include` de `contact`, `assignedUser` e
`messages` (o Prisma resolve `include` como queries separadas), mais o
`getTenantProvider()`.

> A 130 ms por query: **~650 ms** só de rede, antes de o Postgres fazer
> qualquer trabalho.
> A 0,5 ms: **~3 ms**.

**Uma mensagem inbound no `webhook.worker.ts`** faz ~10 round-trips
sequenciais: `findUnique` da conta, `findUnique` + `upsert` do
`WebhookEvent`, `upsert` do contato, `findFirst` da conversa, `create` da
mensagem, `update` da conversa, `update` do evento, `findMany` das regras
de chatbot.

> A 130 ms: **~1,3 s por mensagem**. Com `concurrency: 10`, o teto é
> **~7 mensagens por segundo** — e isso já é o limite físico do worker,
> não importa quantas réplicas de API você suba.
> A 0,5 ms: ~15 ms por mensagem, ou **~600 msg/s** no mesmo worker.

**Essa é a explicação de "o sistema é lento".** Nenhuma otimização de
código compete com trocar 130 ms por 0,5 ms. Antes de reescrever qualquer
coisa, resolva isso.

---

## 2. Os gargalos concretos no código

Listados por impacto. Cada um tem arquivo e o que fazer.

### P0 — Impedem escalar agora

**2.1 · `pino-pretty` ligado em produção**
`server.ts:36`, `workers/webhook.worker.ts:11`, `workers/outbound.worker.ts:12`,
`automation.worker.ts:17`, `baileysManager.ts:8`.

O `pino-pretty` formata log colorido de forma síncrona. Em produção isso é
puro desperdício de CPU — e num worker que loga por mensagem, é significativo.
Deve ser JSON puro (o que o Docker/Loki/Sentry consomem melhor de qualquer forma).

```ts
// padrão a aplicar nos 5 lugares
const isDev = process.env.NODE_ENV !== "production";
const logger = pino(isDev ? { transport: { target: "pino-pretty" } } : {});
```

**2.2 · Zero cache — o mesmo dado é lido do banco a cada mensagem**

- `getTenantProvider()` (`whatsapp/client.ts:38`) — uma query por listagem de conversas.
- `getTenantAccount()` (`whatsapp/client.ts:22`) — uma query por mensagem enviada.
- `prisma.chatbotRule.findMany()` (`webhook.worker.ts:174`) — uma query por mensagem recebida.
- `tenantWhatsappAccount.findUnique()` (`webhook.worker.ts:36`) — uma query por evento de webhook.

Nada disso muda com frequência. O Redis já está lá. Um cache com TTL de
30–60 s e invalidação explícita no onboarding elimina 3–4 round-trips do
caminho mais quente do sistema.

**2.3 · Prisma sem configuração de pool**
`db/prisma.ts` faz `new PrismaClient()` cru. O default do Prisma é
`num_cpus * 2 + 1` conexões **por processo**. Você tem 5 processos
(API + 4 workers). Numa máquina de 4 vCPU são 9 conexões × 5 = **45
conexões**, e cada réplica nova multiplica isso.

O pooler do Supabase (transaction mode) tem um limite bem menor do que
parece — quando estoura, o sintoma é timeout aleatório, não erro claro.

```
# DATABASE_URL em produção
?pgbouncer=true&connection_limit=10&pool_timeout=20&connect_timeout=10
```

E dimensione: `connection_limit × nº de processos ≤ limite do pooler − folga`.

**2.4 · O worker do Baileys é um ponto único de falha e um teto rígido**
`docker-stack.yml` fixa `crm_worker_baileys` em `replicas: 1` com
`memory: 512M`. Correto pela lógica atual (um socket por tenant, em
memória, no processo) — mas:

- Uma sessão Baileys consome **50–150 MB**. Em 512 MB você cabe **3 a 8
  tenants**. Depois disso o container é morto por OOM e *todos* os tenants
  caem juntos.
- Deploy = todo mundo desconectado ao mesmo tempo.
- Não escala horizontalmente por construção.

**Correção:** sharding por tenant. Cada réplica assume só os tenants cujo
hash cai no seu shard:

```ts
// baileysManager.ts — na reconnectAll() e no listener de comandos
const SHARD_INDEX = Number(process.env.BAILEYS_SHARD_INDEX ?? 0);
const SHARD_COUNT = Number(process.env.BAILEYS_SHARD_COUNT ?? 1);

function ownsTenant(tenantId: string): boolean {
  const h = createHash("sha1").update(tenantId).digest().readUInt32BE(0);
  return h % SHARD_COUNT === SHARD_INDEX;
}
```

No Swarm, isso vira N serviços (`crm_worker_baileys_0`, `_1`, …), cada um
`replicas: 1` com seu `BAILEYS_SHARD_INDEX`. Suba a memória pra **2 GB** por
shard. A fila `whatsapp-unofficial-send` também precisa virar uma fila por
shard, ou o job pode cair no worker que não é dono do socket.

**2.5 · Dashboard carrega tabelas inteiras na memória do Node**
`dashboard.routes.ts:49–80`.

```ts
prisma.message.findMany({
  where: { tenantId, createdAt: { gte: from, lte: to } },
  select: { direction: true },   // ← puxa 1 linha por mensagem só pra contar
})
```

Com 300 mil mensagens no mês, isso transfere 300 mil linhas pela rede pra
fazer um `.filter().length` em JS. O mesmo vale pro `deal.findMany` sem
`take` e pro `dealStageHistory.findMany` sem limite.

Troque por agregação no banco:

```ts
prisma.message.groupBy({
  by: ["direction"],
  where: { tenantId, createdAt: { gte: from, lte: to } },
  _count: true,
})
```

As séries por dia devem virar um `$queryRaw` com `date_trunc('day', ...)
GROUP BY 1` em vez de `bucketByDay()` em JS.

**2.6 · O scheduler faz full scan cross-tenant a cada 5 minutos**
`automation.worker.ts:121`, `:143`, `:179`.

```ts
prisma.calendarEvent.findMany({
  where: { status: "scheduled", reminderSentAt: null,
           reminderMinutesBefore: { not: null }, startAt: { gt: now } },
  include: { contact: {...} },
})
// ...e depois filtra em JS quais realmente venceram
```

Três problemas: (a) não tem `tenantId`, então os índices `(tenantId, ...)`
existentes não servem — é *seq scan*; (b) puxa **todos os eventos futuros
de todos os tenants** pra filtrar em memória; (c) roda a cada 5 min, pra
sempre, crescendo com a base.

Correção: índices parciais e filtro no banco.

```sql
CREATE INDEX CONCURRENTLY tasks_overdue_pending_idx
  ON tasks ("dueAt") WHERE status = 'pending' AND "overdueNotifiedAt" IS NULL;

CREATE INDEX CONCURRENTLY calendar_events_reminder_idx
  ON calendar_events ("startAt")
  WHERE status = 'scheduled' AND "reminderSentAt" IS NULL;

CREATE INDEX CONCURRENTLY scheduled_messages_due_idx
  ON scheduled_messages ("scheduledFor") WHERE status = 'pending';
```

E some `take: 500` em cada varredura — se tiver mais, o próximo tick pega.

**2.7 · Um tenant pode monopolizar a fila de envio**
`outbound.worker.ts` roda `concurrency: 5` numa fila FIFO global. Um tenant
disparando um broadcast de 20 mil contatos coloca 20 mil jobs na frente —
e as mensagens de conversa individual de *todos os outros tenants* ficam
atrás na fila.

Correções (podem coexistir):
- Fila separada para broadcast (`whatsapp-broadcast`), com worker próprio e
  concorrência menor.
- `priority` no BullMQ: mensagem de conversa com prioridade alta, broadcast baixa.
- Rate limit por tenant, respeitando o `messagingTier` da Meta (o campo já
  existe no schema e nunca é usado).

**2.8 · `removeOnFail: false` em três filas**
`queue/queue.ts` — jobs falhos ficam no Redis **para sempre**. É um vazamento
de memória lento e silencioso. Troque por
`removeOnFail: { age: 7 * 24 * 3600, count: 5000 }` e monte uma tela/rota de
inspeção de DLQ (ou aceite os 7 dias).

### P1 — Vão doer em breve

**2.9 · Proxy de mídia sem cache**
`media/media.routes.ts` — cada `<img>` na tela dispara **duas** chamadas à
Graph API (resolver a URL assinada + baixar os bytes). Rolar uma conversa
com 20 fotos = 40 chamadas à Meta. O comentário no arquivo diz que a URL
expira em minutos — verdade, mas **o arquivo não muda**.

Correção: object storage (Cloudflare R2, Backblaze B2 ou MinIO na sua VPS).
No primeiro acesso, baixa da Meta e grava; depois serve do storage com URL
assinada de curta duração. Elimina a Meta do caminho de leitura e permite
`Cache-Control` longo no navegador.

**2.10 · Sem índice pra busca textual**
`contacts.routes.ts:100` usa `contains` + `mode: insensitive` → vira
`ILIKE '%termo%'`, que **não usa índice B-tree**. Com 200 mil contatos, é
seq scan a cada tecla digitada.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY contacts_name_trgm_idx
  ON contacts USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY deals_title_trgm_idx
  ON deals USING gin (title gin_trgm_ops);
```

**2.11 · Paginação por `skip`/`offset` em contatos e deals**
`skip: (page - 1) * pageSize` — o Postgres precisa varrer e descartar todas
as linhas anteriores. Na página 500 isso é lento. Aceitável no CRM (ninguém
vai à página 500), mas o `count(*)` junto, sem cache, é o custo real. Se
incomodar: `count` aproximado ou cursor, como já é feito em conversas.

**2.12 · Índice faltando pra `(tenantId, createdAt)` em `messages`**
O dashboard filtra `{ tenantId, createdAt: { gte, lte } }`, mas os índices
existentes são `(tenantId)` e `(conversationId, createdAt)`. Adicione
`@@index([tenantId, createdAt])`.

Idem `Conversation`: o `webhook.worker.ts` faz
`findFirst({ tenantId, contactId, status: { not: "closed" } })` — vale
`@@index([tenantId, contactId, status])`.

**2.13 · API travada em 1 réplica no nó manager**
`docker-stack.yml`: `replicas: 1` + `node.role == manager`. A API já é
stateless (JWT, nenhum estado em memória) e o Socket.io já funciona
multi-réplica — cada réplica tem seu próprio subscriber do canal
`crm-realtime`, então todas re-emitem pros seus clientes. **Você pode subir
pra 2–3 réplicas hoje**, sem mudar código. Ganha deploy sem downtime
(`order: start-first` já está configurado) e o dobro de capacidade.

Ao fazer isso, ajuste o `connection_limit` do Prisma (ver 2.3).

**2.14 · `process.exit(1)` em `unhandledRejection`**
Presente nos 4 processos. Uma promise rejeitada em qualquer canto derruba o
worker inteiro, e os jobs em voo são perdidos (voltam por `stalled`, mas
com atraso). Em produção, prefira logar + Sentry e só derrubar em
`uncaughtException` de verdade.

**2.15 · Sem teste automatizado nenhum**
`tsc --noEmit` não pega regressão de lógica. Com 6.600 linhas e a base
crescendo, cada deploy é uma aposta. Ver Onda 3.

---

## 3. Arquitetura-alvo

### Princípio: três camadas que escalam independentemente

```
                         ┌──────────────┐
   navegador ─── wss/https ─┤   Traefik    │  TLS, roteamento, sticky opcional
                         └──────┬───────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        ┌─────▼─────┐    ┌──────▼────┐    ┌───────▼───────┐
        │  API × N  │    │  API × N  │    │   API × N     │  stateless
        │ (Fastify  │    │           │    │               │  escala por CPU
        │ + Socket) │    │           │    │               │
        └─────┬─────┘    └──────┬────┘    └───────┬───────┘
              └─────────────────┼─────────────────┘
                                │
                   ┌────────────▼────────────┐
                   │  Redis (fila + pub/sub) │  1 primário + AOF
                   └────────────┬────────────┘
                                │
        ┌───────────┬───────────┼───────────┬─────────────┐
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐  ┌─────▼──────┐
   │ webhook │ │outbound │ │broadcast│ │automation│  │ baileys ×S │  S = shards
   │  × N    │ │  × N    │ │  × N    │ │   × 1    │  │ (1 réplica │
   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘  │  por shard)│
        └───────────┴───────────┴───────────┴────────┴─────┬──────┘
                                                            │
                              ┌─────────────────────────────▼──┐
                              │ PostgreSQL primário            │
                              │ + PgBouncer                    │
                              │ + réplica de leitura (Fase C)  │
                              └────────────────────────────────┘
                              ┌────────────────────────────────┐
                              │ Object storage (mídia)         │
                              └────────────────────────────────┘
```

Regras que sustentam isso:

1. **API não guarda estado.** Já é verdade. Mantenha assim: nada de `Map`
   em memória na API, nada de sessão local. Tudo que precisa ser
   compartilhado vai pro Redis.
2. **Workers são idempotentes e escalam por réplica.** `webhook`,
   `outbound` e `broadcast` podem ter N réplicas hoje — a idempotência via
   `whatsappEventKey` já protege. **Exceções:** `automation` (o scheduler
   tick não pode rodar duas vezes) e `baileys` (dono do socket).
3. **Baileys é o único componente com afinidade.** Isole-o e sharde-o.
   Ele é o que impede o resto de escalar livremente.
4. **O banco é o recurso escasso.** Toda decisão de arquitetura deve
   reduzir round-trips e conexões, não aumentar.

### Sobre o scheduler tick (`automation` deve ficar em 1 réplica)

Se você replicar o `automation.worker`, o tick de 5 minutos roda N vezes e
manda lembretes duplicados. Duas saídas:

- **Simples:** manter `replicas: 1` e separar o *dispatch* de webhooks
  (que escala) do *scheduler* (que não escala) em dois processos.
- **Correta:** um lock distribuído no Redis (`SET lock:scheduler NX EX 300`)
  antes de cada tick. Aí pode replicar à vontade.

Faça a simples agora, a correta quando precisar de mais de uma réplica.

---

## 4. Dimensionamento de VPS — o que comprar, e quando

### Como pensar antes de olhar preço

Três perguntas decidem o tamanho:

1. **Quantos atendentes simultâneos?** Cada um mantém um WebSocket aberto.
   Node aguenta ~10 mil conexões ociosas por GB de RAM — não é isso que
   limita.
2. **Quantas mensagens por dia?** É isso que dimensiona os workers e o
   banco. 50 mil msg/dia é ~0,6 msg/s de média, mas o pico da hora comercial
   é 5–10× a média.
3. **Onde estão os usuários?** Chat ao vivo é sensível a latência de rede.
   Atendentes no Brasil + VPS na Europa = **+180 ms em cada clique**. Isso
   é percebido como "sistema lento" mesmo com o backend perfeito.

> **Recomendação de região: São Paulo.** O ganho percebido de estar perto do
> atendente é grande, e a Meta Cloud API é globalmente distribuída — o
> webhook não sofre. Provedores com região BR: Magalu Cloud, Vultr,
> Hostinger, Oracle Cloud, Latitude.sh (bare metal), AWS/GCP `sa-east-1`
> (mais caros). Hetzner é 3–5× mais barato mas não tem Brasil.

### Fase A — até ~15 tenants, ~50 atendentes, ~30 mil msg/dia

**1 VPS: 4 vCPU dedicado / 16 GB RAM / 160 GB NVMe**

Por que 16 GB e não 8: o Baileys. Sem Baileys (só Cloud API), 8 GB bastam.

Orçamento de RAM:

| Componente | RAM |
|---|---|
| PostgreSQL (`shared_buffers` 4 GB) | ~5 GB |
| Redis (com `maxmemory` 1 GB + política) | 1 GB |
| API × 2 | 0,8 GB |
| Workers webhook/outbound/automation | 1,2 GB |
| Baileys (1 shard, ~10 tenants) | 2 GB |
| Traefik + SO + folga | 2 GB |
| **Total** | **~12 GB de 16** |

**A mudança mais importante desta fase: o Postgres sai do Supabase e vem
pra essa máquina.** Você troca 130 ms por 0,2 ms em cada query. É o item
#1 do resumo executivo.

Isso tem um custo real: **backup passa a ser sua responsabilidade.** Não é
opcional:

```bash
# cron diário — pg_dump comprimido + envio pra object storage externo
0 3 * * * pg_dump -Fc $DB | age -r $KEY | rclone rcat r2:crm-backups/$(date +\%F).dump.age
```

Além disso: WAL archiving (permite *point-in-time recovery*), e **um teste
de restauração por mês** — backup que nunca foi restaurado não é backup.

Se você não quer essa responsabilidade agora, o meio-termo é **manter o
Supabase mas migrar o projeto pra região São Paulo**, e colocar a VPS em
São Paulo também. Cai de ~130 ms pra ~15 ms. É 8× melhor, contra os ~400×
de ter o banco local — mas o Supabase cuida do backup.

**Custo estimado:** VPS 4/16 em SP na faixa de **R$ 120–350/mês** dependendo
do provedor (Hostinger/Contabo na ponta baixa, Vultr/Magalu no meio,
AWS na alta). Confira o preço atual — isso muda.

### Fase B — 15 a 60 tenants, ~200 atendentes, 100–300 mil msg/dia

**2 VPS, ligadas por rede privada** (VPC do provedor, latência < 1 ms):

| Nó | Specs | Roda |
|---|---|---|
| `vps-data` | 4–8 vCPU / 32 GB / NVMe ≥ 300 GB | PostgreSQL + PgBouncer + Redis |
| `vps-app` | 8 vCPU / 16 GB | Traefik + API × 3 + workers + Baileys × 2 shards |

Por que separar: banco e aplicação competem por CPU e por *page cache* do
SO. Separar dá previsibilidade — quando a API sofre um pico, o banco não
sente. E permite crescer os dois de forma independente.

**PgBouncer vira obrigatório aqui.** Com 3 réplicas de API + 6 workers,
você tem ~10 processos abrindo pools. Sem PgBouncer em modo `transaction`,
o Postgres gasta mais tempo gerenciando conexão do que respondendo query.
Regra: `max_connections` do Postgres em ~200, PgBouncer com
`default_pool_size` 25, e o Prisma apontando pro PgBouncer com
`?pgbouncer=true&connection_limit=8`.

Tuning de Postgres pra 32 GB:

```
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 32MB
maintenance_work_mem = 2GB
random_page_cost = 1.1          # NVMe, não disco rotacional
effective_io_concurrency = 200
max_wal_size = 4GB
wal_compression = on
```

**Custo estimado:** **R$ 400–900/mês** para as duas.

### Fase C — 60 a 250 tenants, 500 mil+ msg/dia

**4–6 nós, Swarm com 3 managers** (quórum real; hoje você tem 1 manager,
que é um ponto único de falha do orquestrador):

| Nó | Papel |
|---|---|
| `db-primary` | 8–16 vCPU / 64 GB / NVMe ≥ 1 TB |
| `db-replica` | mesmo porte — streaming replication, serve leitura pesada (dashboard, relatórios, exportações) |
| `app-1`, `app-2` | 8 vCPU / 16 GB — API + Traefik |
| `worker-1` | 8 vCPU / 32 GB — filas + shards de Baileys |
| storage | S3/R2 externo pra mídia (não é VPS) |

Aqui entram coisas que não fazem sentido antes:

- **Réplica de leitura.** O `dashboard/overview` e o `export.csv` são as
  queries mais pesadas do sistema e não precisam de dado do último segundo.
  Um segundo `PrismaClient` apontando pra réplica isola esse tráfego.
- **Particionamento de `messages` por mês** (`PARTITION BY RANGE (createdAt)`).
  Em 50 milhões de linhas, o `VACUUM` e o índice começam a doer. Particionar
  transforma "apagar mensagem de 2 anos atrás" num `DROP PARTITION`
  instantâneo em vez de um `DELETE` de horas.
- **Política de retenção**: mensagem com mais de N meses vai pro storage
  frio. Sem isso, `messages` cresce pra sempre e é a tabela mais quente.
- **Redis Sentinel ou Redis gerenciado** — hoje o Redis é ponto único: se
  cair, filas e tempo real param juntos.

**Custo estimado:** **R$ 1.500–4.000/mês.**

### Tabela de decisão rápida

| Sinal que você observa | Ação |
|---|---|
| p95 de rota > 800 ms com CPU baixa | É latência de banco → Fase A, item 1 |
| CPU da API > 70% sustentado | Mais réplicas de API |
| Fila `whatsapp-webhook-events` cresce e não drena | Mais réplicas do worker de webhook |
| Fila `whatsapp-outbound-messages` cresce | Rate limit da Meta ou concorrência baixa — cheque antes de escalar |
| `pg_stat_activity` com muitos `idle in transaction` | Falta PgBouncer / pool mal dimensionado |
| RAM do worker de Baileys > 80% | Novo shard |
| Disco > 70% | Retenção de `messages` + `webhook_events` |

---

## 5. Plano de execução

### Onda 0 — Enxergar antes de agir (1 semana)

Não compre nada nem otimize nada antes disto. Você precisa de números.

- [ ] **Métricas Prometheus na API e nos workers.** `fastify-metrics` expõe
      p50/p95/p99 por rota. Nos workers, exporte tamanho de fila, jobs/s e
      duração de job. Grafana + Prometheus na própria VPS (~500 MB de RAM).
- [ ] **Logar duração de query.** Ative o middleware de `$on("query")` do
      Prisma em amostragem, ou `log_min_duration_statement = 200ms` no
      Postgres. Você vai descobrir quais rotas fazem 12 queries onde
      deveriam fazer 2.
- [ ] **Medir a latência real ao banco**:
      `time psql "$DATABASE_URL" -c 'SELECT 1'` da VPS, 20 vezes. Esse
      número decide o item 1 do resumo executivo.
- [ ] **`pg_stat_statements`** ligado, pra ranquear as queries por tempo total.
- [ ] **Alerta no Sentry** pra taxa de erro, e um alerta simples (n8n, que
      você já usa) pra fila acima de X jobs por mais de Y minutos.

**Critério de saída:** você consegue responder "qual rota é a mais lenta e
por quê" olhando um painel, sem adivinhar.

### Onda 1 — Latência e caminho quente (1–2 semanas)

- [ ] **Postgres pra perto** (mesma máquina ou mesma rede privada). Migração:
      `pg_dump -Fc` do Supabase → `pg_restore` no novo → trocar
      `DATABASE_URL` → `docker stack deploy` (lembre: `--force` sozinho não
      recarrega o `.env`). Faça em janela de baixo movimento e mantenha o
      Supabase intacto por uma semana como rollback.
- [ ] **Backup automatizado + primeiro teste de restore** (mesma semana, não depois).
- [ ] `pino-pretty` só em dev (item 2.1).
- [ ] `connection_limit` + `pgbouncer=true` na `DATABASE_URL` (item 2.3).
- [ ] Cache Redis de `tenantWhatsappAccount`, `provider` e `chatbotRule`
      (item 2.2), com invalidação no onboarding e no CRUD de chatbot.
- [ ] Índices novos: `(tenantId, createdAt)` em `messages`,
      `(tenantId, contactId, status)` em `conversations`, os três índices
      parciais do scheduler, e os índices trigram de busca.
      **Uma migration por mudança, `CREATE INDEX CONCURRENTLY`** — índice
      normal trava a tabela.
- [ ] `removeOnFail` com TTL nas filas (item 2.8).
- [ ] `@fastify/compress` — as respostas de conversas e deals são JSON
      grande e comprimem 5–10×.

**Critério de saída:** p95 de `GET /conversations` abaixo de 150 ms;
throughput do worker de webhook acima de 100 msg/s num teste de carga.

### Onda 2 — Escalar horizontalmente (1–2 semanas)

- [ ] API pra `replicas: 3`, remover `node.role == manager` (item 2.13).
      Valide que o tempo real continua funcionando com duas abas em réplicas
      diferentes.
- [ ] Separar `automation` em dois processos: dispatch (replicável) e
      scheduler (1 réplica, ou com lock no Redis).
- [ ] Shardar o Baileys (item 2.4), memória pra 2 GB por shard.
- [ ] Fila e worker dedicados pra broadcast (item 2.7), com prioridade.
- [ ] `resources.reservations` além de `limits` no `docker-stack.yml` — sem
      reserva, o Swarm agenda tarefas em nó sem RAM disponível.
- [ ] `restart_policy` explícito com `max_attempts` e `window`.
- [ ] Dashboard com `groupBy`/`$queryRaw` em vez de `findMany` (item 2.5).

**Critério de saída:** você derruba uma réplica da API em produção e nenhum
atendente percebe.

### Onda 3 — Confiança pra mudar rápido (2–3 semanas)

Isto é o que torna o sistema "mais limpo e independente": você deixa de ter
medo de mexer.

- [ ] **Testes de integração** com Vitest + Testcontainers (Postgres real,
      não mock). Priorize por risco:
      1. `webhook.worker` — idempotência, roteamento por tenant, chatbot
      2. `outbound.worker` — retry, marcação de `failed` só na última tentativa
      3. Isolamento de tenant: um teste que prova que tenant A não lê dado
         de tenant B em cada rota. Este é o teste mais valioso do repositório.
      4. Janela de 24h e diferença entre providers
- [ ] **Ambiente de staging** — uma VPS pequena (2 vCPU/4 GB) com o stack
      completo e um número de teste. Hoje você testa em produção.
- [ ] **Deploy por CI**: build da imagem no GitHub Actions, push pra
      registry, `docker service update` por SSH. Elimina o `git pull` +
      `docker build` manual na VPS (que também gasta CPU da máquina de
      produção pra compilar).
- [ ] **Health check real**: `/health` hoje devolve `{status:"ok"}` sem
      checar nada. Deve testar Postgres (`SELECT 1`) e Redis (`PING`) com
      timeout curto, e um `/ready` separado pro Swarm.

### Onda 4 — Mídia, custo e volume (contínuo)

- [ ] Object storage pra mídia com cache (item 2.9). R2 da Cloudflare não
      cobra egresso — relevante quando os atendentes carregam mídia o dia todo.
- [ ] Retenção: `webhook_events` com mais de 90 dias vira purga noturna.
      Essa tabela guarda o payload cru de **todo** evento e é a que mais
      cresce sem ninguém olhar.
- [ ] Rate limit por tenant respeitando `messagingTier` da Meta.
- [ ] Resolver a duplicidade de `TenantWhatsappAccount` entre providers
      (documentada no `CLAUDE.md`) antes de oferecer os dois em paralelo.

### Onda 5 — Independência estratégica

- [ ] **Sair do Baileys como caminho principal.** Ele é útil como ponte
      enquanto o App Review não sai, mas para um produto pago é um risco:
      é engenharia reversa não autorizada do WhatsApp, o número do cliente
      pode ser banido, e ele impõe afinidade de processo (o único componente
      da sua arquitetura que não escala livremente). Trate como plano B
      declarado, não como base.
- [ ] Multi-região só se você tiver clientes fora do Brasil. Antes disso,
      é complexidade sem retorno.

---

## 6. Metas de desempenho — o que perseguir

Defina isto como contrato e meça continuamente:

| Métrica | Meta |
|---|---|
| p95 `GET /conversations` | < 150 ms |
| p95 `GET /conversations/:id/messages` | < 120 ms |
| p95 `POST /conversations/:id/messages` (até o 201) | < 200 ms |
| Mensagem recebida na Meta → visível na tela | < 2 s |
| Lag da fila de webhook em pico | < 5 s |
| Disponibilidade da API | 99,5% (≈ 3,6 h/mês) |
| Erro 5xx | < 0,1% das requisições |

Sobre "mensagem visível na tela": esse caminho hoje é
Meta → webhook HTTP → BullMQ → worker → Postgres → Redis pub/sub → Socket.io
→ navegador. Cada salto é rápido; o que domina é o tempo do worker no
Postgres — de novo, latência de banco.

---

## 7. Custo consolidado

| Fase | Infra | Custo/mês estimado | Suporta |
|---|---|---|---|
| **A** | 1 VPS 4 vCPU / 16 GB | R$ 120–350 | ~15 tenants, 30 mil msg/dia |
| **B** | 2 VPS (app + dados) | R$ 400–900 | ~60 tenants, 300 mil msg/dia |
| **C** | 4–6 nós + storage + réplica | R$ 1.500–4.000 | ~250 tenants, 1 M msg/dia |

Extras que valem o dinheiro em qualquer fase:

| Item | Custo/mês | Por quê |
|---|---|---|
| Object storage (R2/B2) | R$ 15–80 | Backup + mídia; egresso zero na R2 |
| Sentry (já usa) | Grátis até certo volume | Já configurado |
| VPS de staging 2/4 | R$ 40–100 | Para de testar em produção |
| Uptime externo (UptimeRobot etc.) | Grátis–R$ 50 | Health check de fora não mente |

Os números são estimativas de ordem de grandeza — preços de VPS mudam com
frequência, confira no momento da compra.

---

## 8. O que **não** fazer

Vale registrar, porque são caminhos tentadores que custam caro sem retorno:

- **Não migre pra Kubernetes agora.** O Swarm que você tem resolve tudo
  até a Fase C. K8s adiciona um sistema inteiro pra operar e não resolve
  nenhum dos gargalos listados aqui.
- **Não parta pra microsserviços.** A separação API/workers que você já
  tem é exatamente a divisão certa pra este domínio. Quebrar mais só
  multiplica round-trips de rede.
- **Não troque o Prisma por SQL cru "por performance".** O gargalo é
  round-trip de rede e falta de índice, não o ORM. Use `$queryRaw`
  cirurgicamente nas 3–4 queries analíticas do dashboard, e pronto.
- **Não compre VPS maior antes da Onda 0.** Dobrar a CPU não conserta
  latência de rede — que é o problema real hoje.
- **Não adicione cache antes de medir.** Cache mal invalidado gera bug de
  "o cliente vê dado de outro" — o pior tipo possível num sistema
  multi-tenant.

---

## 9. Ordem de ataque, em uma linha

**Medir (Onda 0) → aproximar o banco e cortar round-trip (Onda 1) →
replicar API e shardar Baileys (Onda 2) → testes e staging (Onda 3) →
mídia e retenção (Onda 4) → reduzir dependência do Baileys (Onda 5).**

Ondas 0 e 1 sozinhas devem entregar a maior parte do "sistema mais rápido"
que você procura — e cabem em duas a três semanas, na VPS que você já tem.
