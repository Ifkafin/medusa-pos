import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QrCode, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TilltapPaymentPresentation } from "@/hooks/order/useOrderProcessing";

type TilltapPaymentProps = {
  payment: TilltapPaymentPresentation;
  isProcessing: boolean;
  onCheckStatus: () => void;
  onClose: () => void;
};

const statusLabel = (status: string): string =>
  status.toLowerCase().replace(/_/g, " ");

export default function TilltapPayment({
  payment,
  isProcessing,
  onCheckStatus,
  onClose,
}: TilltapPaymentProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>();

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(payment.checkoutUrl, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111827", light: "#ffffff" },
    }).then((value) => {
      if (active) setQrDataUrl(value);
    });
    return () => {
      active = false;
    };
  }, [payment.checkoutUrl]);

  const paidEvidence = payment.tilltapStatus === "PAID";
  const reviewRequired = payment.tilltapStatus === "REVIEW";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl grid gap-8 md:grid-cols-[340px_1fr] items-center">
        <div className="rounded-2xl bg-white p-3 shadow-sm border border-theme-border">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Tilltap customer checkout QR code"
              className="block w-full aspect-square"
            />
          ) : (
            <div className="aspect-square grid place-items-center text-fg-subtle">
              <QrCode className="h-20 w-20" />
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Tilltap QR Pay
            </p>
            <h2 className="mt-2 text-3xl font-bold text-fg">
              Customer scans to pay
            </h2>
            <p className="mt-2 text-fg-muted">
              Scan with the Tilltap customer app or the phone camera. The customer confirms their own phone number and M-PESA PIN.
            </p>
          </div>

          <div className="rounded-xl bg-surface-muted p-4 border border-theme-border">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-fg-muted">Checkout status</span>
              <span className="rounded-full bg-surface px-3 py-1 text-sm font-semibold uppercase text-fg">
                {statusLabel(payment.tilltapStatus)}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 text-sm">
              <span className="text-fg-muted">Expires</span>
              <span className="font-medium text-fg">
                {new Date(payment.expiresAt).toLocaleTimeString()}
              </span>
            </div>
          </div>

          {(paidEvidence || reviewRequired || payment.captureBlockedReason) && (
            <div className="flex gap-3 rounded-xl border border-amber-400/50 bg-amber-500/10 p-4 text-sm text-fg">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <p>
                {reviewRequired
                  ? "Operator review is required. Do not retry the payment or release goods."
                  : "Sandbox payment evidence was received. This controlled pilot still blocks automatic goods release."}
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              onClick={onCheckStatus}
              disabled={isProcessing}
              className="h-14 text-base font-semibold"
            >
              <RefreshCw className={`mr-2 h-5 w-5 ${isProcessing ? "animate-spin" : ""}`} />
              {isProcessing ? "Checking…" : "Check payment"}
            </Button>
            <Button
              variant="outline"
              onClick={() => void openUrl(payment.checkoutUrl)}
              disabled={isProcessing}
              className="h-14 text-base font-semibold"
            >
              Open checkout
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isProcessing}
            className="w-full h-12"
          >
            Leave order awaiting payment
          </Button>
        </div>
      </div>
    </div>
  );
}
