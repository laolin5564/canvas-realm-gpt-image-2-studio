"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, isUnauthorizedError } from "@/components/client-api";
import { shouldAcceptResponse, shouldPollNow, shouldReportPollFailure } from "@/components/workbench/polling";

export interface PollingOptions<T> {
  /** 轮询目标（会话 id）；变化时中止在途请求并让旧响应作废。null 表示不轮询。 */
  key: string | null;
  /** 本轮间隔，调用方用 nextPollDelayMs(hasActiveTasks) 算好。 */
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  onUnauthorized: () => void;
  /** 连续失败达到阈值时才提示一次，偶发抖动静默重试。 */
  onPersistentFailure: (error: Error) => void;
}

export interface PollingController {
  refresh: () => void;
}

/**
 * 会话轮询：
 * - document.visibilityState 为 hidden 时完全不发请求；
 * - 每次请求带自增序号，旧响应到达时直接丢弃；
 * - 切换 / 删除会话时用 AbortController 中止在途请求；
 * - 失败静默重试，连续 3 次才提示；401 交给调用方跳登录。
 */
export function usePolling<T>({
  key,
  intervalMs,
  run,
  apply,
  onUnauthorized,
  onPersistentFailure,
}: PollingOptions<T>): PollingController {
  const runRef = useRef(run);
  const applyRef = useRef(apply);
  const unauthorizedRef = useRef(onUnauthorized);
  const failureRef = useRef(onPersistentFailure);
  const keyRef = useRef(key);
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const failuresRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [visible, setVisible] = useState(true);

  runRef.current = run;
  applyRef.current = apply;
  unauthorizedRef.current = onUnauthorized;
  failureRef.current = onPersistentFailure;
  keyRef.current = key;

  const tick = useCallback(async () => {
    if (!keyRef.current || typeof document === "undefined" || !shouldPollNow(document.visibilityState)) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    seqRef.current += 1;
    const seq = seqRef.current;

    try {
      const value = await runRef.current(controller.signal);
      if (!shouldAcceptResponse(seq, appliedSeqRef.current)) {
        return;
      }
      appliedSeqRef.current = seq;
      failuresRef.current = 0;
      applyRef.current(value);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        unauthorizedRef.current();
        return;
      }
      failuresRef.current += 1;
      if (shouldReportPollFailure(failuresRef.current)) {
        failuresRef.current = 0;
        failureRef.current(error instanceof Error ? error : new Error("刷新会话失败"));
      }
    }
  }, []);

  // 切换 / 删除会话：中止在途请求，并把已应用序号推到最新，让旧响应彻底作废。
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    appliedSeqRef.current = seqRef.current;
    failuresRef.current = 0;
  }, [key]);

  useEffect(() => {
    const sync = () => setVisible(shouldPollNow(document.visibilityState));
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    if (!key || !visible) {
      return;
    }

    let disposed = false;
    let timer = 0;

    const loop = () => {
      timer = window.setTimeout(() => {
        void tick().finally(() => {
          if (!disposed) {
            loop();
          }
        });
      }, intervalMs);
    };

    void tick();
    loop();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [intervalMs, key, tick, visible]);

  const refresh = useCallback(() => {
    void tick();
  }, [tick]);

  return { refresh };
}
