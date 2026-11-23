import bcrypt from "bcrypt";
import { prisma } from "../db.js";

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@goalpath.app";
  const adminPassword = process.env.ADMIN_PASSWORD || "AdminPass123!";
  const adminName = process.env.ADMIN_NAME || "GoalPath Administrator";

  console.log(`[SeedAdmin] Checking admin account: ${adminEmail}...`);

  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existing) {
    if (existing.role === "ADMIN") {
      console.log(`[SeedAdmin] User ${adminEmail} is already an ADMIN.`);
    } else {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "ADMIN" },
      });
      console.log(`[SeedAdmin] Promoted existing user ${adminEmail} to ADMIN.`);
    }
  } else {
    const password_hash = await bcrypt.hash(adminPassword, 10);
    const user = await prisma.user.create({
      data: {
        email: adminEmail,
        password_hash,
        role: "ADMIN",
        email_verified: true,
        profile: {
          create: {
            name: adminName,
            username: "@admin",
            level: 99,
            xp: 9999,
          },
        },
        preferences: {
          create: {
            appearance: "system",
          },
        },
      },
    });
    console.log(`[SeedAdmin] Created new ADMIN user: ${user.email} (ID: ${user.id}).`);
  }
}

main()
  .catch((e) => {
    console.error("[SeedAdmin] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
