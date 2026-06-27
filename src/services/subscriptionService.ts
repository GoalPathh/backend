import { supabaseAdmin } from "../supabase.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import {
  FREE_LIMITS,
  PLAN_MATRIX,
  type SubscriptionResponse,
  type SubscriptionTier,
  type PlanFeatures,
  type SubscriptionLimits,
} from "../dto/subscription.js";
import {
  createSnapTransaction,
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
  async getMySubscription(userId: string): Promise<SubscriptionResponse> {
    const row = await this.fetchSubscriptionRow(userId);
    const { tier, status } = this.resolveEffectiveTier(row);
    const matrix = PLAN_MATRIX[tier];

    return {
      tier,
      status,
      currentPeriodEnd: row?.current_period_end ?? null,
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

    const insert = await supabaseAdmin.from("payment_transactions").insert({
      order_id: orderId,
      user_id: userId,
      gross_amount: config.premiumPriceIdr,
      status: "pending",
      tier: "premium",
    });
    if (insert.error) {
      throw new AppError(`Failed to create payment record: ${insert.error.message}`, 500);
    }

    const snap = await createSnapTransaction({
      orderId,
      grossAmount: config.premiumPriceIdr,
      customerName: profile.name ?? "GoalPath",
      customerEmail: profile.email ?? "noreply@goalpath.local",
      itemName: `GoalPath Premium - ${config.premiumPeriodDays} hari`,
    });

    await supabaseAdmin
      .from("payment_transactions")
      .update({ snap_token: snap.token, updated_at: new Date().toISOString() })
      .eq("order_id", orderId);

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
      // Persist for audit but do NOT activate premium.
      await supabaseAdmin.from("payment_transactions").update({
        status,
        payment_type: notification.payment_type ?? null,
        transaction_id: notification.transaction_id ?? null,
        fraud_status: notification.fraud_status ?? null,
        signature_match: false,
        raw_notification: notification as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      }).eq("order_id", notification.order_id);
      throw new AppError("Signature verification failed.", 403);
    }

    // Idempotency is enforced atomically: we only persist the new status when
    // the previous status was NOT already "settlement". That single round-trip
    // is race-safe against concurrent webhook retries (no SELECT-then-UPDATE
    // window where two callers can both observe "pending" and both call
    // activatePremium).
    const updateResult = await supabaseAdmin.from("payment_transactions")
      .update({
        status,
        payment_type: notification.payment_type ?? null,
        transaction_id: notification.transaction_id ?? null,
        fraud_status: notification.fraud_status ?? null,
        signature_match: true,
        raw_notification: notification as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", notification.order_id)
      .neq("status", "settlement")
      .select("order_id, user_id");

    if (updateResult.error) {
      throw new AppError(`Failed to record transaction: ${updateResult.error.message}`, 500);
    }

    const appliedRows = updateResult.data ?? [];
    const wasAlreadySettled = appliedRows.length === 0;

    if (status === "settlement") {
      if (wasAlreadySettled) {
        console.info(
          "[Subscription] duplicate settlement notification ignored for order",
          notification.order_id,
        );
        return { accepted: true, status, signatureMatch: true };
      }

      const txnRow = appliedRows[0] as { user_id?: string } | undefined;
      if (txnRow?.user_id) {
        await this.activatePremium(txnRow.user_id, notification.order_id);
      }
    }

    return { accepted: true, status, signatureMatch: true };
  }

  async activatePremium(userId: string, orderId: string): Promise<void> {
    const now = new Date();
    const candidateEnd = new Date(now.getTime() + config.premiumPeriodDays * 24 * 60 * 60 * 1000);

    // Period preservation: if the user already has time remaining, extend from
    // the maximum of (now + period) and (current_end) so renewals don't lose days.
    const current = await supabaseAdmin
      .from("subscriptions")
      .select("current_period_end, status")
      .eq("user_id", userId)
      .maybeSingle();
    const existingEnd = current.data?.current_period_end
      ? new Date(String(current.data.current_period_end))
      : null;
    const finalEnd =
      existingEnd && existingEnd > candidateEnd && current.data?.status === "active"
        ? new Date(existingEnd.getTime() + config.premiumPeriodDays * 24 * 60 * 60 * 1000)
        : candidateEnd;

    const upsertResult = await supabaseAdmin.from("subscriptions").upsert({
      user_id: userId,
      tier: "premium",
      status: "active",
      current_period_start: now.toISOString(),
      current_period_end: finalEnd.toISOString(),
      auto_renew: false,
      last_payment_order_id: orderId,
      updated_at: now.toISOString(),
    }, { onConflict: "user_id" });
    if (upsertResult.error) {
      throw new AppError(`Failed to activate premium: ${upsertResult.error.message}`, 500);
    }
  }

  async cancel(userId: string): Promise<void> {
    const result = await supabaseAdmin
      .from("subscriptions")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    if (result.error) {
      throw new AppError(`Failed to cancel subscription: ${result.error.message}`, 500);
    }
  }

  // ───────── Hard limit gates (called inside repositories/routes) ─────────

  async assertCanCreateGoal(userId: string): Promise<void> {
    const premium = await this.isPremiumActive(userId);
    if (premium.active) return;
    const { count } = await supabaseAdmin
      .from("goals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if ((count ?? 0) >= FREE_LIMITS.goals) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.goals} goal aktif. Upgrade ke Premium untuk akses unlimited.`,
        402,
      );
    }
  }

  async assertCanCreateHabit(userId: string, goalId: string): Promise<void> {
    const premium = await this.isPremiumActive(userId);
    if (premium.active) return;
    const { count } = await supabaseAdmin
      .from("habits")
      .select("id", { count: "exact", head: true })
      .eq("goal_id", goalId)
      .eq("user_id", userId);
    if ((count ?? 0) >= FREE_LIMITS.habitsPerGoal) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.habitsPerGoal} habit per goal. Upgrade ke Premium untuk akses unlimited.`,
        402,
      );
    }
  }

  async assertCanSendCoachMessage(userId: string): Promise<void> {
    const premium = await this.isPremiumActive(userId);
    if (premium.active) return;
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = `${today}T00:00:00.000Z`;
    const { count } = await supabaseAdmin
      .from("coach_messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", startOfDay);
    if ((count ?? 0) >= FREE_LIMITS.coachMessagesPerDay) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.coachMessagesPerDay} pesan coach per hari. Upgrade ke Premium untuk akses tanpa batas.`,
        402,
      );
    }
  }

  async assertPremium(userId: string): Promise<void> {
    const premium = await this.isPremiumActive(userId);
    if (!premium.active) {
      throw new AppError(
        "Fitur ini khusus member Premium. Silakan upgrade akun Anda untuk membuka akses.",
        402,
      );
    }
  }

  // ───────── Private helpers ─────────

  private async fetchSubscriptionRow(userId: string): Promise<Record<string, unknown> | null> {
    const result = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (result.error) {
      // Don't block business logic on subscription query errors — log and default to free.
      console.warn("[SubscriptionService] fetch error:", result.error.message);
      return null;
    }
    return (result.data ?? null) as Record<string, unknown> | null;
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

  // ───────── Static helpers (exported via instance too for routes) ─────────

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
