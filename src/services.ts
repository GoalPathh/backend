import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { AppError } from "./errors.js";
import {
  CoachRepository,
  DashboardRepository,
  GoalRepository,
  MilestoneRepository,
  NotificationRepository,
  PersonaRepository,
  SubscriptionRepository,
  UserRepository,
} from "./repositories.js";
import { deriveAdvice } from "./services/personaClassifier.js";
import { SubscriptionService } from "./services/subscriptionService.js";

// Helper: buat JWT access token dan refresh token
function generateTokens(userId: string) {
  const access_token = jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as any,
  });
  const refresh_token = jwt.sign({ sub: userId, type: "refresh" }, config.jwtSecret, {
    expiresIn: config.jwtRefreshExpiresIn as any,
  });
  return {
    access_token,
    refresh_token,
    expires_in: 15 * 60, // 15 menit dalam detik
    token_type: "bearer",
  };
}

export class AuthService {
  async register(input: { email: string; password: string; name: string }) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AppError("User already registered", 400);
    }

    const password_hash = await bcrypt.hash(input.password, 10);
    const usernameBase = input.name.toLowerCase().replace(/[^a-z0-9_]+/g, "") || "goalpath";
    const username = `@${usernameBase}`;

    const user = await prisma.user.create({
      data: {
        email: input.email,
        password_hash,
        profile: {
          create: {
            name: input.name,
            username,
          },
        },
        preferences: {
          create: {
            appearance: "light",
            notifications: [
              { id: "daily-habit", title: "Daily Habit Reminders", enabled: true, description: "Stay on track with daily check-ins." },
              { id: "progress-updates", title: "Goal Progress Updates", enabled: true, description: "Get updates when goals move forward." },
              { id: "achievement-alerts", title: "Achievement Notifications", enabled: true, description: "Celebrate every badge you unlock." },
              { id: "ai-coach", title: "AI Coach Suggestions", enabled: false, description: "Receive smart prompts from your coach." },
              { id: "weekly-reports", title: "Weekly Reports", enabled: true, description: "Review your performance every week." },
            ],
          },
        },
      },
      include: { profile: true },
    });

    const session = generateTokens(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        user_metadata: { name: user.profile?.name, username: user.profile?.username },
      },
      session,
    };
  }

  async login(input: { email: string; password: string }) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { profile: true },
    });

    if (!user) {
      throw new AppError("Invalid login credentials", 401);
    }

    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) {
      throw new AppError("Invalid login credentials", 401);
    }

    const session = generateTokens(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        user_metadata: { name: user.profile?.name, username: user.profile?.username },
      },
      session,
    };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) throw new AppError("Refresh token is required.", 401);
    try {
      const decoded = jwt.verify(refreshToken, config.jwtSecret) as { sub: string; type?: string };
      if (decoded.type !== "refresh") throw new AppError("Invalid token type.", 401);

      const user = await prisma.user.findUnique({
        where: { id: decoded.sub },
        include: { profile: true },
      });
      if (!user) throw new AppError("User not found.", 401);

      const session = generateTokens(user.id);
      return {
        user: {
          id: user.id,
          email: user.email,
          user_metadata: { name: user.profile?.name, username: user.profile?.username },
        },
        session,
      };
    } catch {
      throw new AppError("Invalid or expired refresh token.", 401);
    }
  }

  async forgotPassword(email: string) {
    // Stub: di development MySQL lokal cukup return message success
    const user = await prisma.user.findUnique({ where: { email } });
    return {
      message: user
        ? "If an account exists for this email, a password reset link has been sent."
        : "If an account exists for this email, a password reset link has been sent.",
    };
  }

  async updatePassword(userId: string, password: string) {
    const password_hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { password_hash },
    });
    return { user: { id: user.id, email: user.email } };
  }

  async googleOAuth(_next: string) {
    throw new AppError("Google OAuth tidak tersedia dalam mode MySQL lokal.", 501);
  }
}

export class GoalService {
  constructor(private repo = new GoalRepository()) {}
  list(u: string) { return this.repo.list(u); }
  dashboard(u: string) { return this.repo.dashboard(u); }
  get(u: string, id: string) { return this.repo.find(u, id); }
  create(u: string, i: unknown) { return this.repo.create(u, i); }
  update(u: string, id: string, i: unknown) { return this.repo.update(u, id, i); }
  remove(u: string, id: string) { return this.repo.remove(u, id); }
}

export class UserService {
  constructor(private repo = new UserRepository()) {}
  overview(u: string) { return this.repo.overview(u); }
  profile(u: string) { return this.repo.profile(u); }
  updateProfile(u: string, i: unknown) { return this.repo.updateProfile(u, i); }
  preferences(u: string) { return this.repo.preferences(u); }
  updatePreferences(u: string, i: unknown) { return this.repo.updatePreferences(u, i); }
  avatarUploadSignature(u: string) { return this.repo.createAvatarUploadSignature(u); }
}

export class DashboardService {
  constructor(private repo = new DashboardRepository()) {}
  today(u: string, tz?: number) { return this.repo.today(u, tz); }
  getUserContextSnapshot(u: string) { return this.repo.getUserContextSnapshot(u); }
  setCompletion(u: string, id: string, c: boolean, d?: string) { return this.repo.setCompletion(u, id, c, d); }
  progressDash(u: string) { return this.repo.getProgressDash(u); }
  progressOverview(u: string, range: string) { return this.repo.getProgressOverview(u, range); }
  goalPerformance(u: string) { return this.repo.getGoalPerformance(u); }
  recomputeGoal(u: string, id: string) { return this.repo.recomputeGoalProgress(u, id); }
}

export class NotificationService {
  constructor(private repo = new NotificationRepository()) {}
  list(u: string) { return this.repo.list(u); }
  markAllRead(u: string) { return this.repo.markAllRead(u); }
}

export class CoachService {
  constructor(private repo = new CoachRepository()) {}
  session(u: string, id: string) { return this.repo.session(u, id); }
  sessions(u: string) { return this.repo.sessions(u); }
  createSession(u: string, title?: string) { return this.repo.createSession(u, title); }
  renameSession(u: string, id: string, title: string) { return this.repo.renameSession(u, id, title); }
  deleteSession(u: string, id: string) { return this.repo.deleteSession(u, id); }
  messages(u: string, id: string) { return this.repo.messages(u, id); }
  addMessage(u: string, id: string, role: string, content: string, emb?: number[]) {
    return this.repo.addMessage(u, id, role, content, emb);
  }
  searchContext(u: string, id: string, emb: number[], matchCount = 5) {
    return this.repo.searchRelevantMessages(u, id, emb, matchCount);
  }
  getQuota(u: string, maxMessagesPerDay: number, accessPercentage: number) {
    return this.repo.getQuota(u, maxMessagesPerDay, accessPercentage);
  }
}

export class PersonaService {
  constructor(private repo = new PersonaRepository()) {}

  async compute(u: string, windowDays: number, force = false) {
    if (!force) {
      const cached = await this.repo.getCached(u, windowDays, 60 * 60 * 1000);
      if (cached) {
        const traits = (cached as any).traits;
        const evidence = (cached as any).evidence;
        return {
          archetype: (cached as any).archetype,
          headline: "",
          traits,
          evidence,
          advice: deriveAdvice((cached as any).archetype, traits, evidence),
          generatedAt: (cached as any).computed_at,
          windowDays: (cached as any).window_days,
        };
      }
    }
    return this.repo.compute(u, windowDays);
  }

  getCoachContext(u: string, windowDays = 14) {
    return this.repo.getCoachContext(u, windowDays);
  }
}

export class MilestoneService {
  constructor(private repo = new MilestoneRepository()) {}
  listOf(u: string, goalId: string) { return this.repo.list(u, goalId); }
  bulkReplace(u: string, goalId: string, items: Array<{ title: string; target_date?: string; sort_order?: number }>) {
    return this.repo.bulkInsert(u, goalId, items);
  }
  setDone(u: string, id: string, done: boolean) { return this.repo.setDone(u, id, done); }
  remove(u: string, id: string) { return this.repo.remove(u, id); }
}

export class SubscriptionFacade {
  constructor(private service: SubscriptionService = new SubscriptionService()) {}
  getMySubscription(userId: string) { return this.service.getMySubscription(userId); }
  isPremiumActive(userId: string) { return this.service.isPremiumActive(userId); }
  createCheckout(userId: string, profile: { name?: string | null; email?: string | null }) {
    return this.service.createCheckout(userId, profile);
  }
  handleWebhook(notification: unknown) {
    return this.service.handleWebhook(notification as Parameters<SubscriptionService["handleWebhook"]>[0]);
  }
  refreshReconciled(userId: string) { return this.service.refreshReconciled(userId); }
  cancel(userId: string) { return this.service.cancel(userId); }
  assertCanCreateGoal(userId: string) { return this.service.assertCanCreateGoal(userId); }
  assertCanCreateHabit(userId: string, goalId: string) { return this.service.assertCanCreateHabit(userId, goalId); }
  assertCanSendCoachMessage(userId: string) { return this.service.assertCanSendCoachMessage(userId); }
  assertPremium(userId: string) { return this.service.assertPremium(userId); }
}

export { SubscriptionRepository };
