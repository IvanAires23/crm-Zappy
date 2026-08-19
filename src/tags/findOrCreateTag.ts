import { prisma } from "../db/prisma.js";
import { slugifyTagName } from "./slugify.js";

// Usado pelo attach de tag em Contact/Deal: se vier `tagId`, usa a tag
// existente; se vier `name`, reaproveita por slug ou cria na hora — é
// assim que todo input de tag em CRM funciona (digita, aperta enter).
export async function resolveTagId(
  tenantId: string,
  input: { tagId?: string; name?: string; color?: string }
): Promise<{ id: string } | { error: string }> {
  if (input.tagId) {
    const tag = await prisma.tag.findFirst({ where: { id: input.tagId, tenantId } });
    if (!tag) return { error: "Tag não encontrada" };
    return { id: tag.id };
  }

  if (input.name) {
    const slug = slugifyTagName(input.name);
    const existing = await prisma.tag.findUnique({ where: { tenantId_slug: { tenantId, slug } } });
    if (existing) return { id: existing.id };

    const created = await prisma.tag.create({
      data: { tenantId, name: input.name, slug, color: input.color ?? "#6b7280" },
    });
    return { id: created.id };
  }

  return { error: "Informe tagId ou name" };
}
