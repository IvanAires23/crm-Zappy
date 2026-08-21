import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { authenticate } from "../auth/auth.plugin.js";

const overviewQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  pipelineId: z.string().min(1).optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function bucketByDay(dates: Date[], from: Date, to: Date) {
  const counts = new Map<string, number>();
  for (let t = new Date(from.toISOString().slice(0, 10)).getTime(); t <= to.getTime(); t += DAY_MS) {
    counts.set(dayKey(new Date(t)), 0);
  }
  for (const date of dates) {
    const key = dayKey(date);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([date, count]) => ({ date, count }));
}

function increment<K>(map: Map<K, number>, key: K, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/dashboard/overview", async (request, reply) => {
    const parsed = overviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tenantId = request.auth.tenantId;
    const to = parsed.data.to ?? new Date();
    const from = parsed.data.from ?? new Date(to.getTime() - 30 * DAY_MS);
    const pipelineId = parsed.data.pipelineId;

    const [dealsInRange, openDealsCurrent, pipelines, conversationsInRange, messagesInRange, customFieldDefinitions, overdueTasks, stageHistory] =
      await Promise.all([
        prisma.deal.findMany({
          where: { tenantId, createdAt: { gte: from, lte: to }, ...(pipelineId ? { pipelineId } : {}) },
          include: {
            tags: { include: { tag: true } },
            stage: true,
            pipeline: true,
            assignedUser: true,
          },
        }),
        prisma.deal.findMany({
          where: { tenantId, status: "open", ...(pipelineId ? { pipelineId } : {}) },
          select: { stageId: true, pipelineId: true, valueCents: true },
        }),
        prisma.pipeline.findMany({
          where: { tenantId, ...(pipelineId ? { id: pipelineId } : {}) },
          include: { stages: { orderBy: { order: "asc" } } },
        }),
        prisma.conversation.findMany({
          where: { tenantId, createdAt: { gte: from, lte: to } },
          select: { createdAt: true },
        }),
        prisma.message.findMany({
          where: { tenantId, createdAt: { gte: from, lte: to } },
          select: { direction: true },
        }),
        prisma.dealCustomFieldDefinition.findMany({ where: { tenantId }, orderBy: { order: "asc" } }),
        prisma.task.count({ where: { tenantId, status: "pending", dueAt: { lt: new Date() } } }),
        prisma.dealStageHistory.findMany({
          where: { deal: { tenantId, ...(pipelineId ? { pipelineId } : {}) } },
          orderBy: [{ dealId: "asc" }, { movedAt: "asc" }],
          select: { dealId: true, toStageId: true, movedAt: true },
        }),
      ]);

    // --- KPIs ---
    const wonDeals = dealsInRange.filter((d) => d.status === "won");
    const lostDeals = dealsInRange.filter((d) => d.status === "lost");
    const wonValueCents = wonDeals.reduce((sum, d) => sum + (d.valueCents ?? 0), 0);
    const openPipelineValueCents = openDealsCurrent.reduce((sum, d) => sum + (d.valueCents ?? 0), 0);
    const messagesInbound = messagesInRange.filter((m) => m.direction === "inbound").length;
    const messagesOutbound = messagesInRange.filter((m) => m.direction === "outbound").length;

    const kpis = {
      totalLeads: dealsInRange.length,
      conversationsStarted: conversationsInRange.length,
      wonCount: wonDeals.length,
      lostCount: lostDeals.length,
      openCount: dealsInRange.filter((d) => d.status === "open").length,
      conversionRate: wonDeals.length + lostDeals.length > 0 ? wonDeals.length / (wonDeals.length + lostDeals.length) : 0,
      wonValueCents,
      avgWonValueCents: wonDeals.length > 0 ? Math.round(wonValueCents / wonDeals.length) : 0,
      openPipelineValueCents,
      messagesInbound,
      messagesOutbound,
      overdueTasks,
    };

    // --- séries temporais ---
    const leadsOverTime = bucketByDay(dealsInRange.map((d) => d.createdAt), from, to);
    const conversationsOverTime = bucketByDay(conversationsInRange.map((c) => c.createdAt), from, to);

    // --- distribuições ---
    const statusCounts = new Map<string, number>();
    const sourceCounts = new Map<string, { name: string; color: string; count: number }>();
    const pipelineCounts = new Map<string, { name: string; count: number }>();
    const userCounts = new Map<string, { name: string; count: number; wonCount: number; wonValueCents: number }>();
    const lostReasonCounts = new Map<string, number>();

    for (const deal of dealsInRange) {
      increment(statusCounts, deal.status);

      for (const link of deal.tags) {
        const entry = sourceCounts.get(link.tagId) ?? { name: link.tag.name, color: link.tag.color, count: 0 };
        entry.count += 1;
        sourceCounts.set(link.tagId, entry);
      }

      const pipelineEntry = pipelineCounts.get(deal.pipelineId) ?? { name: deal.pipeline.name, count: 0 };
      pipelineEntry.count += 1;
      pipelineCounts.set(deal.pipelineId, pipelineEntry);

      const userKey = deal.assignedUserId ?? "unassigned";
      const userEntry = userCounts.get(userKey) ?? {
        name: deal.assignedUser?.name ?? "Sem responsável",
        count: 0,
        wonCount: 0,
        wonValueCents: 0,
      };
      userEntry.count += 1;
      if (deal.status === "won") {
        userEntry.wonCount += 1;
        userEntry.wonValueCents += deal.valueCents ?? 0;
      }
      userCounts.set(userKey, userEntry);

      if (deal.status === "lost") {
        increment(lostReasonCounts, deal.lostReason?.trim() || "Não informado");
      }
    }

    const byStatus = Array.from(statusCounts.entries()).map(([status, count]) => ({ status, count }));
    const bySource = Array.from(sourceCounts.values()).sort((a, b) => b.count - a.count);
    const byPipeline = Array.from(pipelineCounts.values()).sort((a, b) => b.count - a.count);
    const byUser = Array.from(userCounts.values()).sort((a, b) => b.count - a.count);
    const lostReasons = Array.from(lostReasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // --- campos personalizados ---
    const customFields = customFieldDefinitions.map((def) => {
      const rawValues = dealsInRange
        .map((d) => (d.customFields as Record<string, unknown>)[def.id])
        .filter((v) => v !== undefined && v !== null && v !== "");

      if (def.type === "number") {
        const numbers = rawValues.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
        return {
          fieldId: def.id,
          name: def.name,
          type: def.type,
          stats:
            numbers.length > 0
              ? {
                  avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
                  min: Math.min(...numbers),
                  max: Math.max(...numbers),
                  count: numbers.length,
                }
              : null,
        };
      }

      if (def.type === "date") {
        return {
          fieldId: def.id,
          name: def.name,
          type: def.type,
          filled: rawValues.length,
          empty: dealsInRange.length - rawValues.length,
        };
      }

      const valueCounts = new Map<string, number>();
      for (const v of rawValues) increment(valueCounts, String(v));
      const sorted = Array.from(valueCounts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
      const top = sorted.slice(0, 8);
      const rest = sorted.slice(8).reduce((sum, v) => sum + v.count, 0);
      const breakdown = rest > 0 ? [...top, { value: "Outros", count: rest }] : top;

      return { fieldId: def.id, name: def.name, type: def.type, breakdown };
    });

    // --- funil (estado atual, sem filtro de data) ---
    const openByStage = new Map<string, { count: number; valueCents: number }>();
    for (const deal of openDealsCurrent) {
      const entry = openByStage.get(deal.stageId) ?? { count: 0, valueCents: 0 };
      entry.count += 1;
      entry.valueCents += deal.valueCents ?? 0;
      openByStage.set(deal.stageId, entry);
    }
    const funnel = pipelines.map((pipeline) => ({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      stages: pipeline.stages.map((stage) => ({
        stageId: stage.id,
        stageName: stage.name,
        color: stage.color,
        count: openByStage.get(stage.id)?.count ?? 0,
        valueCents: openByStage.get(stage.id)?.valueCents ?? 0,
      })),
    }));

    // --- tempo médio por estágio (transições completas do histórico) ---
    const stageDurationsMs = new Map<string, number[]>();
    for (let i = 0; i < stageHistory.length - 1; i++) {
      const current = stageHistory[i];
      const next = stageHistory[i + 1];
      if (current.dealId !== next.dealId) continue;
      const durationMs = next.movedAt.getTime() - current.movedAt.getTime();
      const list = stageDurationsMs.get(current.toStageId) ?? [];
      list.push(durationMs);
      stageDurationsMs.set(current.toStageId, list);
    }
    const stageNameById = new Map(pipelines.flatMap((p) => p.stages).map((s) => [s.id, s.name]));
    const stageDuration = Array.from(stageDurationsMs.entries())
      .map(([stageId, durations]) => ({
        stageId,
        stageName: stageNameById.get(stageId) ?? stageId,
        avgDays: durations.reduce((a, b) => a + b, 0) / durations.length / DAY_MS,
      }))
      .sort((a, b) => b.avgDays - a.avgDays);

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      kpis,
      leadsOverTime,
      conversationsOverTime,
      byStatus,
      bySource,
      byPipeline,
      byUser,
      lostReasons,
      customFields,
      funnel,
      stageDuration,
    };
  });
}
