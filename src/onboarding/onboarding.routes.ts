import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { encryptToken } from "../config/crypto.js";
import { checkCoexistenceStatus, triggerSmbAppDataSync } from "../whatsapp/client.js";
import { authenticate } from "../auth/auth.plugin.js";

const GRAPH_BASE = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

const completeSignupSchema = z.object({
  code: z.string().min(1), // authorization code retornado pelo FB.login() no frontend
  wabaId: z.string().min(1),
  // Fluxo padrão (número novo) já manda o phoneNumberId no evento 'FINISH'.
  // Fluxo de coexistência (número já ativo no WhatsApp Business App) só manda
  // o waba_id no evento 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' — nesse
  // caso descobrimos o phoneNumberId aqui no backend.
  phoneNumberId: z.string().min(1).optional(),
});

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
    const { code, wabaId } = parsed.data;

    // 1) Trocar o code por um token de acesso de negócio
    const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", env.META_APP_ID);
    tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok || !tokenJson.access_token) {
      request.log.error({ tokenJson }, "Falha ao trocar code por access_token");
      return reply.status(400).send({ error: "Falha ao autenticar com a Meta", details: tokenJson });
    }

    const accessToken: string = tokenJson.access_token;

    // 2) Descobrir o phoneNumberId quando o frontend não mandou (caso do
    //    fluxo de coexistência, que só devolve o waba_id).
    let phoneNumberId = parsed.data.phoneNumberId;
    if (!phoneNumberId) {
      const numbersRes = await fetch(
        `${GRAPH_BASE}/${wabaId}/phone_numbers?access_token=${accessToken}`
      );
      const numbersJson = await numbersRes.json();
      phoneNumberId = numbersJson?.data?.[0]?.id;

      if (!phoneNumberId) {
        request.log.error({ numbersJson }, "Não achei phoneNumberId pra essa WABA");
        return reply.status(400).send({
          error: "Não foi possível descobrir o phoneNumberId da WABA informada",
          details: numbersJson,
        });
      }
    }

    // 3) Checar se é um número em coexistência (ativo também no WhatsApp
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
      await fetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp" }),
      });
    }

    // 4) Persistir, criptografando o token
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
