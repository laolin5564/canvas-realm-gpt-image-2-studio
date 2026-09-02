import { imageConcurrencyLimits } from "./types";

export function normalizeImageConcurrency(value: unknown, fallback: number = imageConcurrencyLimits.min): number {
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.min(Math.max(candidate, imageConcurrencyLimits.min), imageConcurrencyLimits.max);
}

// 进程级信号量：任务级并发（image_concurrency）只约束「同时在跑几个任务」，
// 单个任务内部还会按 n=1 拆成多个上游请求，叠加起来可能瞬间打爆中转网关。
// 所有对上游的生图请求都必须先拿到这里的槽位。
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get maxConcurrency(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => {
        // 槽位由 release 直接移交，因此 active 计数在等待期间保持不变。
        this.waiters.push(resolve);
      });
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export const defaultUpstreamImageMaxInflight = 20;

export function resolveUpstreamImageMaxInflight(
  raw: string | undefined = process.env.IMAGE_UPSTREAM_MAX_INFLIGHT,
): number {
  if (raw === undefined || raw.trim() === "") {
    return defaultUpstreamImageMaxInflight;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return defaultUpstreamImageMaxInflight;
  }
  return Math.floor(numeric);
}

let upstreamSemaphore: Semaphore | null = null;

export function upstreamImageSemaphore(): Semaphore {
  if (!upstreamSemaphore) {
    upstreamSemaphore = new Semaphore(resolveUpstreamImageMaxInflight());
  }
  return upstreamSemaphore;
}

export function withUpstreamImageSlot<T>(operation: () => Promise<T>): Promise<T> {
  return upstreamImageSemaphore().run(operation);
}

// 仅供测试：让下一次 upstreamImageSemaphore() 重新读取环境变量。
export function resetUpstreamImageSemaphore(): void {
  upstreamSemaphore = null;
}
