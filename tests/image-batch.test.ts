import { describe, expect, test } from "bun:test";
import {
  isImageTimeoutError,
  isPayloadTooLargeError,
  isRedirectError,
  runAcrossChannels,
  runImageGenerationBatches,
  shouldSwitchChannelByDefault,
} from "@/lib/image-batch";
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

describe("超时收敛", () => {
  test("识别超时：TimeoutError、504/524、含超时字样的文案", () => {
    expect(isImageTimeoutError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isImageTimeoutError(new UpstreamImageError("生成服务响应超时，请稍后重试。", 524))).toBe(true);
    expect(isImageTimeoutError(new UpstreamImageError("网关超时", 504))).toBe(true);
    expect(isImageTimeoutError(new UpstreamImageError("模型服务暂时不可用（502）", 502))).toBe(false);
    expect(isImageTimeoutError(new DOMException("任务已停止", "AbortError"))).toBe(false);
    expect(isImageTimeoutError(new Error("connect ECONNRESET"))).toBe(false);
  });

  test("TimeoutError 不在本渠道补发，直接上抛", async () => {
    const harness = createHarness([
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      async () => {
        throw new Error("超时后不应该在同一渠道补发");
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 1, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    // 只发了 1 个请求：第二个请求应该发生在下一个渠道，而不是这里。
    expect(harness.requestCount).toBe(1);
    expect(failure instanceof DOMException).toBe(true);
    expect((failure as DOMException).name).toBe("TimeoutError");
  });

  test("超时会切到下一个渠道，而不是在原渠道再烧一个超时窗口", async () => {
    const attempts: string[] = [];
    const requestsPerChannel = new Map<string, number>();
    const delivered: string[] = [];

    await runAcrossChannels({
      channels: ["渠道一", "渠道二"],
      run: (channel) => {
        attempts.push(channel);
        return runImageGenerationBatches<string>({
          total: 1,
          concurrency: 1,
          delivered: () => delivered.length,
          request: async () => {
            const count = (requestsPerChannel.get(channel) ?? 0) + 1;
            requestsPerChannel.set(channel, count);
            if (channel === "渠道一") {
              throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            }
            return ["ok"];
          },
          deliver: async (image) => {
            delivered.push(image);
          },
          isAbort,
          isRetryable: isRetryableImageError,
        });
      },
      isAbort,
      isRetryable: isRetryableImageError,
      exhaustedMessage: "所有模型渠道均调用失败",
    });

    expect(attempts.join(",")).toBe("渠道一,渠道二");
    expect(requestsPerChannel.get("渠道一")).toBe(1);
    expect(requestsPerChannel.get("渠道二")).toBe(1);
    expect(delivered.join(",")).toBe("ok");
  });

  test("非超时的可重试错误仍在本渠道补发一次", async () => {
    const harness = createHarness([
      async () => {
        throw new UpstreamImageError("模型服务暂时不可用（503）", 503);
      },
      async () => ["a"],
    ]);

    await harness.run({ total: 1, concurrency: 1 });

    expect(harness.requestCount).toBe(2);
    expect(harness.delivered.join(",")).toBe("a");
  });

  test("超时那批里已经成功交付的图片会保留", async () => {
    const harness = createHarness([
      async () => ["a"],
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 2, concurrency: 2 });
    } catch (error) {
      failure = error;
    }

    expect(harness.delivered.join(",")).toBe("a");
    expect((failure as DOMException).name).toBe("TimeoutError");
  });
});

describe("413 请求体过大", () => {
  test("识别 413，且默认切渠道判定覆盖超时与 413", () => {
    expect(isPayloadTooLargeError(new UpstreamImageError("参考图太大", 413))).toBe(true);
    expect(isPayloadTooLargeError(new UpstreamImageError("模型服务暂时不可用（503）", 503))).toBe(false);
    expect(isPayloadTooLargeError(new Error("fetch failed"))).toBe(false);

    expect(shouldSwitchChannelByDefault(new UpstreamImageError("参考图太大", 413))).toBe(true);
    expect(shouldSwitchChannelByDefault(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(shouldSwitchChannelByDefault(new UpstreamImageError("模型服务暂时不可用（503）", 503))).toBe(false);
  });

  test("3xx 也直接切渠道：同渠道补发只会再吃一个跳转", async () => {
    expect(isRedirectError(new UpstreamImageError("生成服务暂时不可用", 301))).toBe(true);
    expect(isRedirectError(new UpstreamImageError("生成服务暂时不可用", 307))).toBe(true);
    expect(isRedirectError(new UpstreamImageError("参考图太大", 413))).toBe(false);
    expect(isRedirectError(new Error("fetch failed"))).toBe(false);
    expect(shouldSwitchChannelByDefault(new UpstreamImageError("生成服务暂时不可用", 301))).toBe(true);
    expect(shouldSwitchChannelByDefault(new UpstreamImageError("生成服务暂时不可用", 308))).toBe(true);

    const harness = createHarness([
      async () => {
        throw new UpstreamImageError("生成服务暂时不可用，请稍后重试。", 301);
      },
      async () => {
        throw new Error("301 后不应该在同一渠道补发");
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 1, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    expect(harness.requestCount).toBe(1);
    expect((failure as UpstreamImageError).status).toBe(301);
  });

  test("runAcrossChannels 遇 301 会走到下一个渠道", async () => {
    const attempts: string[] = [];
    const delivered: string[] = [];

    await runAcrossChannels({
      channels: ["直连源站", "CF 域名"],
      run: async (channel) => {
        attempts.push(channel);
        if (channel === "直连源站") {
          throw new UpstreamImageError("生成服务暂时不可用，请稍后重试。", 301);
        }
        delivered.push("ok");
      },
      isAbort,
      isRetryable: isRetryableImageError,
      exhaustedMessage: "所有模型渠道均调用失败",
    });

    expect(attempts.join(",")).toBe("直连源站,CF 域名");
    expect(delivered.join(",")).toBe("ok");
  });

  test("413 直接上抛换渠道，不在同渠道原样补发", async () => {
    const harness = createHarness([
      async () => {
        throw new UpstreamImageError("参考图太大，请压缩后重试或减少参考图数量。", 413);
      },
      async () => {
        throw new Error("413 后不应该在同一渠道补发");
      },
    ]);

    let failure: unknown = null;
    try {
      await harness.run({ total: 1, concurrency: 1 });
    } catch (error) {
      failure = error;
    }

    expect(harness.requestCount).toBe(1);
    expect(failure instanceof UpstreamImageError).toBe(true);
    expect((failure as UpstreamImageError).status).toBe(413);
  });

  test("runAcrossChannels 遇 413 会走到下一个渠道", async () => {
    const attempts: string[] = [];
    const requestsPerChannel = new Map<string, number>();
    const delivered: string[] = [];

    await runAcrossChannels({
      channels: ["直连源站", "CF 域名"],
      run: (channel) => {
        attempts.push(channel);
        return runImageGenerationBatches<string>({
          total: 1,
          concurrency: 1,
          delivered: () => delivered.length,
          request: async () => {
            const count = (requestsPerChannel.get(channel) ?? 0) + 1;
            requestsPerChannel.set(channel, count);
            if (channel === "直连源站") {
              throw new UpstreamImageError("直连源站：参考图太大，请压缩后重试或减少参考图数量。", 413);
            }
            return ["ok"];
          },
          deliver: async (image) => {
            delivered.push(image);
          },
          isAbort,
          isRetryable: isRetryableImageError,
        });
      },
      isAbort,
      isRetryable: isRetryableImageError,
      exhaustedMessage: "所有模型渠道均调用失败",
    });

    expect(attempts.join(",")).toBe("直连源站,CF 域名");
    expect(requestsPerChannel.get("直连源站")).toBe(1);
    expect(requestsPerChannel.get("CF 域名")).toBe(1);
    expect(delivered.join(",")).toBe("ok");
  });

  test("所有渠道都 413 时抛出最后一个 413", async () => {
    let failure: unknown = null;
    try {
      await runAcrossChannels({
        channels: ["渠道一", "渠道二"],
        run: async (channel) => {
          throw new UpstreamImageError(`${channel}：参考图太大`, 413);
        },
        isAbort,
        isRetryable: isRetryableImageError,
        exhaustedMessage: "所有模型渠道均调用失败",
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as UpstreamImageError).status).toBe(413);
    expect((failure as Error).message).toBe("渠道二：参考图太大");
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
