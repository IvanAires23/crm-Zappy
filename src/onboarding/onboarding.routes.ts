import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { encryptToken } from "../config/crypto.js";
import { checkCoexistenceStatus, triggerSmbAppDataSync } from "../whatsapp/client.js";
import { authenticate } from "../auth/auth.plugin.js";

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
    throw err;
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

export async function onboardingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Status atual da conexão WhatsApp do tenant logado.
  app.get("/onboarding/whatsapp/status", async (request, reply) => {
    const account = await prisma.tenantWhatsappAccount.findFirst({
      where: { tenantId: request.auth.tenantId },
    });

    if (!account) {
      return reply.send({ connected: false });
    }

    return reply.send({
      connected: true,
      account: {
        phoneNumberId: account.phoneNumberId,
        displayPhoneNumber: account.displayPhoneNumber,
        wabaId: account.wabaId,
        qualityRating: account.qualityRating,
        tokenStatus: account.tokenStatus,
        isCoexistence: account.isCoexistence,
      },
    });
  });

  // Chamado pelo frontend logo após o FB.login() do Embedded Signup retornar o `code`.
  // O `code` tem vida curta (~10 min), então essa troca precisa acontecer na hora.
  app.post("/onboarding/whatsapp/complete", async (request, reply) => {
    const parsed = completeSignupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
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

    // 4) Checar se é um número em coexistência (ativo também no WhatsApp
    //    Business App do celular) — isso muda os próximos passos.
    const { isOnBizApp, platformType } = await checkCoexistenceStatus(phoneNumberId, accessToken);

    if (isOnBizApp) {
      // Número em coexistência já está registrado — NÃO chamar /register
      // (a Meta rejeita/é desnecessário). Em vez disso, dispara a
      // sincronização de contatos e histórico; os dados chegam depois via
      // webhook (campos smb_app_state_sync e history).
      await triggerSmbAppDataSync(phoneNumberId, accessToken, "smb_app_state_sync");
      await triggerSmbAppDataSync(phoneNumberId, accessToken, "history");
    } else {
      // Fluxo padrão: registra o número na Cloud API.
      const registerRes = await graphFetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp" }),
      });

      // O /register falhava em silêncio: a conta era salva como "conectada"
      // mesmo sem o número estar registrado na Cloud API, e o erro só aparecia
      // muito depois, na hora de enviar mensagem.
      if (!registerRes.ok) {
        const registerJson = await registerRes.json().catch(() => ({}));
        request.log.error({ registerJson, phoneNumberId }, "Falha ao registrar o número na Cloud API");
        return reply.status(400).send({
          error: "Não foi possível registrar o número na Cloud API do WhatsApp",
          details: registerJson,
        });
      }
    }

    // 5) Persistir, criptografando o token
    const account = await prisma.tenantWhatsappAccount.upsert({
      where: { phoneNumberId },
      create: {
        tenantId,
        wabaId,
        phoneNumberId,
        accessTokenEncrypted: encryptToken(accessToken),
        tokenStatus: "active",
        isCoexistence: isOnBizApp,
        platformType,
        historySyncStatus: isOnBizApp ? "pending" : null,
      },
      update: {
        accessTokenEncrypted: encryptToken(accessToken),
        tokenStatus: "active",
        isCoexistence: isOnBizApp,
        platformType,
        historySyncStatus: isOnBizApp ? "pending" : undefined,
      },
    });

    return reply.status(200).send({ connected: true, accountId: account.id, isCoexistence: isOnBizApp });
  });
}
