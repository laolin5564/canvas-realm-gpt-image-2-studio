"use client";

/* eslint-disable @next/next/no-img-element */
import { Check, QrCode, X } from "lucide-react";
import type { AiImagePaymentResponse } from "@/components/workbench/types";

export function BuyCreditsModal({
  unitCount,
  order,
  paid,
  busy,
  quotaLoading,
  onUnitCountChange,
  onCreateOrder,
  onRefreshQuota,
  onClose,
}: {
  unitCount: number;
  order: AiImagePaymentResponse["order"] | null;
  paid: boolean;
  busy: boolean;
  quotaLoading: boolean;
  onUnitCountChange: (value: number) => void;
  onCreateOrder: () => void;
  onRefreshQuota: () => void;
  onClose: () => void;
}) {
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="购买AI图片生成次数">
      <div className="admin-modal ai-credit-modal">
        <div className="ai-credit-modal-header">
          <div>
            <h2>购买AI图片生成次数</h2>
            <p>每 1 元购买 10 次生成额度，支付成功后自动刷新剩余额度。</p>
          </div>
          <button className="icon-button ghost" type="button" onClick={onClose} aria-label="关闭">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="ai-credit-modal-body">
          <label className="field">
            <span>购买份数</span>
            <input
              className="input"
              type="number"
              min={1}
              value={unitCount}
              onChange={(event) => onUnitCountChange(Math.max(Number.parseInt(event.target.value, 10) || 1, 1))}
            />
          </label>
          <div className="ai-credit-order-summary">
            <span>
              {unitCount} 份 = {unitCount * 10} 次生成额度
            </span>
            <strong>￥{unitCount.toFixed(2)}</strong>
          </div>
          <button className="button primary" type="button" onClick={onCreateOrder} disabled={busy}>
            <QrCode size={16} aria-hidden="true" />
            {busy ? "创建订单中" : "下单并生成支付二维码"}
          </button>
          {order ? (
            <div className="ai-credit-qr">
              <img
                src={`https://www.laolinyun.cn/api/qrcode.php?url=${encodeURIComponent(order.qrCodeUrl)}`}
                alt="AI图片生成次数银联支付二维码"
                decoding="async"
              />
              <div>
                <strong>订单 {order.orderId}</strong>
                <span>
                  {paid
                    ? "已支付，额度已刷新"
                    : `支付 ￥${(order.totalPriceFen / 100).toFixed(2)}，到账 ${order.generationCount} 次`}
                </span>
                {paid ? (
                  <div className="ai-credit-payment-success">
                    <Check size={16} aria-hidden="true" />
                    支付成功，3 秒后自动关闭弹窗
                  </div>
                ) : (
                  <span>正在监听支付结果，支付完成后自动刷新额度。</span>
                )}
                <button className="button subtle mini-button" type="button" onClick={onRefreshQuota} disabled={quotaLoading}>
                  我已支付，刷新额度
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ActivationCodeModal({
  code,
  busy,
  onCodeChange,
  onExchange,
  onClose,
}: {
  code: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onExchange: () => void;
  onClose: () => void;
}) {
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="激活码兑换">
      <div className="admin-modal ai-credit-modal">
        <div className="ai-credit-modal-header">
          <div>
            <h2>激活码兑换</h2>
            <p>输入激活码并点击兑换按钮，兑换成功后自动刷新额度。</p>
          </div>
          <button className="icon-button ghost" type="button" onClick={onClose} aria-label="关闭">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="ai-credit-modal-body">
          <div className="ai-credit-exchange">
            <div className="ai-credit-exchange-row">
              <input
                className="input"
                value={code}
                onChange={(event) => onCodeChange(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onExchange();
                  }
                }}
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
              />
              <button className="button subtle" type="button" onClick={onExchange} disabled={busy}>
                {busy ? "兑换中" : "兑换"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
