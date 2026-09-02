import { describe, expect, test } from "bun:test";
import {
  normalizeFailureReason,
  percentileMs,
  summarizeAttemptsByChannel,
  unknownChannelId,
  unknownChannelName,
  type AttemptSample,
} from "@/lib/attempt-stats";

function sample(overrides: Partial<AttemptSample> = {}): AttemptSample {
  return {
    channelId: "ch_a",
    channelName: "主渠道",
    ok: true,
    durationMs: 1000,
    errorMessage: null,
    startedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("分位数计算", () => {
  test("空样本返回 0", () => {
    expect(percentileMs([], 0.5)).toBe(0);
    expect(percentileMs([], 0.95)).toBe(0);
  });

  test("单个样本时 p50 与 p95 都是它自己", () => {
    expect(percentileMs([1234], 0.5)).toBe(1234);
    expect(percentileMs([1234], 0.95)).toBe(1234);
  });

  test("最近邻排名：p50 取第 ceil(0.5n) 个", () => {
    expect(percentileMs([30, 10, 20], 0.5)).toBe(20);
    expect(percentileMs([40, 10, 30, 20], 0.5)).toBe(20);
  });

  test("p95 取到接近最慢的那次，而不是被平均掉", () => {
    const values = Array.from({ length: 100 }, (_, index) => (index + 1) * 100);
    expect(percentileMs(values, 0.95)).toBe(9500);
    expect(percentileMs(values, 0.5)).toBe(5000);
  });

  test("一次 300s 超时会顶到 p95 上", () => {
    const values = [800, 900, 1000, 1100, 300_000];
    expect(percentileMs(values, 0.5)).toBe(1000);
    expect(percentileMs(values, 0.95)).toBe(300_000);
  });

  test("分位参数越界会被夹到 [0, 1]", () => {
    expect(percentileMs([10, 20, 30], -1)).toBe(10);
    expect(percentileMs([10, 20, 30], 5)).toBe(30);
  });
});

describe("失败原因归一化", () => {
  test("截掉带上游原文的尾巴，只留可归类的结论", () => {
    const reason = normalizeFailureReason(
      "模型服务暂时不可用（502）：上游网关或模型服务返回错误。（HTTP 502｜上游原文：request id 8f21a）",
    );
    expect(reason).toBe("模型服务暂时不可用（502）：上游网关或模型服务返回错误。");
  });

  test("空消息落到未知错误", () => {
    expect(normalizeFailureReason(null)).toBe("未知错误");
    expect(normalizeFailureReason("   ")).toBe("未知错误");
  });
});

describe("按渠道聚合", () => {
  test("请求数、成功率、p50/p95 按渠道分开算", () => {
    const stats = summarizeAttemptsByChannel([
      sample({ channelId: "ch_a", durationMs: 1000 }),
      sample({ channelId: "ch_a", durationMs: 2000 }),
      sample({ channelId: "ch_a", durationMs: 3000, ok: false, errorMessage: "限流" }),
      sample({ channelId: "ch_b", channelName: "备用渠道", durationMs: 500 }),
    ]);

    expect(stats.map((row) => row.channelId).join(",")).toBe("ch_a,ch_b");
    const first = stats[0];
    expect(first.total).toBe(3);
    expect(first.succeeded).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.successRate).toBe(66.7);
    expect(first.p50DurationMs).toBe(2000);
    expect(first.p95DurationMs).toBe(3000);
    expect(stats[1].successRate).toBe(100);
  });

  test("失败原因按次数取 Top3，并记录最近一次时间", () => {
    const stats = summarizeAttemptsByChannel([
      sample({ ok: false, errorMessage: "超时", startedAt: "2026-09-01T03:00:00.000Z" }),
      sample({ ok: false, errorMessage: "超时", startedAt: "2026-09-01T02:00:00.000Z" }),
      sample({ ok: false, errorMessage: "限流", startedAt: "2026-09-01T01:00:00.000Z" }),
      sample({ ok: false, errorMessage: "余额不足", startedAt: "2026-09-01T00:30:00.000Z" }),
      sample({ ok: false, errorMessage: "证书错误", startedAt: "2026-09-01T00:10:00.000Z" }),
    ]);

    const top = stats[0].topErrors;
    expect(top.length).toBe(3);
    expect(top[0].message).toBe("超时");
    expect(top[0].count).toBe(2);
    expect(top[0].lastAt).toBe("2026-09-01T03:00:00.000Z");
    expect(top.map((item) => item.message)).toContain("限流");
  });

  test("耗时统计包含失败请求，超时不会被藏起来", () => {
    const stats = summarizeAttemptsByChannel([
      sample({ durationMs: 900 }),
      sample({ ok: false, durationMs: 300_000, errorMessage: "生成服务响应超时，请稍后重试。" }),
    ]);

    expect(stats[0].p95DurationMs).toBe(300_000);
  });

  test("没有渠道标识时归到未知渠道", () => {
    const stats = summarizeAttemptsByChannel([sample({ channelId: null, channelName: null })]);

    expect(stats[0].channelId).toBe(unknownChannelId);
    expect(stats[0].channelName).toBe(unknownChannelName);
  });

  test("空输入返回空数组", () => {
    expect(summarizeAttemptsByChannel([]).length).toBe(0);
  });
});
