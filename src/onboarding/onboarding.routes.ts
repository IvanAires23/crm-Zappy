import crypto from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { decryptToken, encryptToken } from "../config/crypto.js";
import { checkCoexistenceStatus, triggerSmbAppDataSync } from "../whatsapp/client.js";
import { authenticate, requirePermission } from "../auth/auth.plugin.js";
import { publishBaileysCommand } from "../whatsapp/baileysCommands.js";
import { clearLastError, getLastError, getLatestQr, isWorkerOnline } from "../whatsapp/baileysRuntime.js";

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

// O `code` do Embedded Signup expira rápido e o frontend fica com o botão em
// "Conectando..." enquanto esta rota não responde. Um fetch sem timeout contra
// a Graph API pode pendurar a requisição inteira, então cada chamada tem um
// limite próprio e vira um erro legível em vez de um travamento.
const GRAPH_TIMEOUT_MS = 15_000;

async function graphFetch(url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("A Meta não respondeu a tempo. Tente conectar novamente.");
    }
    // Falha de rede/DNS chega como um "fetch failed" que não diz nada pro usuário.
    throw new Error("Não foi possível falar com a Meta (graph.facebook.com). Tente conectar novamente.");
  }
}

const completeSignupSchema = z.object({
  code: z.string().min(1), // authorization code retornado pelo FB.login() no frontend
  // Os dois vêm do evento postMessage do Embedded Signup, que nem sempre
  // chega: quando o usuário já autorizou o app antes, a Meta mostra a tela
  // "continuar com as definições anteriores", devolve o code na hora e pula
  // o fluxo do WhatsApp — sem FINISH, sem waba_id. Por isso são opcionais e
  // o backend descobre os dois a partir do próprio token.
  wabaId: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
});

// Descobre as WABAs que o token concedeu, sem depender do postMessage do
// popup. O /debug_token devolve granular_scopes e, nos escopos de WhatsApp,
// os target_ids são exatamente os IDs das WABAs autorizadas.
async function resolveWabaIdFromToken(accessToken: string): Promise<string | undefined> {
  const url = new URL(`${GRAPH_BASE}/debug_token`);
  url.searchParams.set("input_token", accessToken);
  url.searchParams.set("access_token", `${env.META_APP_ID}|${env.META_APP_SECRET}`);

  const res = await graphFetch(url.toString());
  const json = await res.json().catch(() => ({}));

  const scopes: { scope?: string; target_ids?: string[] }[] = json?.data?.granular_scopes ?? [];
  const whatsappScope =
    scopes.find((s) => s.scope === "whatsapp_business_management") ??
    scopes.find((s) => s.scope === "whatsapp_business_messaging");

  return whatsappScope?.target_ids?.[0];
}

function firstZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.message}${issue.path.length ? ` (${issue.path.join(".")})` : ""}` : "Dados inválidos";
}

// Erros conhecidos do /register — viram mensagem acionável em vez do JSON
// cru da Meta.
function describeRegisterError(json: any): string {
  const code = json?.error?.code;
  if (code === 133005) {
    return (
      "Este número já tem verificação em duas etapas com outro PIN. No WhatsApp Manager, abra o número → " +
      "Verificação em duas etapas, desative (ou redefina) e conecte de novo."
    );
  }
  if (code === 133016) {
    return "A Meta bloqueou novas tentativas de registro deste número por 72h (limite de 10 tentativas). Tente depois.";
  }
  const detail = json?.error?.error_user_msg ?? json?.error?.message;
  return `Não foi possível registrar o número na Cloud API do WhatsApp${detail ? `: ${detail}` : ""}`;
}

interface FinalizeInput {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  displayPhoneNumber?: string;
  // Conexão manual: número que já está ativo na Cloud API não é
  // registrado de novo (re-registrar com outro PIN falharia com 133005).
  skipRegisterIfOnCloudApi?: boolean;
}

type FinalizeResult =
  | { ok: true; body: { connected: true; accountId: string; isCoexistence: boolean } }
  | { ok: false; error: string; details?: unknown };

// Etapa final comum ao Embedded Signup e à conexão manual: inscreve o app
// nos webhooks da WABA, registra o número (ou dispara a sincronização, em
// coexistência) e salva a conta com o token criptografado.
async function finalizeCloudApiConnection(log: FastifyBaseLogger, input: FinalizeInput): Promise<FinalizeResult> {
  const { tenantId, wabaId, phoneNumberId, accessToken } = input;

  // Número em coexistência (ativo também no WhatsApp Business App do
  // celular) muda os próximos passos.
  const { isOnBizApp, platformType } = await checkCoexistenceStatus(phoneNumberId, accessToken);

  // Sem inscrever o app na WABA do cliente, a Meta nunca manda os
  // webhooks dela pra nós — o número "conecta", mas mensagem recebida não
  // chega no CRM. Vale pros dois fluxos (normal e coexistência).
  const subscribeRes = await graphFetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!subscribeRes.ok) {
    const subscribeJson = await subscribeRes.json().catch(() => ({}));
    log.error({ subscribeJson, wabaId }, "Falha ao inscrever o app nos webhooks da WABA");
    return {
      ok: false,
      error: `Não foi possível ativar o recebimento de mensagens dessa conta${
        subscribeJson?.error?.message ? `: ${subscribeJson.error.message}` : ""
      }`,
    };
  }

  // PIN da verificação em duas etapas: reaproveita o que já geramos pra
  // esse número (re-conexão), senão cria um novo.
  const existingAccount = await prisma.tenantWhatsappAccount.findUnique({ where: { phoneNumberId } });
  const twoStepPin = existingAccount?.twoStepPinEncrypted
    ? decryptToken(existingAccount.twoStepPinEncrypted)
    : crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

  const alreadyOnCloudApi = input.skipRegisterIfOnCloudApi && platformType === "CLOUD_API";
  let savedPin: string | null | undefined = encryptToken(twoStepPin);

  if (isOnBizApp) {
    // Número em coexistência já está registrado — NÃO chamar /register
    // (a Meta rejeita/é desnecessário). Em vez disso, dispara a
    // sincronização de contatos e histórico; os dados chegam depois via
    // webhook (campos smb_app_state_sync e history).
    await triggerSmbAppDataSync(phoneNumberId, accessToken, "smb_app_state_sync");
    await triggerSmbAppDataSync(phoneNumberId, accessToken, "history");
    savedPin = null;
  } else if (alreadyOnCloudApi) {
    // PIN atual é desconhecido pra nós — mantém o que já estava salvo.
    savedPin = undefined;
  } else {
    const registerRes = await graphFetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      // A Meta exige o PIN de 6 dígitos — sem ele o registro falha.
      body: JSON.stringify({ messaging_product: "whatsapp", pin: twoStepPin }),
    });

    // O /register falhava em silêncio: a conta era salva como "conectada"
    // mesmo sem o número estar registrado na Cloud API, e o erro só aparecia
    // muito depois, na hora de enviar mensagem.
    if (!registerRes.ok) {
      const registerJson = await registerRes.json().catch(() => ({}));
      log.error({ registerJson, phoneNumberId }, "Falha ao registrar o número na Cloud API");
      return { ok: false, error: describeRegisterError(registerJson), details: registerJson };
    }
  }

  const data = {
    accessTokenEncrypted: encryptToken(accessToken),
    tokenStatus: "active",
    isCoexistence: isOnBizApp,
    platformType,
    ...(input.displayPhoneNumber ? { displayPhoneNumber: input.displayPhoneNumber } : {}),
  };
  const account = await prisma.tenantWhatsappAccount.upsert({
    where: { phoneNumberId },
    create: {
      tenantId,
      wabaId,
      phoneNumberId,
      ...data,
      twoStepPinEncrypted: savedPin ?? null,
      historySyncStatus: isOnBizApp ? "pending" : null,
    },
    update: {
      ...data,
      ...(savedPin !== undefined && !isOnBizApp ? { twoStepPinEncrypted: savedPin } : {}),
      historySyncStatus: isOnBizApp ? "pending" : undefined,
    },
  });

  // Conta oficial passa a ser a do tenant: uma sessão via QR Code do mesmo
  // tenant continuaria gravando as mesmas mensagens em dobro (ids diferentes
  // em cada provider) e disputando o envio.
  const unofficial = await prisma.tenantWhatsappAccount.updateMany({
    where: { tenantId, provider: "baileys", tokenStatus: "active" },
    data: { tokenStatus: "inactive" },
  });
  if (unofficial.count > 0) {
    await publishBaileysCommand({ tenantId, action: "logout" }).catch((err) =>
      log.error({ err, tenantId }, "Falha ao desconectar a sessão via QR Code")
    );
  }

  return { ok: true, body: { connected: true, accountId: account.id, isCoexistence: isOnBizApp } };
}

const manualConnectSchema = z.object({
  wabaId: z.string().trim().regex(/^\d+$/, "ID da conta do WhatsApp Business inválido (só números)"),
  accessToken: z.string().trim().min(20, "Token de acesso inválido"),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d+$/, "ID do número inválido (só números)")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function onboardingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Status atual da conexão WhatsApp do tenant logado.
  app.get("/onboarding/whatsapp/status", async (request, reply) => {
    // Pode haver uma conta oficial e uma via QR Code no mesmo tenant: a
    // ativa vale mais, e entre ativas a oficial.
    const accounts = await prisma.tenantWhatsappAccount.findMany({
      where: { tenantId: request.auth.tenantId },
    });
    const rank = (a: (typeof accounts)[number]) =>
      (a.tokenStatus === "active" ? 2 : 0) + (a.provider === "cloud_api" ? 1 : 0);
    const account = accounts.sort((a, b) => rank(b) - rank(a))[0];

    if (!account) {
      return reply.send({ connected: false });
    }

    // Só pra API não oficial: QR atual e último erro saem daqui também, pra
    // tela poder acompanhar por polling sem depender só do WebSocket.
    const baileys =
      account.provider === "baileys"
        ? {
            qr: account.baileysStatus === "qr_pending" ? await getLatestQr(request.auth.tenantId) : null,
            lastError: account.baileysStatus === "connected" ? null : await getLastError(request.auth.tenantId),
            workerOnline: await isWorkerOnline(),
          }
        : null;

    return reply.send({
      connected: account.provider === "baileys" ? account.baileysStatus === "connected" : true,
      account: {
        provider: account.provider,
        phoneNumberId: account.phoneNumberId,
        displayPhoneNumber: account.displayPhoneNumber,
        wabaId: account.wabaId,
        qualityRating: account.qualityRating,
        tokenStatus: account.tokenStatus,
        isCoexistence: account.isCoexistence,
        baileysStatus: account.baileysStatus,
      },
      baileys,
    });
  });

  // Inicia (ou reinicia) uma conexão via API não oficial (Baileys/QR Code).
  // Só publica o comando pro worker dedicado (que segura o socket de
  // verdade) e devolve na hora — o QR chega pro front pelo WebSocket
  // (evento "whatsapp:qr") e também em GET /status (polling), não na
  // resposta desta rota.
  app.post("/onboarding/whatsapp/unofficial/start", { preHandler: requirePermission("whatsapp.manage") }, async (request, reply) => {
    const tenantId = request.auth.tenantId;

    if (!(await isWorkerOnline())) {
      return reply.status(503).send({
        error:
          "O serviço que gera o QR Code (worker de Baileys) não está rodando no servidor. " +
          "Suba o serviço crm_crm_worker_baileys e tente de novo.",
      });
    }

    const existing = await prisma.tenantWhatsappAccount.findFirst({
      where: { tenantId, provider: "baileys" },
    });

    if (existing) {
      await prisma.tenantWhatsappAccount.update({
        where: { id: existing.id },
        data: {
          baileysStatus: "connecting",
          // Credenciais de uma sessão deslogada pelo celular já não valem:
          // reaproveitá-las fecha a conexão com 401 antes de emitir QR.
          ...(existing.baileysStatus === "logged_out" ? { baileysAuthState: null } : {}),
        },
      });
    } else {
      await prisma.tenantWhatsappAccount.create({
        data: {
          tenantId,
          provider: "baileys",
          phoneNumberId: `baileys:${tenantId}`,
          tokenStatus: "active",
          baileysStatus: "connecting",
        },
      });
    }

    await clearLastError(tenantId);
    await publishBaileysCommand({ tenantId, action: "start" });

    return reply.status(202).send({ started: true });
  });

  // Desconecta a sessão Baileys ativa (equivalente a "sair" do WhatsApp Web
  // pelo celular) — as credenciais antigas são invalidadas, uma nova
  // conexão exige escanear um QR novo.
  app.post("/onboarding/whatsapp/unofficial/logout", { preHandler: requirePermission("whatsapp.manage") }, async (request, reply) => {
    await publishBaileysCommand({ tenantId: request.auth.tenantId, action: "logout" });
    return reply.status(202).send({ loggedOut: true });
  });

  // Conexão sem o popup do Embedded Signup, com token de usuário do sistema
  // do próprio Business Manager. Necessária quando a WABA pertence ao mesmo
  // portfólio dono do app: o popup tenta "compartilhar" a conta com o
  // próprio portfólio e a Meta recusa (#1690130 "não é uma identificação
  // válida"). O token nunca é devolvido nem logado.
  app.post("/onboarding/whatsapp/manual", { preHandler: requirePermission("whatsapp.manage") }, async (request, reply) => {
    const parsed = manualConnectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const { wabaId, accessToken, phoneNumberId: requestedPhoneId } = parsed.data;

    const numbersRes = await graphFetch(
      `${GRAPH_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const numbersJson = await numbersRes.json().catch(() => ({}));
    if (!numbersRes.ok) {
      const detail = numbersJson?.error?.error_user_msg ?? numbersJson?.error?.message;
      return reply.status(400).send({
        error:
          "A Meta recusou o token para essa conta do WhatsApp Business. Confira se o usuário do sistema tem " +
          `acesso à WABA e as permissões whatsapp_business_management e whatsapp_business_messaging${
            detail ? ` (${detail})` : ""
          }.`,
      });
    }

    const numbers: { id: string; display_phone_number?: string; verified_name?: string }[] = numbersJson?.data ?? [];
    if (numbers.length === 0) {
      return reply.status(400).send({ error: "Essa conta do WhatsApp Business ainda não tem nenhum número cadastrado." });
    }

    const describe = (n: (typeof numbers)[number]) =>
      `${n.display_phone_number ?? "sem número"}${n.verified_name ? ` (${n.verified_name})` : ""} — ID ${n.id}`;
    let chosen = numbers[0];
    if (requestedPhoneId) {
      const match = numbers.find((n) => n.id === requestedPhoneId);
      if (!match) {
        return reply.status(400).send({
          error: `Esse ID de número não pertence a essa conta. Números disponíveis: ${numbers.map(describe).join("; ")}`,
        });
      }
      chosen = match;
    } else if (numbers.length > 1) {
      return reply.status(400).send({
        error: `Essa conta tem mais de um número — informe o ID do número. Disponíveis: ${numbers.map(describe).join("; ")}`,
      });
    }

    const result = await finalizeCloudApiConnection(request.log, {
      tenantId: request.auth.tenantId,
      wabaId,
      phoneNumberId: chosen.id,
      accessToken,
      displayPhoneNumber: chosen.display_phone_number,
      skipRegisterIfOnCloudApi: true,
    });
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }
    return reply.status(200).send(result.body);
  });

  // Chamado pelo frontend logo após o FB.login() do Embedded Signup retornar o `code`.
  // O `code` tem vida curta (~10 min), então essa troca precisa acontecer na hora.
  app.post("/onboarding/whatsapp/complete", { preHandler: requirePermission("whatsapp.manage") }, async (request, reply) => {
    const parsed = completeSignupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: firstZodMessage(parsed.error) });
    }
    const tenantId = request.auth.tenantId;
    const { code } = parsed.data;

    // 1) Trocar o code por um token de acesso de negócio
    const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", env.META_APP_ID);
    tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await graphFetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenJson.access_token) {
      request.log.error({ tokenJson }, "Falha ao trocar code por access_token");
      return reply.status(400).send({ error: "Falha ao autenticar com a Meta", details: tokenJson });
    }

    const accessToken: string = tokenJson.access_token;

    // 2) Descobrir a WABA quando o popup não mandou o waba_id.
    const wabaId = parsed.data.wabaId ?? (await resolveWabaIdFromToken(accessToken));

    if (!wabaId) {
      request.log.error({ tenantId }, "Token sem WABA associada nos granular_scopes");
      return reply.status(400).send({
        error:
          "A autorização da Meta não trouxe nenhuma conta do WhatsApp Business. " +
          "Refaça a conexão escolhendo 'Editar definições' no popup e conclua o cadastro do número.",
      });
    }

    // 3) Descobrir o phoneNumberId quando o frontend não mandou (caso do
    //    fluxo de coexistência, que só devolve o waba_id).
    let phoneNumberId = parsed.data.phoneNumberId;
    if (!phoneNumberId) {
      const numbersRes = await graphFetch(
        `${GRAPH_BASE}/${wabaId}/phone_numbers?access_token=${accessToken}`
      );
      const numbersJson = await numbersRes.json().catch(() => ({}));
      phoneNumberId = numbersJson?.data?.[0]?.id;

      if (!phoneNumberId) {
        request.log.error({ numbersJson, wabaId }, "Não achei phoneNumberId pra essa WABA");
        return reply.status(400).send({
          error:
            "A conta do WhatsApp Business foi autorizada, mas ainda não tem nenhum número. " +
            "Conclua o cadastro do número no popup da Meta e tente de novo.",
          details: numbersJson,
        });
      }
    }

    const result = await finalizeCloudApiConnection(request.log, { tenantId, wabaId, phoneNumberId, accessToken });
    if (!result.ok) {
      return reply.status(400).send({ error: result.error, details: result.details });
    }
    return reply.status(200).send(result.body);
  });
}
