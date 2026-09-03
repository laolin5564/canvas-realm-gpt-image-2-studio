import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  apiError,
  apiErrorBody,
  apiKeyRateLimit,
  apiProgressStage,
  consumeToken,
  rateLimitedError,
  resolveOrigin,
  toApiFailure,
  toApiTask,
  type TokenBucketState,
} from "../lib/api-v1";
import type { GeneratedImageRow, GenerationTaskRow } from "../lib/types";

function taskRow(overrides: Partial<GenerationTaskRow> = {}): GenerationTaskRow {
  return {
    id: "task_demo",
    user_id: "user_demo",
    conversation_id: null,
    mode: "text_to_image",
    status: "queued",
    progress_stage: "queued",
    prompt: "一只在雪地里的柴犬",
    fixed_prompt: null,
    prompt_suffix: null,
    negative_prompt: null,
    size: "ecommerce_main_1_1",
    quality: "high",
    quantity: 2,
    image_count: 0,
    requested_concurrency: null,
    template_id: null,
    source_image_id: null,
    reference_image_id: null,
    reference_image_ids: null,
    reference_strength: 0.6,
    style_strength: 0.7,
    cost_estimate: 0.08,
    error_message: null,
    error_detail: null,
    source: "api",
    created_at: "2026-09-03T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function imageRow(overrides: Partial<GeneratedImageRow> = {}): GeneratedImageRow {
  return {
    id: "img_demo",
    task_id: "task_demo",
    file_path: "2026/09/03/task_demo/img_demo.png",
    width: 1024,
    height: 1024,
    prompt: "一只在雪地里的柴犬",
    mode: "text_to_image",
    template_id: null,
    created_at: "2026-09-03T00:00:10.000Z",
    ...overrides,
  };
}

const buildImageUrl = (filePath: string, thumb: boolean): string =>
  `https://img.example.com/api/files/${filePath}?sig=x&exp=1${thumb ? "&thumb=1" : ""}`;

describe("错误体与错误映射", () => {
  test("apiErrorBody 就是契约里的 { error: { code, message } }", () => {
    const body = apiErrorBody("not_found", "任务不存在");
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toBe("任务不存在");
  });

  test("ApiError 按 code 取默认状态码", () => {
    expect(apiError("unauthorized", "x").status).toBe(401);
    expect(apiError("forbidden", "x").status).toBe(403);
    expect(apiError("quota_exceeded", "x").status).toBe(403);
    expect(apiError("api_disabled", "x").status).toBe(403);
    expect(apiError("validation_error", "x").status).toBe(400);
    expect(apiError("not_found", "x").status).toBe(404);
    expect(apiError("rate_limited", "x").status).toBe(429);
    expect(apiError("too_many_active_tasks", "x").status).toBe(429);
    expect(apiError("server_error", "x").status).toBe(500);
  });

  test("rateLimitedError 带上 Retry-After 秒数", () => {
    const failure = toApiFailure(rateLimitedError("太快了", 3.2));
    expect(failure.code).toBe("rate_limited");
    expect(failure.status).toBe(429);
    expect(failure.retryAfterSeconds).toBe(4);
  });

  test("ZodError 归到 validation_error 并带上中文校验文案", () => {
    const schema = z.object({ prompt: z.string().min(1, "prompt 不能为空") });
    const parsed = schema.safeParse({ prompt: "" });
    expect(parsed.success).toBe(false);
    const failure = toApiFailure(parsed.success ? new Error("unreachable") : parsed.error);
    expect(failure.code).toBe("validation_error");
    expect(failure.status).toBe(400);
    expect(failure.message).toContain("prompt 不能为空");
  });

  test("AuthError 这类带 status 的 Error 按状态码归类", () => {
    const authError = Object.assign(new Error("请先登录"), { status: 401 });
    expect(toApiFailure(authError).code).toBe("unauthorized");
    expect(toApiFailure(Object.assign(new Error("无权访问该任务"), { status: 403 })).code).toBe("forbidden");
    expect(toApiFailure(Object.assign(new Error("任务不存在"), { status: 404 })).code).toBe("not_found");
    expect(toApiFailure(Object.assign(new Error("参考图不存在"), { status: 400 })).code).toBe("validation_error");
  });

  test("未知异常一律 server_error 500", () => {
    const failure = toApiFailure("boom");
    expect(failure.code).toBe("server_error");
    expect(failure.status).toBe(500);
    const thrown = toApiFailure(new Error("上游炸了"));
    expect(thrown.code).toBe("server_error");
    expect(thrown.status).toBe(500);
    expect(thrown.message).toBe("上游炸了");
  });
});

describe("resolveOrigin", () => {
  test("优先用 x-forwarded-proto/host", () => {
    expect(
      resolveOrigin({
        forwardedProto: "https",
        forwardedHost: "img.example.com",
        host: "127.0.0.1:3000",
        fallbackOrigin: "http://127.0.0.1:3000",
      }),
    ).toBe("https://img.example.com");
  });

  test("多值头取第一个", () => {
    expect(
      resolveOrigin({
        forwardedProto: "https, http",
        forwardedHost: "img.example.com, inner",
        host: null,
        fallbackOrigin: "http://127.0.0.1:3000",
      }),
    ).toBe("https://img.example.com");
  });

  test("没有 forwarded-host 时退回 host 头", () => {
    expect(
      resolveOrigin({
        forwardedProto: null,
        forwardedHost: null,
        host: "img.example.com",
        fallbackOrigin: "https://127.0.0.1:3000",
      }),
    ).toBe("https://img.example.com");
  });

  test("完全没有 host 时退回 nextUrl.origin", () => {
    expect(
      resolveOrigin({
        forwardedProto: null,
        forwardedHost: null,
        host: null,
        fallbackOrigin: "http://127.0.0.1:3000/",
      }),
    ).toBe("http://127.0.0.1:3000");
  });
});

describe("令牌桶：每把密钥 60 请求/分钟", () => {
  test("默认参数是 60 容量 + 每秒回填 1 个", () => {
    expect(apiKeyRateLimit.capacity).toBe(60);
    expect(apiKeyRateLimit.refillPerSecond).toBe(1);
  });

  test("一分钟内放行 60 次，第 61 次拒绝并给出等待秒数", () => {
    let state: TokenBucketState | undefined;
    let allowed = 0;
    for (let index = 0; index < 60; index += 1) {
      const result = consumeToken(state, apiKeyRateLimit, 1_000);
      state = result.state;
      if (result.allowed) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(60);

    const blocked = consumeToken(state, apiKeyRateLimit, 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  test("等一会儿之后按 1 个/秒回填", () => {
    let state: TokenBucketState | undefined;
    for (let index = 0; index < 61; index += 1) {
      state = consumeToken(state, apiKeyRateLimit, 1_000).state;
    }
    const afterOneSecond = consumeToken(state, apiKeyRateLimit, 2_000);
    expect(afterOneSecond.allowed).toBe(true);

    const immediately = consumeToken(afterOneSecond.state, apiKeyRateLimit, 2_000);
    expect(immediately.allowed).toBe(false);
  });

  test("桶不会超过容量上限", () => {
    const result = consumeToken({ tokens: 0, updatedAtMs: 0 }, apiKeyRateLimit, 10_000_000);
    expect(result.state.tokens).toBe(apiKeyRateLimit.capacity - 1);
  });
});

describe("apiProgressStage", () => {
  test("排队 / 成功 / 失败 / 取消四种终态", () => {
    expect(apiProgressStage(taskRow({ status: "queued" }))).toBe("queued");
    expect(apiProgressStage(taskRow({ status: "succeeded", progress_stage: "completed" }))).toBe("completed");
    expect(apiProgressStage(taskRow({ status: "failed", progress_stage: "failed" }))).toBe("failed");
    expect(apiProgressStage(taskRow({ status: "failed", progress_stage: "canceled" }))).toBe("canceled");
    expect(
      apiProgressStage(taskRow({ status: "failed", progress_stage: "generating", error_message: "用户已停止生成" })),
    ).toBe("canceled");
  });

  test("处理中读不出细分阶段时兜底 generating", () => {
    expect(apiProgressStage(taskRow({ status: "processing", progress_stage: "saving" }))).toBe("saving");
    expect(apiProgressStage(taskRow({ status: "processing", progress_stage: "queued" }))).toBe("generating");
  });
});

describe("toApiTask", () => {
  test("字段名走契约的 snake_case，n 取 quantity", () => {
    const task = toApiTask(taskRow(), [], buildImageUrl);
    expect(task.id).toBe("task_demo");
    expect(task.status).toBe("queued");
    expect(task.progress_stage).toBe("queued");
    expect(task.mode).toBe("text_to_image");
    expect(task.size).toBe("ecommerce_main_1_1");
    expect(task.quality).toBe("high");
    expect(task.n).toBe(2);
    expect(task.created_at).toBe("2026-09-03T00:00:00.000Z");
    expect(task.started_at).toBe(null);
    expect(task.completed_at).toBe(null);
    expect(task.error).toBe(null);
    expect(task.images.length).toBe(0);
  });

  test("出图带绝对签名地址与缩略图地址", () => {
    const task = toApiTask(taskRow({ status: "succeeded" }), [imageRow()], buildImageUrl);
    expect(task.images.length).toBe(1);
    expect(task.images[0].id).toBe("img_demo");
    expect(task.images[0].url).toContain("https://img.example.com/api/files/");
    expect(task.images[0].url).toContain("sig=");
    expect(task.images[0].thumbnail_url).toContain("thumb=1");
    expect(task.images[0].width).toBe(1024);
    expect(task.images[0].height).toBe(1024);
  });

  test("失败任务给出 error.message，成功任务恒为 null", () => {
    const failed = toApiTask(taskRow({ status: "failed", error_message: "上游超时" }), [], buildImageUrl);
    expect(failed.error === null).toBe(false);
    expect(failed.error?.message).toBe("上游超时");

    const withoutMessage = toApiTask(taskRow({ status: "failed", error_message: null }), [], buildImageUrl);
    expect(withoutMessage.error?.message).toBe("生成失败");

    expect(toApiTask(taskRow({ status: "succeeded" }), [], buildImageUrl).error).toBe(null);
  });
});
