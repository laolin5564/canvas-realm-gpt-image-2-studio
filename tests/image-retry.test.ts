import { describe, expect, test } from "bun:test";
import { imageErrorStatus, isRetryableImageError, UpstreamImageError } from "@/lib/image-retry";

describe("上游生图错误分类", () => {
  test("5xx / 429 / 408 / 413 可以重试并切换渠道", () => {
    expect(isRetryableImageError(new UpstreamImageError("模型服务暂时不可用（500）", 500))).toBe(true);
    expect(isRetryableImageError(new UpstreamImageError("网关错误", 502))).toBe(true);
    expect(isRetryableImageError(new UpstreamImageError("模型接口超时（504）", 504))).toBe(true);
    expect(isRetryableImageError(new UpstreamImageError("模型接口限流（429）", 429))).toBe(true);
    expect(isRetryableImageError(new UpstreamImageError("请求超时", 408))).toBe(true);
    // 413 是渠道网关的体积上限，换一个上限更高的渠道就能过。
    expect(isRetryableImageError(new UpstreamImageError("参考图请求体过大（413）", 413))).toBe(true);
  });

  test("除 408/413/429 之外的 4xx 不重试也不换渠道", () => {
    expect(isRetryableImageError(new UpstreamImageError("参数不合法", 400))).toBe(false);
    expect(isRetryableImageError(new UpstreamImageError("模型接口认证失败（401）", 401))).toBe(false);
    expect(isRetryableImageError(new UpstreamImageError("模型接口拒绝访问（403）", 403))).toBe(false);
    expect(isRetryableImageError(new UpstreamImageError("模型不存在", 404))).toBe(false);
    expect(isRetryableImageError(new UpstreamImageError("请求过于频繁", 422))).toBe(false);
  });

  test("内容审核拒绝与参数错误不换渠道", () => {
    expect(isRetryableImageError(new Error("your request was rejected by our safety system"))).toBe(false);
    expect(isRetryableImageError(new Error("内容审核未通过：提示词涉及违规内容"))).toBe(false);
    expect(isRetryableImageError(new Error("invalid_request_error: unknown parameter"))).toBe(false);
    expect(isRetryableImageError(new Error("缺少参考图，无法调用图片编辑接口"))).toBe(false);
  });

  test("网络错误与超时可以重试", () => {
    expect(isRetryableImageError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableImageError(new Error("模型接口超时（524）：上游生成服务响应太慢。"))).toBe(true);
    expect(isRetryableImageError(new DOMException("The operation timed out", "TimeoutError"))).toBe(true);
  });

  test("任务被停止的 AbortError 不算可重试错误", () => {
    expect(isRetryableImageError(new DOMException("任务已停止", "AbortError"))).toBe(false);
  });

  test("imageErrorStatus 只认数字 status", () => {
    expect(imageErrorStatus(new UpstreamImageError("x", 503))).toBe(503);
    expect(imageErrorStatus(new Error("x"))).toBe(null);
    expect(imageErrorStatus("boom")).toBe(null);
    expect(imageErrorStatus(null)).toBe(null);
  });
});
