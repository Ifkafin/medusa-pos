import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  TILLTAP_PROVIDER_ID,
  type PaymentSessionSnapshot,
} from "./strategies";

export type TilltapCapabilityStatus =
  | "pending"
  | "confirmed"
  | "review"
  | "failed";

export type TilltapPresentation = {
  checkoutUrl: string;
  statusUrl: string;
  checkoutId: string;
  expiresAt: number;
  simulation: boolean;
};

type TilltapCheckoutStatus =
  | "OPEN"
  | "PAYMENT_PENDING"
  | "PAID"
  | "NOT_PAID"
  | "REVIEW"
  | "CANCELLED"
  | "EXPIRED";

const CHECKOUT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`Tilltap payment session has an invalid ${field}`);
  }
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Tilltap payment session has an invalid ${field}`);
  }
  return value;
};

const requireEpochMilliseconds = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Tilltap payment session has an invalid ${field}`);
  }
  return value as number;
};

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost";

export const parseTrustedOrigin = (rawOrigin: string | undefined): string => {
  if (!rawOrigin) throw new Error("Tilltap trusted origin is not configured");

  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error("Tilltap trusted origin is invalid");
  }
  const localHttp = url.protocol === "http:" && isLocalHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Tilltap trusted origin is invalid");
  }
  return url.origin;
};

export function validateTilltapAttemptPrerequisites(
  currencyCode: string | undefined,
  amount: number,
  rawTrustedOrigin: string | undefined
): string {
  const trustedOrigin = parseTrustedOrigin(rawTrustedOrigin);
  if (currencyCode?.toLowerCase() !== "kes") {
    throw new Error("Tilltap checkout requires a KES order");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Tilltap checkout requires a positive integer amount");
  }
  return trustedOrigin;
}

const parseTrustedUrl = (
  value: unknown,
  field: string,
  trustedOrigin: string
): URL => {
  const rawUrl = requireString(value, field);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Tilltap payment session has an invalid ${field}`);
  }
  if (
    url.origin !== trustedOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Tilltap payment session has an untrusted ${field}`);
  }
  return url;
};

export function getTilltapPresentation(
  session: PaymentSessionSnapshot,
  rawTrustedOrigin: string | undefined,
  expectedAmount?: number
): TilltapPresentation {
  if (session.provider_id !== TILLTAP_PROVIDER_ID) {
    throw new Error("Tilltap payment session has an invalid provider_id");
  }
  const trustedOrigin = validateTilltapAttemptPrerequisites(
    session.currency_code,
    session.amount,
    rawTrustedOrigin
  );
  if (expectedAmount !== undefined && session.amount !== expectedAmount) {
    throw new Error("Tilltap payment session does not match the order amount");
  }
  const checkoutUrl = parseTrustedUrl(
    session.data.checkout_url,
    "checkout_url",
    trustedOrigin
  );
  const statusUrl = parseTrustedUrl(
    session.data.status_url,
    "status_url",
    trustedOrigin
  );

  const checkoutToken = checkoutUrl.pathname.match(
    /^\/checkout\/([A-Za-z0-9_-]{43})$/
  )?.[1];
  const statusToken = statusUrl.pathname.match(
    /^\/api\/checkouts\/([A-Za-z0-9_-]{43})\/status$/
  )?.[1];
  if (
    !checkoutToken ||
    !statusToken ||
    !CHECKOUT_TOKEN_PATTERN.test(checkoutToken) ||
    checkoutToken !== statusToken
  ) {
    throw new Error("Tilltap checkout and status URLs do not share the expected token");
  }

  const expiresAt = requireEpochMilliseconds(
    session.data.expires_at,
    "expires_at"
  );
  const expiresAtDate = new Date(expiresAt);
  if (Number.isNaN(expiresAtDate.getTime())) {
    throw new Error("Tilltap payment session has an invalid expires_at");
  }

  return {
    checkoutUrl: checkoutUrl.toString(),
    statusUrl: statusUrl.toString(),
    checkoutId: requireString(session.data.checkout_id, "checkout_id"),
    expiresAt,
    simulation: requireBoolean(session.data.simulation, "simulation"),
  };
}

export function parseTilltapCapabilityStatus(
  body: unknown,
  presentation: Pick<
    TilltapPresentation,
    "checkoutId" | "expiresAt" | "simulation"
  >
): TilltapCapabilityStatus {
  if (!isRecord(body)) throw new Error("Tilltap status response is invalid");

  const id = requireString(body.id, "status id");
  const expiresAt = requireEpochMilliseconds(body.expiresAt, "status expiresAt");
  const simulation = requireBoolean(body.simulation, "status simulation");
  if (id !== presentation.checkoutId) {
    throw new Error("Tilltap status response does not match checkout_id");
  }
  if (expiresAt !== presentation.expiresAt || simulation !== presentation.simulation) {
    throw new Error("Tilltap status response does not match the payment session");
  }
  if (body.receipt !== undefined && typeof body.receipt !== "string") {
    throw new Error("Tilltap status response has an invalid receipt");
  }

  const status = body.status as TilltapCheckoutStatus;
  if (status === "OPEN" || status === "PAYMENT_PENDING") return "pending";
  if (status === "REVIEW") return "review";
  if (status === "PAID") {
    return !simulation && body.receipt?.trim() ? "confirmed" : "review";
  }
  if (
    status === "NOT_PAID" ||
    status === "CANCELLED" ||
    status === "EXPIRED"
  ) {
    return "failed";
  }
  throw new Error("Tilltap status response has an unknown status");
}

export async function fetchTilltapCapabilityStatus(
  presentation: TilltapPresentation,
  signal?: AbortSignal
): Promise<TilltapCapabilityStatus> {
  // status_url is a short-lived, provider-issued capability. Do not attach the
  // Medusa JWT or any merchant secret to this cross-origin request.
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), 10_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let response: Response;
  try {
    response = await tauriFetch(presentation.statusUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`Tilltap status request failed with HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  return parseTilltapCapabilityStatus(body, presentation);
}
