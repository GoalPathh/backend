import bcrypt from "bcrypt";
import { prisma } from "../db.js";

async function setup() {
  console.log("Setting up demo accounts...");

  const accounts = [
    {
      email: "user@goalpath.app",
      password: "UserPass123!",
      name: "Budi Santoso",
      role: "USER" as const,
    },
    {
      email: "admin@goalpath.app",
      password: "AdminPass123!",
      name: "Admin GoalPath",
      role: "ADMIN" as const,
    },
    {
      email: "otheruser@goalpath.app",
      password: "OtherPass123!",
      name: "Siti Rahma",
      role: "USER" as const,
    },
  ];

  for (const acc of accounts) {
    const existing = await prisma.user.findUnique({
      where: { email: acc.email },
    });

    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          role: acc.role,
        },
      });
      console.log(`[DemoSetup] Updated existing ${acc.email} with role: ${acc.role}`);
    } else {
      const password_hash = await bcrypt.hash(acc.password, 10);
      const usernameBase = acc.name.toLowerCase().replace(/[^a-z0-9_]+/g, "");
      const created = await prisma.user.create({
        data: {
          email: acc.email,
          password_hash,
          role: acc.role,
          email_verified: true,
          profile: {
            create: {
              name: acc.name,
              username: `@${usernameBase}`,
              level: acc.role === "ADMIN" ? 99 : 3,
              xp: acc.role === "ADMIN" ? 9999 : 450,
            },
          },
          preferences: {
            create: { appearance: "system" },
          },
        },
      });
      console.log(`[DemoSetup] Created ${acc.email} (${acc.role}) with ID: ${created.id}`);
    }
  }

  // Create a private goal for otheruser@goalpath.app
  const otherUser = await prisma.user.findUnique({
    where: { email: "otheruser@goalpath.app" },
  });

  if (otherUser) {
    // Check if goal already exists
    const existingGoal = await prisma.goal.findFirst({
      where: { user_id: otherUser.id },
    });

    if (!existingGoal) {
      const g = await prisma.goal.create({
        data: {
          user_id: otherUser.id,
          title: "Proyek Skripsi Rahasia Siti",
          category: "learning",
          period: "3months",
          progress: 50,
          start_date: new Date(),
          target_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          reminder_enabled: true,
          notification_preference: "all",
          habits: {
            create: [
              {
                user_id: otherUser.id,
                title: "Tulis Bab 4 Pembahasan",
                duration: 90,
                difficulty: "hard",
                time_range: "morning",
                active_days: ["mon", "tue", "wed", "thu", "fri"],
              },
            ],
          },
        },
      });
      console.log(`[DemoSetup] Created private goal for Siti: ID = ${g.id}`);
    } else {
      console.log(`[DemoSetup] Private goal for Siti exists: ID = ${existingGoal.id}`);
    }
  }

  console.log("Demo accounts ready.");
}

setup()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
