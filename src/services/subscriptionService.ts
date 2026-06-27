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
  /**
   * Per-user Promise chain that serializes `activatePremium` calls so
   * concurrent activations (e.g. two browser tabs opening goals after a
   * payment, or parallel webhook + active-pull) cannot clobber each
   * other's `current_period_end` math. Within a single Node process this
   * is sufficient. For multi-replica deployments, replace with a Postgres
   * advisory lock (`pg_advisory_xact_lock(hashtext(user_id))`) so the
   * serialization happens across processes too.
   */
  private readonly activationQueues = new Map<string, Promise<void>>();

  private serializeActivation<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.activationQueues.get(userId) ?? Promise.resolve();
    // Run fn either way (resolve or reject from prev) so a previous failure
    // doesn't poison the queue forever for that user.
    const next = prev.then(fn, fn);
    this.activationQueues.set(
      userId,
      next.finally(() => {
        if (this.activationQueues.get(userId) === next) {
          this.activationQueues.delete(userId);
        }
      }),
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
      currentPeriodEnd: typeof row?.current_period_end === "string" ? row.current_period_end : null,
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
    // Per-user serialization prevents concurrent activations from racing on
    // the read-then-upsert pattern below. Caller path is safe to invoke
    // without the lock; this method is the single entrypoint.
    await this.serializeActivation(userId, () => this.activatePremiumInner(userId, orderId));
  }

  private async activatePremiumInner(userId: string, orderId: string): Promise<void> {
    const now = new Date();
    const candidateEnd = new Date(now.getTime() + config.premiumPeriodDays * 24 * 60 * 60 * 1000);

    // Period preservation: if the user is still in an active paid window
    // that extends beyond NOW, every new settlement adds another full
    // period on top of the existing end — so two quick renewals stack
    // into 2 × PREMIUM_PERIOD_DAYS instead of silently overwriting each
    // other. The previous form was `existingEnd > candidateEnd`, which
    // failed for back-to-back settlements because the second's
    // candidateEnd was always within milliseconds of the first's.
    const current = await supabaseAdmin
      .from("subscriptions")
      .select("current_period_end, status")
      .eq("user_id", userId)
      .maybeSingle();
    const existingEnd = current.data?.current_period_end
      ? new Date(String(current.data.current_period_end))
      : null;
    const isStillActive = current.data?.status === "active";
    const finalEnd =
      existingEnd && existingEnd > now && isStillActive
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

  /**
   * Active-pull reconciliation fallback for environments where Midtrans
   * webhooks cannot reach the backend (e.g. localhost dev without a tunnel).
   *
   * For each pending payment_transactions row owned by this user that's
   * younger than PENDING_WINDOW_DAYS and whose updated_at hasn't been
   * touched in RECONCILE_DEBOUNCE_MS, we ask Midtrans Core API for the
   * authoritative transaction_status and:
   *
   *   - settlement: atomic UPDATE on payment_transactions (mirroring the
   *     webhook idempotency guard) + activatePremium
   *   - cancelled: mark local row as cancelled so we don't keep polling
   *   - pending / 404: leave it for the next refresh
   *
   * Returns the effective subscription snapshot so the caller can render
   * Premium status immediately without a follow-up /subscription GET.
   */
  async refreshReconciled(userId: string): Promise<SubscriptionResponse> {
    const RECONCILE_DEBOUNCE_MS = 10_000;
    const PENDING_WINDOW_DAYS = 7;
    const sinceDate = new Date(
      Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const pendingResult = await supabaseAdmin
      .from("payment_transactions")
      .select("order_id, gross_amount, updated_at, status")
      .eq("user_id", userId)
      .eq("status", "pending")
      .gte("created_at", sinceDate)
      .order("created_at", { ascending: true });

    if (pendingResult.error) {
      console.warn(
        "[Subscription] refreshReconciled query error:",
        pendingResult.error.message,
      );
    }

    const pending = (pendingResult.data ?? []) as Array<{
      order_id: string;
      gross_amount: string | number;
      updated_at: string;
    }>;

    // Sequential (for…of), not Promise.all: activatePremium reads+extends
    // current_period_end inside a loop, so concurrent calls would race and
    // only one extension might land. Sequential guarantees 5 successful
    // settlements add up to 5 × PREMIUM_PERIOD_DAYS of premium time.
    for (const txn of pending) {
      const lastUpdateMs = new Date(txn.updated_at).getTime();
      if (Date.now() - lastUpdateMs < RECONCILE_DEBOUNCE_MS) continue;

      try {
        const remote = await getTransactionStatus(txn.order_id);

        // Cross-check gross_amount so a tampered Midtrans response (or a
        // stale DB row) can't trigger premium activation for the wrong price.
        // Midtrans always returns the value as a string with exactly two
        // fractional digits ("150000.00"). Postgres numeric(12,2) may
        // serialize with or without the trailing zeros, so we normalize to
        // a fixed-format string before comparing.
        //
        // NaN guard: `Number("abc").toFixed(2)` is the literal string
        // "NaN", so `"NaN" === "NaN"` would falsely pass and activate
        // premium even when amounts are unparseable. We also use
        // `parseFloat(String(...))` rather than coercion: a partial
        // parse like `"150000abc"` otherwise silently coerces to 150000
        // via `Number()`, falsely matching the local 150000 and
        // activating premium on a tampered amount. parseFloat returns
        // NaN for trailing garbage only when the leading bytes aren't
        // numeric, so we still need `Number.isFinite` after the call.
        const nRemote = parseFloat(String(remote.gross_amount));
        const nLocal = parseFloat(String(txn.gross_amount));
        if (!Number.isFinite(nRemote) || !Number.isFinite(nLocal)) {
          console.warn(
            `[Subscription] reconcile: order ${txn.order_id} has non-finite gross_amount (remote=${String(remote.gross_amount)}, db=${String(txn.gross_amount)}). Skipping.`,
          );
          continue;
        }
        const remoteNorm = nRemote.toFixed(2);
        const localNorm = nLocal.toFixed(2);
        if (remoteNorm !== localNorm) {
          console.warn(
            `[Subscription] reconcile: order ${txn.order_id} gross_amount mismatch (remote=${remoteNorm}, db=${localNorm}). Skipping.`,
          );
          continue;
        }

        const status = mapMidtransStatus(remote.transaction_status);

        if (status === "settlement") {
          // Atomic UPDATE mirrors the webhook idempotency guard so a real
          // webhook that arrives concurrently won't double-activate.
          const updateResult = await supabaseAdmin
            .from("payment_transactions")
            .update({
              status,
              payment_type: remote.payment_type ?? null,
              transaction_id: remote.transaction_id ?? null,
              fraud_status: remote.fraud_status ?? null,
              raw_notification: remote as Record<string, unknown>,
              updated_at: new Date().toISOString(),
            })
            .eq("order_id", txn.order_id)
            .neq("status", "settlement")
            .select("order_id");

          if (updateResult.error) {
            console.warn(
              `[Subscription] reconcile update error for ${txn.order_id}:`,
              updateResult.error.message,
            );
            continue;
          }

          const appliedRows = updateResult.data ?? [];
          if (appliedRows.length > 0) {
            await this.activatePremium(userId, txn.order_id);
            console.info(
              `[Subscription] reconcile activated premium for order ${txn.order_id}`,
            );
          }
        } else if (status === "cancelled") {
          await supabaseAdmin
            .from("payment_transactions")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("order_id", txn.order_id)
            .neq("status", "settlement");
        }
        // status === "pending" → Midtrans still waiting; leave for next refresh.
      } catch (err) {
        const e = err as AppError;
        if (e instanceof AppError && e.statusCode === 404) {
          // Order never registered at Midtrans (user closed Snap too fast
          // or order was purged). Mark cancelled so we stop polling it.
          await supabaseAdmin
            .from("payment_transactions")
            .update({ status: "cancelled", updated_at: new Date().toISOString() })
            .eq("order_id", txn.order_id)
            .neq("status", "settlement");
          continue;
        }
        console.warn(
          `[Subscription] reconcile failed for ${txn.order_id}:`,
          e.message,
        );
      }
    }

    return this.getMySubscription(userId);
  }

  // ───────── Hard limit gates (called inside repositories/routes) ─────────

  /**
   * Premium gate that opportunistically reconciles pending payments before
   * reporting "not premium". Without this, a user who just paid in a dev
   * environment where the Midtrans webhook cannot reach the backend would
   * be stuck on /me seeing "Free" AND hit 402 errors on goal/habit/coach
   * gates even though they legitimately have an in-flight settlement.
   *
   * `refreshReconciled` is internally debounced to 10s per pending row, so
   * hammering the API after each route doesn't spam Midtrans GET calls.
   */
  private async checkPremiumByReconciling(
    userId: string,
  ): Promise<{ active: boolean; tier: SubscriptionTier }> {
    const initial = await this.isPremiumActive(userId);
    if (initial.active) return initial;
    await this.refreshReconciled(userId).catch((err) => {
      // Reconciliation must never block a gate; log and fall through.
      console.warn(
        "[Subscription] opportunistic reconcile failed:",
        (err as Error).message,
      );
    });
    return this.isPremiumActive(userId);
  }

  async assertCanCreateGoal(userId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
    if (premium.active) return;
    const { count } = await supabaseAdmin
      .from("goals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .lt("progress", 100);
    if ((count ?? 0) >= FREE_LIMITS.goals) {
      throw new AppError(
        `Batas tier Free tercapai. Maksimal ${FREE_LIMITS.goals} goal aktif. Upgrade ke Premium untuk akses unlimited.`,
        402,
      );
    }
  }

  async assertCanCreateHabit(userId: string, goalId: string): Promise<void> {
    const premium = await this.checkPremiumByReconciling(userId);
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
    const premium = await this.checkPremiumByReconciling(userId);
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
