"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/components/client-api";
import type { ToastTone } from "@/components/workbench/Toast";
import { normalizeDiscountCode, validateDiscountCodeInput } from "@/components/workbench/discount-ui";
import {
  quotaRefreshEventName,
  type AiImageDiscountPreview,
  type AiImageDiscountPreviewResponse,
  type AiImageOrderStatusResponse,
  type AiImagePaymentResponse,
  type AiImageQuota,
  type AiImageQuotaResponse,
} from "@/components/workbench/types";

/** 份数变化后自动重新试算的防抖时长。 */
const discountPreviewDebounceMs = 300;

export interface QuotaController {
  quota: AiImageQuota | null;
  loading: boolean;
  refresh: () => Promise<void>;
  buyPanelOpen: boolean;
  activationPanelOpen: boolean;
  buyUnitCount: number;
  buyOrder: AiImagePaymentResponse["order"] | null;
  buyOrderPaid: boolean;
  buyBusy: boolean;
  activationCode: string;
  activationBusy: boolean;
  discountCode: string;
  discountPreview: AiImageDiscountPreview | null;
  discountError: string;
  discountBusy: boolean;
  setBuyUnitCount: (value: number) => void;
  setActivationCode: (value: string) => void;
  setDiscountCode: (value: string) => void;
  previewDiscount: () => void;
  clearDiscount: () => void;
  openBuyPanel: () => void;
  openActivationPanel: () => void;
  closeBuyPanel: () => void;
  closeActivationPanel: () => void;
  createOrder: () => void;
  exchangeCode: () => void;
}

/** AI 图片额度：余额、购买下单 + 支付轮询、折扣码试算、激活码兑换，都收在这一份状态里。 */
export function useQuota({
  notify,
  onError,
}: {
  notify: (text: string, tone?: ToastTone) => void;
  onError: (caught: unknown, fallback: string) => void;
}): QuotaController {
  const [quota, setQuota] = useState<AiImageQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [buyPanelOpen, setBuyPanelOpen] = useState(false);
  const [activationPanelOpen, setActivationPanelOpen] = useState(false);
  const [buyUnitCount, setBuyUnitCount] = useState(1);
  const [buyOrder, setBuyOrder] = useState<AiImagePaymentResponse["order"] | null>(null);
  const [buyOrderPaid, setBuyOrderPaid] = useState(false);
  const [buyBusy, setBuyBusy] = useState(false);
  const [activationCode, setActivationCode] = useState("");
  const [activationBusy, setActivationBusy] = useState(false);
  const [discountCode, setDiscountCodeState] = useState("");
  const [discountPreview, setDiscountPreview] = useState<AiImageDiscountPreview | null>(null);
  const [discountError, setDiscountError] = useState("");
  const [discountBusy, setDiscountBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiJson<AiImageQuotaResponse>("/api/billing/ai-image");
      setQuota(payload.quota);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!buyPanelOpen || !buyOrder || buyOrderPaid) {
      return;
    }
    let disposed = false;
    const timer = window.setInterval(() => {
      apiJson<AiImageOrderStatusResponse>(`/api/billing/ai-image?orderId=${encodeURIComponent(buyOrder.orderId)}`)
        .then(async (payload) => {
          if (disposed || !payload.status.paid) {
            return;
          }
          setBuyOrderPaid(true);
          if (payload.quota) {
            setQuota(payload.quota);
          } else {
            await refresh();
          }
          notify("支付成功，额度已刷新。", "success");
          window.dispatchEvent(new Event(quotaRefreshEventName));
        })
        .catch((caught: unknown) => {
          if (!disposed) {
            onError(caught, "查询支付状态失败");
          }
        });
    }, 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [buyOrder, buyOrderPaid, buyPanelOpen, notify, onError, refresh]);

  useEffect(() => {
    if (!buyPanelOpen || !buyOrderPaid) {
      return;
    }
    const timer = window.setTimeout(() => {
      setBuyPanelOpen(false);
      setBuyOrder(null);
      setBuyOrderPaid(false);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [buyOrderPaid, buyPanelOpen]);

  const resetDiscount = useCallback(() => {
    setDiscountCodeState("");
    setDiscountPreview(null);
    setDiscountError("");
    setDiscountBusy(false);
  }, []);

  /** 折扣码一改动就作废上一次的试算结果，避免拿旧价格下单。 */
  const setDiscountCode = useCallback((value: string) => {
    setDiscountCodeState(normalizeDiscountCode(value));
    setDiscountPreview(null);
    setDiscountError("");
  }, []);

  const runPreview = useCallback(
    (code: string, unitCount: number) => {
      const localError = validateDiscountCodeInput(code);
      if (localError) {
        setDiscountPreview(null);
        setDiscountError(localError);
        return;
      }
      setDiscountBusy(true);
      setDiscountError("");
      apiJson<AiImageDiscountPreviewResponse>("/api/billing/ai-image/discount/preview", {
        method: "POST",
        body: JSON.stringify({ discountCode: normalizeDiscountCode(code), unitCount }),
      })
        .then((payload) => {
          setDiscountPreview(payload.preview);
          setDiscountError("");
        })
        .catch((caught: unknown) => {
          setDiscountPreview(null);
          setDiscountError(caught instanceof Error ? caught.message : "折扣码验证失败");
        })
        .finally(() => setDiscountBusy(false));
    },
    [],
  );

  const previewDiscount = useCallback(() => {
    runPreview(discountCode, buyUnitCount);
  }, [buyUnitCount, discountCode, runPreview]);

  // 已验证通过的折扣码，份数一变就防抖重算，避免展示过期的折后价。
  useEffect(() => {
    if (!buyPanelOpen || !discountPreview || discountPreview.unitCount === buyUnitCount) {
      return;
    }
    const timer = window.setTimeout(() => runPreview(discountPreview.code, buyUnitCount), discountPreviewDebounceMs);
    return () => window.clearTimeout(timer);
  }, [buyPanelOpen, buyUnitCount, discountPreview, runPreview]);

  const createOrder = useCallback(() => {
    setBuyBusy(true);
    apiJson<AiImagePaymentResponse>("/api/billing/ai-image", {
      method: "POST",
      body: JSON.stringify({
        unitCount: buyUnitCount,
        ...(discountPreview ? { discountCode: discountPreview.code } : {}),
      }),
    })
      .then((payload) => {
        setBuyOrder(payload.order);
        setBuyOrderPaid(false);
        notify("支付后额度会自动到账。");
      })
      .catch((caught: unknown) => onError(caught, "创建支付订单失败"))
      .finally(() => setBuyBusy(false));
  }, [buyUnitCount, discountPreview, notify, onError]);

  const exchangeCode = useCallback(() => {
    const code = activationCode.trim().toUpperCase();
    if (!code) {
      notify("请输入激活码", "error");
      return;
    }
    setActivationBusy(true);
    apiJson<AiImageQuotaResponse>("/api/billing/ai-image", {
      method: "POST",
      body: JSON.stringify({ code }),
    })
      .then((payload) => {
        setQuota(payload.quota);
        window.dispatchEvent(new Event(quotaRefreshEventName));
        setActivationCode("");
        notify(payload.message ?? "激活码兑换成功，额度已刷新。", "success");
      })
      .catch((caught: unknown) => onError(caught, "激活码兑换失败"))
      .finally(() => setActivationBusy(false));
  }, [activationCode, notify, onError]);

  return {
    quota,
    loading,
    refresh,
    buyPanelOpen,
    activationPanelOpen,
    buyUnitCount,
    buyOrder,
    buyOrderPaid,
    buyBusy,
    activationCode,
    activationBusy,
    discountCode,
    discountPreview,
    discountError,
    discountBusy,
    setBuyUnitCount,
    setActivationCode,
    setDiscountCode,
    previewDiscount,
    clearDiscount: resetDiscount,
    openBuyPanel: useCallback(() => {
      setBuyPanelOpen(true);
      setActivationPanelOpen(false);
      setBuyOrder(null);
      setBuyOrderPaid(false);
      setBuyUnitCount(1);
      resetDiscount();
    }, [resetDiscount]),
    openActivationPanel: useCallback(() => {
      setActivationPanelOpen(true);
      setBuyPanelOpen(false);
      setActivationCode("");
    }, []),
    closeBuyPanel: useCallback(() => {
      setBuyPanelOpen(false);
      resetDiscount();
    }, [resetDiscount]),
    closeActivationPanel: useCallback(() => setActivationPanelOpen(false), []),
    createOrder,
    exchangeCode,
  };
}
