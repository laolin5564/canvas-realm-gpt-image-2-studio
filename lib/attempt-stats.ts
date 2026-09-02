// 上游调用遥测的聚合逻辑：从 generation_attempts 的原始记录算出「每个渠道请求数 /
// 成功率 / p50 / p95 / 最近失败原因 Top3」。刻意不碰 node:sqlite，纯函数方便单测。

import type { ChannelAttemptFailure, ChannelAttemptStats } from "./types";

export interface AttemptSample {
  channelId: string | null;
  channelName: string | null;
  ok: boolean;
  durationMs: number;
  errorMessage: string | null;
  startedAt: string;
}

export const unknownChannelId = "unknown";
export const unknownChannelName = "未知渠道";

const topErrorLimit = 3;
const failureReasonMaxLength = 160;

/**
 * 最近邻排名法取分位数：升序排完取第 ceil(fraction * n) 个（1 基）。
 * 样本很少时也有确定结果，不做插值，便于和后台展示对账。
 */
export function percentileMs(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const rank = Math.ceil(clamped * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * 失败原因归一化：管理员详情里带 HTTP 状态码和上游原文，原文每次都不一样，
 * 直接分组会碎成一堆一条的记录。截到「（HTTP …」之前，只保留可归类的那句结论。
 */
export function normalizeFailureReason(message: string | null): string {
  const raw = (message ?? "").replace(/\s+/g, " ").trim();
  if (raw === "") {
    return "未知错误";
  }
  const cut = raw.indexOf("（HTTP ");
  const headline = cut > 0 ? raw.slice(0, cut) : raw;
  return headline.trim().slice(0, failureReasonMaxLength) || "未知错误";
}

interface ChannelBucket {
  channelId: string;
  channelName: string;
  durations: number[];
  succeeded: number;
  failed: number;
  failures: Map<string, ChannelAttemptFailure>;
}

export function summarizeAttemptsByChannel(samples: AttemptSample[]): ChannelAttemptStats[] {
  const buckets = new Map<string, ChannelBucket>();

  for (const sample of samples) {
    const channelId = sample.channelId ?? unknownChannelId;
    let bucket = buckets.get(channelId);
    if (!bucket) {
      // 渠道可能被改名：samples 按时间倒序传入，第一条即最近一次调用用的名字。
      bucket = {
        channelId,
        channelName: sample.channelName ?? unknownChannelName,
        durations: [],
        succeeded: 0,
        failed: 0,
        failures: new Map(),
      };
      buckets.set(channelId, bucket);
    }
    // 耗时统计包含失败请求：一次 300s 超时正是最该被看见的信号。
    bucket.durations.push(Math.max(0, sample.durationMs));
    if (sample.ok) {
      bucket.succeeded += 1;
      continue;
    }

    bucket.failed += 1;
    const reason = normalizeFailureReason(sample.errorMessage);
    const existing = bucket.failures.get(reason);
    if (existing) {
      existing.count += 1;
      if (sample.startedAt > existing.lastAt) {
        existing.lastAt = sample.startedAt;
      }
      continue;
    }
    bucket.failures.set(reason, { message: reason, count: 1, lastAt: sample.startedAt });
  }

  return [...buckets.values()]
    .map((bucket) => {
      const total = bucket.succeeded + bucket.failed;
      return {
        channelId: bucket.channelId,
        channelName: bucket.channelName,
        total,
        succeeded: bucket.succeeded,
        failed: bucket.failed,
        successRate: total > 0 ? Number(((bucket.succeeded / total) * 100).toFixed(1)) : 0,
        p50DurationMs: percentileMs(bucket.durations, 0.5),
        p95DurationMs: percentileMs(bucket.durations, 0.95),
        topErrors: [...bucket.failures.values()]
          .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))
          .slice(0, topErrorLimit),
      };
    })
    .sort((a, b) => b.total - a.total || a.channelName.localeCompare(b.channelName));
}
