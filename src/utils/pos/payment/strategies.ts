import type { AdminOrder, AdminPaymentSession } from "@medusajs/types";

export const TILLTAP_PROVIDER_ID = "pp_tilltap_default";
export const TILLTAP_ATTEMPT_METADATA_KEY = "tilltap_payment_attempt";

export type PaymentStrategy = "synchronous" | "asynchronous";

export type PaymentSessionSnapshot = Pick<
  AdminPaymentSession,
  "id" | "amount" | "currency_code" | "provider_id" | "status" | "data"
>;

export type PaymentProcessingResult =
  | { strategy: PaymentStrategy; alreadySettled: true }
  | { strategy: "synchronous" }
  | { strategy: "asynchronous"; session: PaymentSessionSnapshot };

type PaymentCollectionSnapshot = {
  id: string;
  payment_sessions?: PaymentSessionSnapshot[];
  payments?: Array<{
    id: string;
    provider_id?: string;
    captured_at?: Date | string | null;
  }>;
};

export type PaymentProcessingDependencies = {
  createCollection: (orderId: string, amount: number) => Promise<PaymentCollectionSnapshot>;
  createPaymentSession: (
    collectionId: string,
    providerId: string
  ) => Promise<PaymentCollectionSnapshot>;
  capturePayment: (paymentId: string) => Promise<void>;
  markAsPaid: (collectionId: string, orderId: string, providerId?: string) => Promise<void>;
  persistAsyncAttempt: (
    order: AdminOrder,
    sessionId?: string
  ) => Promise<void>;
};

export function getPaymentStrategy(providerId: string): PaymentStrategy {
  return providerId === TILLTAP_PROVIDER_ID ? "asynchronous" : "synchronous";
}

export function canFinalizeOrder(
  order: Pick<AdminOrder, "payment_status">
): boolean {
  return order.payment_status === "captured";
}

export function findTilltapPaymentSession(
  order: Pick<AdminOrder, "payment_collections">,
  sessionId?: string
): PaymentSessionSnapshot | undefined {
  const sessions =
    order.payment_collections?.flatMap(
      (collection) => collection.payment_sessions ?? []
    ) ?? [];
  const requestedSession = sessionId
    ? sessions.find(
        (session) =>
          session.id === sessionId &&
          session.provider_id === TILLTAP_PROVIDER_ID
      )
    : undefined;

  return (
    requestedSession ??
    sessions.find((session) => session.provider_id === TILLTAP_PROVIDER_ID)
  );
}

export function hasTilltapPaymentSession(
  order: Pick<AdminOrder, "payment_collections">
): boolean {
  return !!findTilltapPaymentSession(order);
}

export function findUncapturedTilltapPaymentId(
  order: Pick<AdminOrder, "payment_collections">,
  sessionId: string
): string | undefined {
  const collection = order.payment_collections?.find((candidate) =>
    candidate.payment_sessions?.some(
      (session) =>
        session.id === sessionId &&
        session.provider_id === TILLTAP_PROVIDER_ID
    )
  );
  return collection?.payments?.find(
    (payment) =>
      payment.provider_id === TILLTAP_PROVIDER_ID && !payment.captured_at
  )?.id;
}

export function isTilltapOrder(
  order: Pick<AdminOrder, "payment_collections" | "metadata">
): boolean {
  if (hasTilltapPaymentSession(order)) return true;

  const marker = order.metadata?.[TILLTAP_ATTEMPT_METADATA_KEY];
  return (
    typeof marker === "object" &&
    marker !== null &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>).provider_id === TILLTAP_PROVIDER_ID
  );
}

export function canReleaseGoods(
  order: Pick<
    AdminOrder,
    "payment_status" | "payment_collections" | "metadata"
  >
): boolean {
  return !isTilltapOrder(order);
}

export async function requireAuthoritativeGoodsRelease(
  refreshOrder: () => Promise<AdminOrder>
): Promise<void> {
  const refreshedOrder = await refreshOrder();
  if (isTilltapOrder(refreshedOrder)) {
    throw new Error(
      "Automatic goods release is disabled for Tilltap pilot orders pending signed reconciliation"
    );
  }
}

export function canIssueReceipt(
  order: Pick<AdminOrder, "payment_collections" | "metadata">
): boolean {
  return !isTilltapOrder(order);
}

export async function requireAuthoritativeReceipt(
  refreshOrder: () => Promise<AdminOrder>
): Promise<void> {
  const refreshedOrder = await refreshOrder();
  if (!canIssueReceipt(refreshedOrder)) {
    throw new Error(
      "Paid receipts are disabled for Tilltap pilot orders pending signed reconciliation"
    );
  }
}

export function canRecordPayment(
  order: Pick<
    AdminOrder,
    "status" | "payment_status" | "payment_collections" | "metadata"
  >
): boolean {
  if (order.status === "canceled" || isTilltapOrder(order)) return false;

  return (
    order.payment_status === "not_paid" ||
    order.payment_status === "awaiting" ||
    order.payment_status === "requires_action" ||
    order.payment_status === "partially_authorized" ||
    order.payment_status === "partially_captured"
  );
}

export async function finalizeOrderIfPaid(
  order: AdminOrder,
  finalize: (paidOrder: AdminOrder) => Promise<void>
): Promise<boolean> {
  if (!canFinalizeOrder(order) || isTilltapOrder(order)) return false;
  await finalize(order);
  return true;
}

export async function processPaymentWithStrategy(
  order: AdminOrder,
  providerId: string,
  dependencies: PaymentProcessingDependencies
): Promise<PaymentProcessingResult> {
  const strategy = getPaymentStrategy(providerId);
  if (canFinalizeOrder(order)) return { strategy, alreadySettled: true };

  if (strategy === "asynchronous") {
    const existingSession = findTilltapPaymentSession(order);
    if (existingSession) return { strategy, session: existingSession };
  } else if (order.payment_status === "authorized") {
    const existingPayment = order.payment_collections
      ?.flatMap((collection) => collection.payments ?? [])
      .find((payment) => !payment.captured_at);
    if (existingPayment) {
      await dependencies.capturePayment(existingPayment.id);
      return { strategy };
    }
  }

  let collectionId = order.payment_collections?.[0]?.id;
  if (!collectionId) {
    const amount = order.summary?.accounting_total || order.total || 0;
    const collection = await dependencies.createCollection(order.id, amount);
    collectionId = collection.id;
  }

  // The server marker is durable before the provider request. If the response is
  // lost, recovery uses the payment session attached to the order and never
  // creates a replacement.
  if (strategy === "asynchronous") {
    await dependencies.persistAsyncAttempt(order);
  }

  const collection = await dependencies.createPaymentSession(
    collectionId,
    providerId
  );

  if (strategy === "asynchronous") {
    const providerSessions = (collection.payment_sessions ?? []).filter(
      (session) => session.provider_id === providerId
    );
    const session = providerSessions[providerSessions.length - 1];
    if (!session) {
      throw new Error("Tilltap payment session was not returned by Medusa");
    }
    await dependencies.persistAsyncAttempt(order, session.id);
    return { strategy, session };
  }

  if (collection.payments?.some((payment) => !!payment.captured_at)) {
    return { strategy };
  }

  const pendingPayment = collection.payments?.find(
    (payment) => !payment.captured_at
  );
  if (pendingPayment) {
    await dependencies.capturePayment(pendingPayment.id);
    return { strategy };
  }

  try {
    await dependencies.markAsPaid(collectionId, order.id, providerId);
  } catch {
    await dependencies.markAsPaid(collectionId, order.id);
  }

  return { strategy };
}
