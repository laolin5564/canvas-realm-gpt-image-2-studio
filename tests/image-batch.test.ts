import { describe, expect, test } from "bun:test";
import { runAcrossChannels, runImageGenerationBatches } from "@/lib/image-batch";
import { isRetryableImageError, UpstreamImageError } from "@/lib/image-retry";

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface Harness {
  delivered: string[];
  requestCount: number;
  run: (options: { total: number; alreadyDelivered?: number; concurrency: number }) => Promise<void>;
}

function createHarness(plan: Array<() => Promise<string[]>>): Harness {
  const delivered: string[] = [];
  let requestCount = 0;
  let deliveredBase = 0;

  return {
    delivered,
    get requestCount() {
      return requestCount;
    },
    run: ({ total, alreadyDelivered = 0, concurrency }) => {
      deliveredBase = alreadyDelivered;
      return runImageGenerationBatches<string>({
        total,
        concurrency,
        delivered: () => deliveredBase + delivered.length,
        request: async () => {
          const step = plan[requestCount] ?? (async () => [`img-${requestCount}`]);
          requestCount += 1;
          return step();
        },
        deliver: async (image) => {
          delivered.push(image);
        },
        isAbort,
        isRetryable: isRetryableImageError,
      });
    },
  };
}

describe("单渠道批次调度", () => {
  test("同批部分失败时，成功的图片保留，只补发失败的张数", async () => {
    const harness = createHarness([
      async () => ["a"],
      async () => {
        throw new UpstreamImageError("模型服务暂时不可用（500）", 500);
      },
      async () => ["c"],
      // 补发只应该发 1 个请求（补那张失败的），不应该重发已经成功的两张。
      async () => ["d"],
      async () => {
        throw new Error("不应该发起第 5 个请求");
      },
    ]);

    await harness.run({ total: 3, concurrency: 3 });

    expect(harness.requestCount).toBe(4);
    expect([...harness.delivered].sort().join(",")).toBe("a,c,d");
  });

  test("续跑：alreadyDelivered 已覆盖的张数不再重新生成", async () => {
    const harness = createHarness([]);

    await harness.run({ total: 4, alreadyDelivered: 3, concurrency: 4 });

    expect(harness.requestCount).toBe(1);
    expect(harness.delivered.length).toBe(1);
  });

  test("续跑：已经落满时一个上游请求都不发", async () => {
    const harness = createHarness([]);

    await harness.run({ total: 2, alreadyDelivered: 2, concurrency: 4 });

    expect(harness.requestCount).toBe(0);
    expect(harness.delivered.length).toBe(0);
  });

  test("同一渠道最多补发一轮，仍失败就上抛", async () => {
    const harness = createHarness([
      async () => {
        throw new UpstreamImageError("模型服务暂时不可用（503）", 503);
      },
      async () => {
        throw new UpstreamImageError("模型服务暂时不可用（503）", 503);
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 1, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    expect(harness.requestCount).toBe(2);
    expect(failure instanceof UpstreamImageError).toBe(true);
  });

  test("不可重试的错误立即上抛，不在本渠道补发", async () => {
    const harness = createHarness([
      async () => {
        throw new UpstreamImageError("模型接口认证失败（401）", 401);
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 2, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    expect(harness.requestCount).toBe(1);
    expect(failure instanceof UpstreamImageError).toBe(true);
  });

  test("任务被停止时立刻中断", async () => {
    const harness = createHarness([
      async () => {
        throw new DOMException("任务已停止", "AbortError");
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 2, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    expect(harness.requestCount).toBe(1);
    expect(isAbort(failure)).toBe(true);
  });

  test("交付数量不会超过任务张数", async () => {
    const harness = createHarness([async () => ["a", "b", "c"]]);

    await harness.run({ total: 2, concurrency: 1 });

    expect(harness.delivered.join(",")).toBe("a,b");
  });
});

describe("渠道 failover", () => {
  test("可重试错误才切换到下一个渠道", async () => {
    const attempted: string[] = [];

    await runAcrossChannels({
      channels: ["渠道一", "渠道二"],
      run: async (channel) => {
        attempted.push(channel);
        if (channel === "渠道一") {
          throw new UpstreamImageError("模型服务暂时不可用（502）", 502);
        }
      },
      isAbort,
      isRetryable: isRetryableImageError,
      exhaustedMessage: "所有模型渠道均调用失败",
    });

    expect(attempted.join(",")).toBe("渠道一,渠道二");
  });

  test("不可重试错误直接终止，不消耗后面的渠道", async () => {
    const attempted: string[] = [];
    let failure: unknown = null;

    try {
      await runAcrossChannels({
        channels: ["渠道一", "渠道二", "渠道三"],
        run: async (channel) => {
          attempted.push(channel);
          throw new UpstreamImageError("提示词触发内容审核（400）", 400);
        },
        isAbort,
        isRetryable: isRetryableImageError,
        exhaustedMessage: "所有模型渠道均调用失败",
      });
    } catch (error) {
      failure = error;
    }

    expect(attempted.join(",")).toBe("渠道一");
    expect(failure instanceof UpstreamImageError).toBe(true);
  });

  test("任务被停止时不再尝试其他渠道", async () => {
    const attempted: string[] = [];
    let failure: unknown = null;

    try {
      await runAcrossChannels({
        channels: ["渠道一", "渠道二"],
        run: async (channel) => {
          attempted.push(channel);
          throw new DOMException("任务已停止", "AbortError");
        },
        isAbort,
        isRetryable: isRetryableImageError,
        exhaustedMessage: "所有模型渠道均调用失败",
      });
    } catch (error) {
      failure = error;
    }

    expect(attempted.join(",")).toBe("渠道一");
    expect(isAbort(failure)).toBe(true);
  });

  test("全部渠道都失败时抛出最后一个错误", async () => {
    let failure: unknown = null;
    try {
      await runAcrossChannels({
        channels: ["渠道一", "渠道二"],
        run: async (channel) => {
          throw new UpstreamImageError(`${channel} 暂时不可用`, 503);
        },
        isAbort,
        isRetryable: isRetryableImageError,
        exhaustedMessage: "所有模型渠道均调用失败",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error).toBe(true);
    expect((failure as Error).message).toBe("渠道二 暂时不可用");
  });

  test("没有任何渠道时抛出兜底错误", async () => {
    let message = "";
    try {
      await runAcrossChannels({
        channels: [] as string[],
        run: async () => undefined,
        isAbort,
        isRetryable: isRetryableImageError,
        exhaustedMessage: "所有模型渠道均调用失败",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toBe("所有模型渠道均调用失败");
  });
});
