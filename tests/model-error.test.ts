import { describe, expect, test } from "bun:test";
import { formatModelError, formatModelErrorDetail, isModelTimeoutMessage } from "@/lib/model-error";
import { openAIOAuthImageGenerationScope } from "@/lib/openai-oauth";

describe("model error formatting", () => {
  test("explains missing OAuth image permission clearly", () => {
    const detail = formatModelErrorDetail(
      401,
      JSON.stringify({
        error: {
          message: `You have insufficient permissions for this operation. Missing scopes: ${openAIOAuthImageGenerationScope}.`,
        },
      }),
      "image generation failed",
    );

    expect(detail).toContain("OpenAI OAuth 不能直接调用官方 Platform 图片接口");
    expect(detail).toContain(openAIOAuthImageGenerationScope);
    expect(detail).toContain("Codex Responses 图片工具桥接");
  });

  test("classifies upstream gateway timeout", () => {
    const detail = formatModelErrorDetail(504, "504 Gateway Time-out nginx/1.24.0", "image edit failed");
    expect(detail).toContain("模型接口超时（504）");

    const message = formatModelError(504, "504 Gateway Time-out nginx/1.24.0", "image edit failed");
    expect(message).toBe("生成服务响应超时，请稍后重试。");
    expect(isModelTimeoutMessage(message)).toBe(true);
  });

  test("explains oversized image edit requests", () => {
    const detail = formatModelErrorDetail(413, "413 Request Entity Too Large nginx/1.24.0", "image edit failed");
    expect(detail).toContain("参考图请求体过大（413）");
    expect(detail).toContain("client_max_body_size");
    expect(formatModelError(413, "413 Request Entity Too Large nginx/1.24.0", "image edit failed")).toContain("参考图太大");
  });

  test("classifies missing balance or quota", () => {
    const payload = JSON.stringify({ error: { message: "You have insufficient quota. Please check your billing details." } });
    expect(formatModelErrorDetail(401, payload, "image generation failed")).toContain("模型账号余额或额度不足");
    expect(formatModelError(401, payload, "image generation failed")).toBe("生成服务暂时不可用，管理员已收到通知。");
  });

  test("keeps user-facing copy short and actionable per status", () => {
    expect(formatModelError(400, JSON.stringify({ error: { message: "content_policy_violation" } }), "failed")).toBe(
      "描述可能不符合平台规范，请调整后重试。",
    );
    expect(formatModelError(401, "invalid api key", "failed")).toBe("生成服务暂时不可用，管理员已收到通知。");
    expect(formatModelError(403, "forbidden", "failed")).toBe("生成服务暂时不可用，管理员已收到通知。");
    expect(formatModelError(429, "rate limited", "failed")).toBe("当前排队较多，系统会自动重试，请稍后查看。");
    expect(formatModelError(500, "internal error", "failed")).toBe("生成服务暂时不可用，请稍后重试。");
    expect(formatModelError(418, "teapot", "failed")).toBe("生成失败，请稍后重试；如果反复失败请联系管理员。");
  });

  test("user-facing copy never leaks upstream detail while the admin detail keeps it", () => {
    const raw = "Bearer sk-live-should-not-leak upstream nginx trace";
    expect(formatModelError(500, raw, "image generation failed").includes("sk-live-should-not-leak")).toBe(false);

    const detail = formatModelErrorDetail(500, raw, "image generation failed");
    expect(detail).toContain("HTTP 500");
    expect(detail).toContain("sk-live-should-not-leak");
  });

  test("treats a plain 超时 message as a timeout", () => {
    expect(isModelTimeoutMessage("生成服务响应超时，请稍后重试。")).toBe(true);
    expect(isModelTimeoutMessage("模型接口超时（504）")).toBe(true);
    expect(isModelTimeoutMessage("描述可能不符合平台规范，请调整后重试。")).toBe(false);
  });
});
