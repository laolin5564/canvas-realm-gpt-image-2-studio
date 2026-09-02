"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/components/client-api";
import type { ToastTone } from "@/components/workbench/Toast";
import {
  quotaRefreshEventName,
  type AiImageOrderStatusResponse,
  type AiImagePaymentResponse,
  type AiImageQuota,
  type AiImageQuotaResponse,
} from "@/components/workbench/types";

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
  setBuyUnitCount: (value: number) => void;
  setActivationCode: (value: string) => void;
  openBuyPanel: () => void;
  openActivationPanel: () => void;
  closeBuyPanel: () => void;
  closeActivationPanel: () => void;
  createOrder: () => void;
  exchangeCode: () => void;
}

/** AI 图片额度：余额、购买下单 + 支付轮询、激活码兑换，都收在这一份状态里。 */
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

  const createOrder = useCallback(() => {
    setBuyBusy(true);
    apiJson<AiImagePaymentResponse>("/api/billing/ai-image", {
      method: "POST",
      body: JSON.stringify({ unitCount: buyUnitCount }),
    })
      .then((payload) => {
        setBuyOrder(payload.order);
        setBuyOrderPaid(false);
        notify("支付后额度会自动到账。");
      })
      .catch((caught: unknown) => onError(caught, "创建支付订单失败"))
      .finally(() => setBuyBusy(false));
  }, [buyUnitCount, notify, onError]);

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
    setBuyUnitCount,
    setActivationCode,
    openBuyPanel: useCallback(() => {
      setBuyPanelOpen(true);
      setActivationPanelOpen(false);
      setBuyOrder(null);
      setBuyOrderPaid(false);
      setBuyUnitCount(1);
    }, []),
    openActivationPanel: useCallback(() => {
      setActivationPanelOpen(true);
      setBuyPanelOpen(false);
      setActivationCode("");
    }, []),
    closeBuyPanel: useCallback(() => setBuyPanelOpen(false), []),
    closeActivationPanel: useCallback(() => setActivationPanelOpen(false), []),
    createOrder,
    exchangeCode,
  };
}
