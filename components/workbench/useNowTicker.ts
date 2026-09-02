"use client";

import { useEffect, useState } from "react";

/** 每秒推进一次的时间戳，只在有任务在跑时启动，用来驱动占位卡的已用时计时器。 */
export function useNowTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return now;
}
