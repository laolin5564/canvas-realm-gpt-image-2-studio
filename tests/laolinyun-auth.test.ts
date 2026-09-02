import { describe, expect, test } from "bun:test";
import {
  LaolinyunUserApiError,
  getLaolinyunUserBySecret,
  toLaolinyunNetworkError,
} from "@/lib/laolinyun-auth";

async function withFailingFetch<T>(rejection: unknown, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw rejection;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("laolinyun upstream failures", () => {
  test("maps abort/timeout errors to a readable Chinese message", () => {
    const timeout = toLaolinyunNetworkError(new DOMException("The operation timed out.", "TimeoutError"));
    expect(timeout instanceof LaolinyunUserApiError).toBe(true);
    expect(timeout.message).toBe("老林云接口响应超时，请稍后重试");
    expect(timeout.status).toBe(504);

    const aborted = toLaolinyunNetworkError(new DOMException("aborted", "AbortError"));
    expect(aborted.message).toBe("老林云接口响应超时，请稍后重试");
    expect(aborted.status).toBe(504);
  });

  test("maps other network failures to a readable Chinese message", () => {
    const failure = toLaolinyunNetworkError(new TypeError("fetch failed"));
    expect(failure.message).toBe("老林云接口网络异常，请稍后重试");
    expect(failure.status).toBe(502);
  });

  test("keeps an already-classified upstream error untouched", () => {
    const original = new LaolinyunUserApiError("授权参数不正确", 400);
    expect(toLaolinyunNetworkError(original) === original).toBe(true);
  });

  test("surfaces a timeout instead of hanging when the upstream never answers", async () => {
    const error = await withFailingFetch(
      new DOMException("The operation timed out.", "TimeoutError"),
      () => getLaolinyunUserBySecret("0123456789abcdef0123456789abcdef").catch((caught: unknown) => caught),
    );

    expect(error instanceof LaolinyunUserApiError).toBe(true);
    expect((error as LaolinyunUserApiError).message).toContain("超时");
    expect((error as LaolinyunUserApiError).status).toBe(504);
  });
});
