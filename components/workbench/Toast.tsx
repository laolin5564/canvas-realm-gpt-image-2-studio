"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import clsx from "clsx";

/**
 * 右上角 toast：3 秒自动消失、可叠放、role="status"。
 * 替换了工作台左栏底部那条常驻 toast-line（反馈藏在参数面板最下面，用户经常看不到）。
 */

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  text: string;
}

const toastDurationMs = 3000;
const maxVisibleToasts = 4;

export interface ToastController {
  toasts: ToastItem[];
  pushToast: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: string) => void;
}

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (text: string, tone: ToastTone = "info") => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const id = `toast_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      setToasts((current) => [...current, { id, tone, text: trimmed }].slice(-maxVisibleToasts));
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((current) => current.filter((item) => item.id !== id));
      }, toastDurationMs);
      timersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, pushToast, dismissToast };
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={clsx("toast-item", toast.tone)}>
          {toast.tone === "error" ? <AlertTriangle size={15} aria-hidden="true" /> : null}
          {toast.tone === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
          {toast.tone === "info" ? <Info size={15} aria-hidden="true" /> : null}
          <span>{toast.text}</span>
          <button className="toast-close" type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提示">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
