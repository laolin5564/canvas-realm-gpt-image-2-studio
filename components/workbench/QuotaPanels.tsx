"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { Check, QrCode, Ticket, X } from "lucide-react";
import { discountPreviewLine, formatFenAsYuan, orderPaymentLine } from "@/components/workbench/discount-ui";
import type { AiImageDiscountPreview, AiImagePaymentResponse } from "@/components/workbench/types";

export function BuyCreditsModal({
  unitCount,
  order,
  paid,
  busy,
  quotaLoading,
  discountCode,
  discountPreview,
  discountError,
  discountBusy,
  onUnitCountChange,
  onDiscountCodeChange,
  onPreviewDiscount,
  onClearDiscount,
  onCreateOrder,
  onRefreshQuota,
  onClose,
}: {
  unitCount: number;
  order: AiImagePaymentResponse["order"] | null;
  paid: boolean;
  busy: boolean;
  quotaLoading: boolean;
  discountCode: string;
  discountPreview: AiImageDiscountPreview | null;
  discountError: string;
  discountBusy: boolean;
  onUnitCountChange: (value: number) => void;
  onDiscountCodeChange: (value: string) => void;
  onPreviewDiscount: () => void;
  onClearDiscount: () => void;
  onCreateOrder: () => void;
  onRefreshQuota: () => void;
  onClose: () => void;
}) {
  const [discountOpen, setDiscountOpen] = useState(false);

  // 份数改了但防抖重算还没回来时，上一份试算结果已经过期，不能拿它显示价格。
  const activePreview = discountPreview && discountPreview.unitCount === unitCount ? discountPreview : null;
  const previewStale = Boolean(discountPreview) && !activePreview;
  const discountPending = discountOpen && discountCode.length > 0 && !activePreview;
  const creditCount = activePreview ? activePreview.creditCount : unitCount * 10;

  function toggleDiscount(next: boolean): void {
    setDiscountOpen(next);
    if (!next) {
      onClearDiscount();
    }
  }

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

          <div className="ai-credit-discount">
            <label className="ai-credit-discount-toggle">
              <input
                type="checkbox"
                checked={discountOpen}
                onChange={(event) => toggleDiscount(event.target.checked)}
              />
              <Ticket size={15} aria-hidden="true" />
              <span>我有折扣码</span>
            </label>
            {discountOpen ? (
              <div className="ai-credit-discount-body">
                <div className="ai-credit-discount-row">
                  <input
                    className="input"
                    value={discountCode}
                    maxLength={32}
                    placeholder="输入折扣码，支持中文，例如 双十一"
                    aria-label="折扣码"
                    onChange={(event) => onDiscountCodeChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onPreviewDiscount();
                      }
                    }}
                  />
                  <button
                    className="button subtle"
                    type="button"
                    onClick={onPreviewDiscount}
                    disabled={discountBusy || discountCode.length === 0}
                  >
                    {discountBusy ? "验证中" : "验证"}
                  </button>
                </div>
                {discountError ? <p className="ai-credit-discount-error">{discountError}</p> : null}
                {activePreview ? <p className="ai-credit-discount-summary">{discountPreviewLine(activePreview)}</p> : null}
                {previewStale && !discountError ? (
                  <p className="ai-credit-discount-hint">份数已变更，正在按新份数重新计算折扣…</p>
                ) : null}
                {discountCode.length > 0 ? (
                  <button className="button subtle mini-button" type="button" onClick={onClearDiscount}>
                    清除折扣码
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="ai-credit-order-summary">
            <span>
              {unitCount} 份 = {creditCount} 次生成额度
            </span>
            {activePreview ? (
              <strong className="ai-credit-price-discounted">
                {activePreview.discountFen > 0 ? <s>{formatFenAsYuan(activePreview.originalPriceFen)}</s> : null}
                <em>{formatFenAsYuan(activePreview.chargedPriceFen)}</em>
              </strong>
            ) : (
              <strong>￥{unitCount.toFixed(2)}</strong>
            )}
          </div>
          <button className="button primary" type="button" onClick={onCreateOrder} disabled={busy || discountPending}>
            <QrCode size={16} aria-hidden="true" />
            {busy ? "创建订单中" : "下单并生成支付二维码"}
          </button>
          {discountPending ? (
            <p className="ai-credit-discount-hint">
              {previewStale || discountBusy ? "正在计算折扣，请稍候…" : "请先验证折扣码"}
            </p>
          ) : null}
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
                    : orderPaymentLine(order.totalPriceFen, order.generationCount, order.discount)}
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
