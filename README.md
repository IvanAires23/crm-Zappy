# WhatsApp CRM — Backend MVP (multi-tenant)

Esqueleto de backend em Node.js/TypeScript pra um CRM conectado à WhatsApp
Cloud API (oficial da Meta), já desenhado para multi-tenant (vários clientes
usando o mesmo app Meta, cada um com sua própria WABA/número).

## Arquitetura resumida

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
```

## Passo a passo pra rodar localmente

### 1. Pré-requisitos
- Node.js 20+
- Docker + Docker Compose

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
```
Preencha:
- `META_APP_ID` / `META_APP_SECRET`: do seu app único no Meta for Developers
- `META_CONFIG_ID`: ID da configuração do Facebook Login for Business (Embedded Signup)
- `META_WEBHOOK_VERIFY_TOKEN`: qualquer string secreta escolhida por você
- `TOKEN_ENCRYPTION_KEY`: gere com
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

### 3. Subir banco e redis
```bash
docker compose up -d postgres redis
```

### 4. Instalar dependências e rodar migrations
```bash
npm install
npm run prisma:migrate
```

### 5. Rodar a aplicação (3 processos separados)
```bash
npm run dev                 # API HTTP (webhook + onboarding + auth + conversas)
npm run worker:dev          # worker que processa eventos recebidos
npm run worker:outbound:dev # worker que processa envio de mensagens
```

### 5.1 Criar um usuário de teste (login)
```bash
npm run prisma:seed
```
Cria um tenant "demo" e o usuário `admin@demo.com` / senha `admin123`.

### 5.2 Rodar o frontend
O frontend vive em um projeto separado: `../whatsapp-crm-frontend`.
```bash
cd ../whatsapp-crm-frontend
cp .env.example .env
npm install
npm run dev
```
Abre em `http://localhost:5173`. Faça login com as credenciais do seed acima.
A variável `VITE_API_URL` no `.env` do frontend deve apontar pra URL desta API (padrão `http://localhost:3000`).

### 6. Expor o webhook publicamente (dev)
Use um túnel (ngrok, cloudflared etc.) apontando pra porta 3000 e configure
a URL `https://SEU_TUNEL/webhook` no painel do app no Meta for Developers,
junto com o `META_WEBHOOK_VERIFY_TOKEN`.

## Onboarding de um novo cliente (tenant)

1. Criar o `Tenant` no banco (via seed ou rota administrativa — não incluída
   neste esqueleto, é o próximo passo natural).
2. No frontend, disparar o fluxo do Facebook Login for Business
   (Embedded Signup) usando `META_APP_ID` e `META_CONFIG_ID`.
3. Ao receber o `code` no callback do `FB.login()`, chamar:
   ```
   POST /onboarding/whatsapp/complete
   { "tenantId": "...", "code": "...", "wabaId": "...", "phoneNumberId": "..." }
   ```
4. O backend troca o `code` por um token, registra o número e salva
   criptografado em `tenant_whatsapp_accounts`.

## O que NÃO está neste esqueleto (próximos passos)

- CRUD completo de tenants, contatos e conversas via API REST (hoje só há leitura de conversas/mensagens)
- Emissão de eventos em tempo real (Socket.io) pro frontend
- Descoberta automática de WABA/phone_number_id via
  `/me/owned_whatsapp_business_accounts` (hoje depende do frontend passar
  esses IDs, capturados no evento `FINISH` do Embedded Signup)
- Sincronização de status de template (`approved`/`rejected`) via webhook
  de template
- Testes automatizados
