import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  CircleX,
  Clock3,
  ExternalLink,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/utils/helpers";
import { useTranslation } from "@/i18n";
import type { TilltapPaymentState } from "../hooks";

type Props = {
  amount: number;
  currency: string;
  isLoading: boolean;
  isProcessing: boolean;
  state: TilltapPaymentState | null;
  onStart: () => void;
  onClose: () => void;
};

const formatExpiry = (expiresAt?: string): string | null => {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
};

const TilltapPayment = ({
  amount,
  currency,
  isLoading,
  isProcessing,
  state,
  onStart,
  onClose,
}: Props) => {
  const { t } = useTranslation();
  const [qrCode, setQrCode] = useState<{
    checkoutUrl: string;
    dataUrl: string;
  } | null>(null);
  const showPayerLink =
    state?.phase === "pending" &&
    !state.providerConfirmed &&
    !!state.checkoutUrl;

  useEffect(() => {
    if (!showPayerLink || !state?.checkoutUrl) {
      return;
    }

    const checkoutUrl = state.checkoutUrl;
    let cancelled = false;
    void QRCode.toDataURL(checkoutUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) {
          setQrCode({ checkoutUrl, dataUrl: url });
        }
      })
      .catch(() => {
        if (!cancelled) setQrCode(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showPayerLink, state?.checkoutUrl]);

  const expiry = formatExpiry(state?.expiresAt);
  const qrDataUrl =
    qrCode && qrCode.checkoutUrl === state?.checkoutUrl ? qrCode.dataUrl : null;
  const unresolved = state?.phase === "review";
  const failed = state?.phase === "failure";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-xl border border-theme-border-strong bg-surface-muted p-4 text-fg">
          <div className="text-xs font-bold uppercase tracking-widest">
            {t("checkout.tilltap.pilot_title")}
          </div>
          <p className="mt-1 text-sm">
            {t("checkout.tilltap.training_notice")}
          </p>
        </div>

        <div className="text-center">
          <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("checkout.tilltap.immutable_amount")}
          </div>
          <div className="mt-2 text-5xl font-bold text-fg sm:text-7xl">
            {formatPrice(amount, currency)}
          </div>
        </div>

        {!state && (isLoading || isProcessing) && (
          <div className="rounded-xl border border-theme-border bg-surface p-8 text-center">
            <LoaderCircle className="mx-auto h-10 w-10 animate-spin text-fg-muted" />
            <p className="mt-4 font-semibold text-fg">
              {t("checkout.tilltap.preparing")}
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              {t("checkout.tilltap.do_not_close")}
            </p>
          </div>
        )}

        {!state && !isLoading && !isProcessing && (
          <div className="space-y-4 rounded-xl border border-theme-border bg-surface p-6 text-center">
            <p className="text-fg-muted">
              {t("checkout.tilltap.start_notice")}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                variant="outline"
                onClick={onClose}
                className="h-14 flex-1 text-base"
              >
                {t("common.cancel")}
              </Button>
              <Button onClick={onStart} className="h-14 flex-1 text-base font-bold">
                {t("checkout.tilltap.start_button")}
              </Button>
            </div>
          </div>
        )}

        {showPayerLink && (
          <div className="grid gap-5 rounded-xl border border-theme-border bg-surface p-5 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="mx-auto h-[280px] w-[280px] max-w-full rounded-lg bg-white p-2">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={t("checkout.tilltap.qr_alt")}
                  className="h-full w-full"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <LoaderCircle className="h-9 w-9 animate-spin text-fg-muted" />
                </div>
              )}
            </div>
            <div className="space-y-4 text-center sm:text-left">
              <div>
                <div className="font-bold text-fg">
                  {t("checkout.tilltap.payment_pending")}
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  {t("checkout.tilltap.payer_instructions")}
                </p>
              </div>
              <a
                href={state.checkoutUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-theme-border px-4 py-3 font-semibold text-fg hover:bg-surface-hover"
              >
                {t("checkout.tilltap.open_link")}
                <ExternalLink className="h-4 w-4" />
              </a>
              {expiry && (
                <div className="flex items-center justify-center gap-2 text-sm text-fg-muted sm:justify-start">
                  <Clock3 className="h-4 w-4" />
                  {t("checkout.tilltap.expires", { expiry })}
                </div>
              )}
              <p className="text-sm font-semibold text-fg">
                {t("checkout.tilltap.waiting")}
              </p>
            </div>
          </div>
        )}

        {state?.phase === "pending" && state.providerConfirmed && (
          <div className="rounded-xl border border-theme-border-strong bg-surface-muted p-6 text-center text-fg">
            <LoaderCircle className="mx-auto h-10 w-10 animate-spin" />
            <h3 className="mt-4 text-lg font-bold">
              {t("checkout.tilltap.waiting_medusa_title")}
            </h3>
            <p className="mt-2 text-sm">
              {t("checkout.tilltap.waiting_medusa_message")}
            </p>
          </div>
        )}

        {unresolved && (
          <div className="rounded-xl border border-theme-border-strong bg-surface-muted p-6 text-center text-fg">
            <ShieldAlert className="mx-auto h-11 w-11" />
            <h3 className="mt-4 text-xl font-bold">
              {t("checkout.tilltap.review_title")}
            </h3>
            <p className="mt-2">
              {t("checkout.tilltap.review_message")}
            </p>
            {state.orderDisplayId != null && (
              <p className="mt-3 font-semibold">
                {t("checkout.tilltap.recover_order", {
                  displayId: state.orderDisplayId,
                })}
              </p>
            )}
            <Button variant="outline" onClick={onClose} className="mt-5 h-12 px-8">
              {t("checkout.tilltap.close_review")}
            </Button>
          </div>
        )}

        {failed && (
          <div className="rounded-xl border border-theme-border-strong bg-surface-muted p-6 text-center text-fg">
            <CircleX className="mx-auto h-11 w-11" />
            <h3 className="mt-4 text-xl font-bold">
              {t("checkout.tilltap.failure_title")}
            </h3>
            <p className="mt-2">
              {t("checkout.tilltap.failure_message")}
            </p>
            {expiry && (
              <p className="mt-3 text-sm">
                {t("checkout.tilltap.expiry", { expiry })}
              </p>
            )}
            {state.orderDisplayId != null && (
              <p className="mt-3 font-semibold">
                {t("checkout.tilltap.order", {
                  displayId: state.orderDisplayId,
                })}
              </p>
            )}
            <Button variant="outline" onClick={onClose} className="mt-5 h-12 px-8">
              {t("checkout.tilltap.close_recovery")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TilltapPayment;
