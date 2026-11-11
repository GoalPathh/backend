import { prisma } from "./db.js";

async function check() {
  console.log("Checking MySQL connection via Prisma...");
  try {
    const userCount = await prisma.user.count();
    const goalCount = await prisma.goal.count();
    const habitCount = await prisma.habit.count();
    console.log(`Database connected successfully!`);
    console.log(`Counts -> Users: ${userCount}, Goals: ${goalCount}, Habits: ${habitCount}`);
    await prisma.$disconnect();
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}

check();
