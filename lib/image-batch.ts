// 生图批次调度：把「一批 n=1 请求怎么发、失败怎么补、什么时候换渠道」这套逻辑
// 从 image-provider 里拆出来，既避免和 HTTP/DB 细节纠缠，也方便单测。

import { imageErrorStatus } from "./image-retry";
import { isModelTimeoutMessage } from "./model-error";

/**
 * 超时类错误：这次请求已经把整个超时窗口（默认 300s）烧完了。
 * 在同一渠道原地补发等于再烧一遍，用户要等 600s 才看到失败，所以超时一律直接切下一渠道。
 */
export function isImageTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "TimeoutError";
  }
  const status = imageErrorStatus(error);
  if (status === 504 || status === 524) {
    return true;
  }
  return isModelTimeoutMessage(error instanceof Error ? error.message : String(error ?? ""));
}

export interface ImageBatchOptions<TImage> {
  /** 任务需要的总张数。 */
  total: number;
  /** 单批最多同时发多少个上游请求。 */
  concurrency: number;
  /** 发一个 n=1 请求，返回本次拿到的图片（正常是 1 张）。 */
  request: () => Promise<TImage[]>;
  /** 交付一张图片（落盘 + 入库）。 */
  deliver: (image: TImage) => Promise<void>;
  /** 已交付张数（由调用方维护，含续跑时上个进程已落库的部分，跨渠道共享）。 */
  delivered: () => number;
  isAbort: (error: unknown) => boolean;
  isRetryable: (error: unknown) => boolean;
  /**
   * 可重试、但不该在本渠道原地补发的错误（默认：超时）。命中就直接上抛，
   * 交给 runAcrossChannels 换下一个渠道。
   */
  shouldSwitchChannel?: (error: unknown) => boolean;
  /** 同一渠道内一批请求失败后最多补发几轮，默认 1。 */
  maxRetriesPerBatch?: number;
}

/**
 * 在单个渠道内把任务剩余张数生成完。
 * 每个请求独立完成、独立交付：一张失败不会连累同批已经成功的图片，
 * 补发时只补失败的那几张。
 */
export async function runImageGenerationBatches<TImage>(options: ImageBatchOptions<TImage>): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const maxRetries = options.maxRetriesPerBatch ?? 1;
  const shouldSwitchChannel = options.shouldSwitchChannel ?? isImageTimeoutError;
  const remaining = (): number => options.total - options.delivered();

  let retryBudget = maxRetries;
  // 正在落库、还没计入 delivered() 的张数，避免并行请求各自多交付一张。
  let deliveringCount = 0;

  while (remaining() > 0) {
    const batchSize = Math.min(remaining(), concurrency);
    const outcomes = await Promise.allSettled(
      Array.from({ length: batchSize }, async () => {
        const images = await options.request();
        if (images.length === 0) {
          throw new Error("image-2 未返回图片数据");
        }
        for (const image of images) {
          if (options.delivered() + deliveringCount >= options.total) {
            return;
          }
          deliveringCount += 1;
          try {
            await options.deliver(image);
          } finally {
            deliveringCount -= 1;
          }
        }
      }),
    );

    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);

    const aborted = failures.find((reason) => options.isAbort(reason));
    if (aborted !== undefined) {
      throw aborted;
    }

    if (failures.length === 0) {
      retryBudget = maxRetries;
      continue;
    }

    // 不可重试的错误（参数错误 / 内容审核 / 4xx）直接上抛，由调用方决定是否终止。
    const fatal = failures.find((reason) => !options.isRetryable(reason));
    if (fatal !== undefined) {
      throw fatal;
    }

    // 超时不在本渠道补发：直接上抛，让 failover 去下一个渠道，避免 300s + 300s 的连环等待。
    const switchNow = failures.find((reason) => shouldSwitchChannel(reason));
    if (switchNow !== undefined) {
      throw switchNow;
    }

    if (retryBudget <= 0) {
      throw failures[0];
    }
    retryBudget -= 1;
    // 循环回到顶部时 remaining() 已经扣掉本批成功交付的张数，因此只会补发失败的那几张。
  }
}

export interface ChannelFailoverOptions<TChannel> {
  channels: TChannel[];
  run: (channel: TChannel) => Promise<void>;
  isAbort: (error: unknown) => boolean;
  isRetryable: (error: unknown) => boolean;
  exhaustedMessage: string;
}

/** 按优先级依次尝试渠道；只有「可重试」的错误才继续往下一个渠道走。 */
export async function runAcrossChannels<TChannel>(options: ChannelFailoverOptions<TChannel>): Promise<void> {
  let lastError: unknown = null;
  let attempted = false;

  for (const channel of options.channels) {
    attempted = true;
    try {
      await options.run(channel);
      return;
    } catch (error) {
      if (options.isAbort(error)) {
        throw error;
      }
      if (!options.isRetryable(error)) {
        // 参数错误 / 内容审核拒绝：换渠道是同样的结果，直接终止。
        throw error;
      }
      lastError = error;
    }
  }

  if (attempted) {
    throw lastError;
  }
  throw new Error(options.exhaustedMessage);
}
