import { prisma } from "../db.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import {
  FREE_LIMITS,
  PLAN_MATRIX,
  resolveCoachAccess,
  type SubscriptionResponse,
  type SubscriptionTier,
  type PlanFeatures,
  type SubscriptionLimits,
} from "../dto/subscription.js";
import {
  createSnapTransaction,
  getTransactionStatus,
  mapMidtransStatus,
  verifyMidtransSignature,
  type InternalPaymentStatus,
  type MidtransNotificationPayload,
} from "./midtransClient.js";

/**
 * SubscriptionService — owns tier checks, checkout creation, webhook handling
 * and feature gating helpers used by both routes and middleware.
 */
export class SubscriptionService {
  private readonly activationQueues = new Map<string, Promise<void>>();

  private serializeActivation<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.activationQueues.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.activationQueues.set(
      userId,
      next.then(() => {}, () => {}),
    );
    return next;
  }

  async getMySubscription(userId: string): Promise<SubscriptionResponse> {
    const row = await this.fetchSubscriptionRow(userId);
    const { tier, status } = this.resolveEffectiveTier(row);
    const matrix = PLAN_MATRIX[tier];

    return {
      tier,
      status,
      currentPeriodEnd: row?.current_period_end ? (row.current_period_end as Date).toISOString() : null,
      limits: matrix.limits,
      features: matrix.features,
      premiumPriceIdr: config.premiumPriceIdr,
      premiumPeriodDays: config.premiumPeriodDays,
    };
  }

  async isPremiumActive(userId: string): Promise<{ active: boolean; tier: SubscriptionTier }> {
    const row = await this.fetchSubscriptionRow(userId);
    const { tier } = this.resolveEffectiveTier(row);
    return { active: tier === "premium", tier };
  }

  async createCheckout(
    userId: string,
    profile: { name?: string | null; email?: string | null },
  ): Promise<{ token: string; redirectUrl: string; orderId: string }> {
    if (!config.midtransServerKey) {
      throw new AppError(
        "Payment gateway not configured. Set MIDTRANS_SERVER_KEY in backend .env first.",
        503,
      );
    }

    const orderId = `GP-${Date.now()}-${userId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await prisma.paymentTransaction.create({
        data: {
          order_id: orderId,
          user_id: userId,
          gross_amount: config.premiumPriceIdr,
          status: "pending",
          tier: "premium",
        },
      });
    } catch (err: any) {
      throw new AppError(`Failed to create payment record: ${err.message}`, 500);
    }

    const snap = await createSnapTransaction({
      orderId,
      grossAmount: config.premiumPriceIdr,
      customerName: profile.name ?? "GoalPath",
      customerEmail: profile.email ?? "noreply@goalpath.local",
      itemName: `GoalPath Premium - ${config.premiumPeriodDays} hari`,
    });

    await prisma.paymentTransaction.update({
      where: { order_id: orderId },
      data: { snap_token: snap.token },
    });

    return { token: snap.token, redirectUrl: snap.redirect_url, orderId };
  }

  async handleWebhook(notification: MidtransNotificationPayload): Promise<{
    accepted: boolean;
    status: InternalPaymentStatus;
    signatureMatch: boolean;
  }> {
    if (!notification.signature_key) {
      throw new AppError("Midtrans notification missing signature_key.", 400);
    }

    const signatureMatch = verifyMidtransSignature({
      order_id: notification.order_id,
      status_code: notification.status_code,
      gross_amount: notification.gross_amount,
      signature_key: notification.signature_key,
    });

    const status = mapMidtransStatus(notification.transaction_status);

    if (!signatureMatch) {
      console.warn("[Subscription] Signature mismatch for order", notification.order_id);
      await prisma.paymentTransaction.updateMany({
        where: { order_id: notification.order_id },
        data: {
          status,
          payment_type: notification.payment_type ?? null,
          transaction_id: notification.transaction_id ?? null,
          fraud_status: notification.fraud_status ?? null,
          signature_match: false,
          raw_notification: notification as any,
        },
      });
      throw new AppError("Signature verification failed.", 403);
    }

    const existingTxn = await prisma.paymentTransaction.findUnique({
      where: { order_id: notification.order_id },
    });

    if (!existingTxn) {
      throw new AppError(`Transaction ${notification.order_id} not found`, 404);
    }

    const wasAlreadySettled = existingTxn.status === "settlement";

    await prisma.paymentTransaction.update({
      where: { order_id: notification.order_id },
      data: {
        status,
        payment_type: notification.payment_type ?? null,
        transaction_id: notification.transaction_id ?? null,
        fraud_status: notification.fraud_status ?? null,
        signature_match: true,
        raw_notification: notification as any,
      },
    });

    if (status === "settlement") {
      if (wasAlreadySettled) {
        console.info(
          "[Subscription] duplicate settlement notification ignored for order",
          notification.order_id,
        );
        return { accepted: true, status, signatureMatch: true };
      }

      if (existingTxn.user_id) {
        await this.activatePremium(existingTxn.user_id, notification.order_id);
      }
    }

    return { accepted: true, status, signatureMatch: true };
  }

  async activatePremium(userId: string, orderId: string): Promise<void> {
    await this.serializeActivation(userId, () => this.activatePremiumInner(userId, orderId));
  }

  private async activatePremiumInner(userId: string, orderId: string): Promise<void> {
    const now = new Date();
    const candidateEnd = new Date(now.getTime() + config.premiumPeriodDays * 24 * 60 * 60 * 1000);

    const current = await prisma.subscription.findUnique({
      where: { user_id: userId },
    });
    const existingEnd = current?.current_period_end ? new Date(current.current_period_end) : null;
    const isStillActive = current?.status === "active";
    const finalEnd =
      existingEnd && existingEnd > now && isStillActive
        ? new Date(existingEnd.getTime() + config.premiumPeriodDays * 24 * 60 * 60 * 1000)
        : candidateEnd;

    await prisma.subscription.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        tier: "premium",
        status: "active",
        current_period_start: now,
        current_period_end: finalEnd,
        auto_renew: false,
        last_payment_order_id: orderId,
      },
      update: {
        tier: "premium",
        status: "active",
        current_period_start: now,
        current_period_end: finalEnd,
        auto_renew: false,
        last_payment_order_id: orderId,
      },
    });
  }

  async cancel(userId: string): Promise<void> {
    await prisma.subscription.update({
      where: { user_id: userId },
      data: {
        status: "cancelled",
        cancelled_at: new Date(),
      },
    });
  }

  async refreshReconciled(userId: string): Promise<SubscriptionResponse> {
    const RECONCILE_DEBOUNCE_MS = 10_000;
    const PENDING_WINDOW_DAYS = 7;
    const sinceDate = new Date(
      Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const pending = await prisma.paymentTransaction.findMany({
      where: {
        user_id: userId,
        status: "pending",
        created_at: { gte: sinceDate },
      },
      orderBy: { created_at: "asc" },
      select: {
        order_id: true,
        gross_amount: true,
        updated_at: true,
        status: true,
      },
    });

    for (const txn of pending) {
      const lastUpdateMs = new Date(txn.updated_at).getTime();
      if (Date.now() - lastUpdateMs < RECONCILE_DEBOUNCE_MS) continue;

      try {
        const remote = await getTransactionStatus(txn.order_id);

        const nRemote = parseFloat(String(remote.gross_amount));
        const nLocal = parseFloat(String(txn.gross_amount));
        if (!Number.isFinite(nRemote) || !Number.isFinite(nLocal)) {
          console.warn(
            `[Subscription] reconcile: order ${txn.order_id} has non-finite gross_amount. Skipping.`,
          );
          continue;
        }
        const remoteNorm = nRemote.toFixed(2);
        const localNorm = nLocal.toFixed(2);
        if (remoteNorm !== localNorm) {
          console.warn(
            `[Subscription] reconcile: order ${txn.order_id} gross_amount mismatch. Skipping.`,
          );
          continue;
        }

        const status = mapMidtransStatus(remote.transaction_status);

        if (status === "settlement") {
          const updated = await prisma.paymentTransaction.updateMany({
            where: {
              order_id: txn.order_id,
              status: { not: "settlement" },
            },
            data: {
              status,
              payment_type: remote.payment_type ?? null,
              transaction_id: remote.transaction_id ?? null,
              fraud_status: remote.fraud_status ?? null,
              raw_notification: remote as any,
            },
          });

          if (updated.count > 0) {
            await this.activatePremium(userId, txn.order_id);
            console.info(`[Subscription] reconcile activated premium for order ${txn.order_id}`);
          }
        } else if (status === "cancelled") {
          await prisma.paymentTransaction.updateMany({
            where: {
              order_id: txn.order_id,
              status: { not: "settlement" },
            },
            data: { status },
          });
        }
      } catch (err) {
        const e = err as AppError;
        if (e instanceof AppError && e.statusCode === 404) {
          await prisma.paymentTransaction.updateMany({
            where: {
              order_id: txn.order_id,
              status: { not: "settlement" },
            },
            data: { status: "cancelled" },
          });
          continue;
        }
        console.warn(`[Subscription] reconcile failed for ${txn.order_id}:`, e.message);
      }
    }

    return this.getMySubscription(userId);
  }

  // ───────── Hard limit gates ─────────

  private async checkPremiumByReconciling(
    userId: string,
  ): Promise<{ active: boolean; tier: SubscriptionTier }> {
    const initial = await this.isPremiumActive(userId);
    if (initial.active) return initial;
    await this.refreshReconciled(userId).catch((err) => {
      console.warn("[Subscription] opportunistic reconcile failed:", (err as Error).message);
    });
    return this.isPremiumActive(userId);
  }

  async assertCanCreateGoal(userId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
    if (premium.active) return;
    const count = await prisma.goal.count({
      where: {
        user_id: userId,
        progress: { lt: 100 },
      },
    });
    if (count >= FREE_LIMITS.goals) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.goals} goal aktif. Upgrade ke Premium untuk akses unlimited.`,
        402,
      );
    }
  }

  async assertCanCreateHabit(userId: string, goalId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
    if (premium.active) return;
    const count = await prisma.habit.count({
      where: {
        goal_id: goalId,
        user_id: userId,
      },
    });
    if (count >= FREE_LIMITS.habitsPerGoal) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.habitsPerGoal} habit per goal. Upgrade ke Premium untuk akses unlimited.`,
        402,
      );
    }
  }

  async assertCanSendCoachMessage(userId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
    const access = resolveCoachAccess(premium.tier);

    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(`${today}T00:00:00.000Z`);
    const count = await prisma.coachMessage.count({
      where: {
        user_id: userId,
        created_at: { gte: startOfDay },
      },
    });
    if (count >= access.maxMessagesPerDay) {
      throw new AppError(
        `Batas akses coach tercapai: ${access.accessPercentage}% akses (` +
          `${access.maxMessagesPerDay} pesan/hari). ` +
          (premium.active
            ? "Limit ini berlaku untuk semua member sebagai Fair Use Policy."
            : "Upgrade ke Premium untuk akses 100% (50 pesan/hari)."),
        402,
      );
    }
  }

  async assertPremium(userId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
    if (!premium.active) {
      throw new AppError(
        "Fitur ini khusus member Premium. Silakan upgrade akun Anda untuk membuka akses.",
        402,
      );
    }
  }

  // ───────── Private helpers ─────────

  private async fetchSubscriptionRow(userId: string): Promise<Record<string, unknown> | null> {
    try {
      const sub = await prisma.subscription.findUnique({
        where: { user_id: userId },
      });
      return sub as unknown as Record<string, unknown> | null;
    } catch (err: any) {
      console.warn("[SubscriptionService] fetch error:", err.message);
      return null;
    }
  }

  private resolveEffectiveTier(row: Record<string, unknown> | null): {
    tier: SubscriptionTier;
    status: "pending" | "active" | "expired" | "cancelled";
  } {
    if (!row) return { tier: "free", status: "active" };
    const tier = (row.tier as SubscriptionTier) ?? "free";
    const status = (row.status as "pending" | "active" | "expired" | "cancelled") ?? "active";
    const end = row.current_period_end ? new Date(String(row.current_period_end)) : null;
    const isExpired = status === "active" && end ? end.getTime() <= Date.now() : status === "expired";
    if (tier === "free" || isExpired) {
      return { tier: "free", status: isExpired ? "expired" : "active" };
    }
    return { tier, status };
  }

  // ───────── Static helpers ─────────

  static isFeatureActive(features: PlanFeatures, key: keyof PlanFeatures): boolean {
    return features[key] === true;
  }

  static describeLimits(limits: SubscriptionLimits, premiumPrice: number) {
    return {
      goals: limits.maxGoals === null ? "Unlimited" : `Up to ${limits.maxGoals}`,
      habitsPerGoal: limits.maxHabitsPerGoal === null ? "Unlimited" : `Up to ${limits.maxHabitsPerGoal}`,
      coachMessagesPerDay: limits.maxCoachMessagesPerDay === null
        ? "Unlimited"
        : `${limits.maxCoachMessagesPerDay}/hari`,
      priceIdr: premiumPrice,
    };
  }
}
