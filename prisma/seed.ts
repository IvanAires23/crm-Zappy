import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    create: { name: "Tenant Demo", slug: "demo" },
    update: {},
  });

  const passwordHash = await bcrypt.hash("admin123", 10);

  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.com" } },
    create: {
      tenantId: tenant.id,
      name: "Admin Demo",
      email: "admin@demo.com",
      passwordHash,
      role: "admin",
    },
    update: { passwordHash },
  });

  console.log("Seed ok:", { tenant: tenant.slug, user: user.email, senha: "admin123" });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
