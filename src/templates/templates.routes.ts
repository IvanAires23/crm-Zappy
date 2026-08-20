import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

export async function templatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/templates", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const { status } = parsed.data;

    const templates = await prisma.template.findMany({
      where: { tenantId, ...(status ? { metaStatus: status } : {}) },
      orderBy: { name: "asc" },
    });

    return reply.send(templates);
  });
}
