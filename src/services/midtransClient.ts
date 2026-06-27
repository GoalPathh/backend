import { createHash } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../errors.js";

/**
 * Midtrans Snap API sandbox/production client.
 * Docs: https://docs.midtrans.com/reference/snap-api (sandbox base: app.sandbox.midtrans.com)
 */
export interface SnapTransactionRequest {
  orderId: string;
  grossAmount: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  itemName?: string;
  itemQuantity?: number;
}

export interface SnapTransactionResponse {
  token: string;
  redirect_url: string;
}

const MIDTRANS_BASE = config.midtransIsProduction
  ? "https://app.midtrans.com"
  : "https://app.sandbox.midtrans.com";

// Midtrans Core/REST API base — for transaction-status queries and any
// non-Snap server-to-server calls. Different subdomain from MIDTRANS_BASE
// (which is for the Snap checkout popup and its token endpoint).
const MIDTRANS_API_BASE = config.midtransIsProduction
  ? "https://api.midtrans.com"
  : "https://api.sandbox.midtrans.com";

function buildAuthHeader(): string {
  if (!config.midtransServerKey) {
    throw new AppError(
      "Midtrans server key is not configured. Set MIDTRANS_SERVER_KEY on backend .env to enable checkout.",
      503,
    );
  }
  // Midtrans expects Basic auth where the username is the server key and the password is empty.
  return "Basic " + Buffer.from(`${config.midtransServerKey}:`).toString("base64");
}

export async function createSnapTransaction(
  req: SnapTransactionRequest,
): Promise<SnapTransactionResponse> {
  if (!config.midtransServerKey) {
    throw new AppError("Midtrans server key is not configured.", 503);
  }
  const finishUrl = `${config.frontendUrl}/subscription/complete?order_id=${encodeURIComponent(req.orderId)}&status=success`;
  const pendingUrl = `${config.frontendUrl}/subscription/complete?order_id=${encodeURIComponent(req.orderId)}&status=pending`;
  const errorUrl = `${config.frontendUrl}/subscription/complete?order_id=${encodeURIComponent(req.orderId)}&status=failed`;

  const body = {
    transaction_details: {
      order_id: req.orderId,
      gross_amount: req.grossAmount,
    },
    item_details: [
      {
        id: "goalpath-premium-monthly",
        price: req.grossAmount,
        quantity: req.itemQuantity ?? 1,
        name: req.itemName ?? "GoalPath Premium - 1 Bulan",
      },
    ],
    customer_details: {
      first_name: req.customerName ?? "GoalPath",
      email: req.customerEmail ?? "noreply@goalpath.local",
      phone: req.customerPhone ?? "",
    },
    callbacks: {
      finish: finishUrl,
      pending: pendingUrl,
      error: errorUrl,
    },
  };

  const response = await fetch(`${MIDTRANS_BASE}/snap/v1/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: buildAuthHeader(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[Midtrans] create transaction failed:", response.status, text.slice(0, 400));
    throw new AppError(
      `Midtrans returned ${response.status}. Check MIDTRANS_SERVER_KEY and ensure you target the right sandbox/production mode.`,
      502,
    );
  }

  const data = (await response.json()) as SnapTransactionResponse;
  if (!data.token) {
    throw new AppError("Midtrans response did not include a Snap token.", 502);
  }
  return data;
}

export interface MidtransNotificationPayload {
  transaction_status: string;
  order_id: string;
  gross_amount: string;
  status_code: string;
  signature_key?: string;
  payment_type?: string;
  transaction_id?: string;
  fraud_status?: string;
  [key: string]: unknown;
}

/** Verify SHA512(order_id + status_code + gross_amount + server_key). */
export function verifyMidtransSignature(payload: {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
}): boolean {
  if (!config.midtransServerKey) return false;
  const input = `${payload.order_id}${payload.status_code}${payload.gross_amount}${config.midtransServerKey}`;
  const expected = createHash("sha512").update(input).digest("hex");
  return expected === payload.signature_key;
}

/**
 * Fetch authoritative transaction status from Midtrans Core API.
 *
 * Use case: dev environments where Midtrans webhooks cannot reach the
 * backend (localhost without a tunnel). The webhook handler stays as the
 * source of truth in production; this GET is a one-shot reconciliation
 * trigger we fire when the client asks for /subscription/refresh.
 *
 * Authenticated with Basic auth (server key as username, empty password),
 * same as createSnapTransaction. There is no signature to verify because
 * WE initiated the request — TLS plus server-key-authenticated response
 * is enough. We additionally cross-check `gross_amount` against our DB row
 * so a tampered Midtrans response can't activate premium for the wrong
 * amount.
 */
export interface MidtransTransactionStatus {
  transaction_status: string;
  status_code: string;
  gross_amount: string;
  payment_type?: string;
  transaction_id?: string;
  fraud_status?: string;
  [key: string]: unknown;
}

export async function getTransactionStatus(orderId: string): Promise<MidtransTransactionStatus> {
  if (!config.midtransServerKey) {
    throw new AppError("Midtrans server key is not configured.", 503);
  }
  const response = await fetch(
    `${MIDTRANS_API_BASE}/v2/${encodeURIComponent(orderId)}/status`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization:
          "Basic " + Buffer.from(`${config.midtransServerKey}:`).toString("base64"),
      },
    },
  );

  if (response.status === 404) {
    // Midtrans says the order_id is unknown / has been purged. Surface a
    // typed error so the caller can mark the local row as cancelled.
    throw new AppError(`Order ${orderId} not found at Midtrans.`, 404);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(
      "[Midtrans] status query failed:",
      response.status,
      text.slice(0, 400),
    );
    throw new AppError(
      `Midtrans status query failed: ${response.status}. Check MIDTRANS_SERVER_KEY and MIDTRANS_IS_PRODUCTION.`,
      502,
    );
  }

  return (await response.json()) as MidtransTransactionStatus;
}

/** Map Midtrans transaction_status onto our internal payment_transactions.status enum. */
export type InternalPaymentStatus = "pending" | "settlement" | "cancelled" | "failed";

export function mapMidtransStatus(midtransStatus: string): InternalPaymentStatus {
  switch (midtransStatus) {
    case "settlement":
    case "capture":
      return "settlement";
    case "pending":
      return "pending";
    case "cancel":
    case "deny":
    case "expire":
    case "refund":
      return "cancelled";
    default:
      return "failed";
  }
}
