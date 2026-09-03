import { describe, expect, test } from "bun:test";
import { sizeOptions } from "@/lib/image-options";
import {
  apiEndpoints,
  docSections,
  errorBodyExample,
  errorCodes,
  formatKeyPrefix,
  languageSamples,
  limitRows,
  originPlaceholder,
  originToken,
  quickStartSamples,
  sizeRows,
  withOrigin,
} from "@/components/developer/api-docs-content";
import {
  countActiveKeys,
  errorMessageFromPayload,
  maxActiveApiKeys,
  validateKeyName,
} from "@/components/developer/developer-api";
import type { DeveloperApiKey } from "@/components/developer/developer-api";

/** 契约里列出的全部端点，缺一个都算文档没写全。 */
const expectedEndpoints = [
  "GET /api/user/api-keys",
  "POST /api/user/api-keys",
  "DELETE /api/user/api-keys/{id}",
  "GET /api/v1/me",
  "POST /api/v1/images/generations",
  "POST /api/v1/images/edits",
  "GET /api/v1/tasks/{id}",
  "GET /api/v1/tasks",
  "POST /api/v1/tasks/{id}/cancel",
  "GET /api/v1/images/{id}",
];

const expectedErrorCodes = [
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "validation_error",
  "not_found",
  "rate_limited",
  "too_many_active_tasks",
  "api_disabled",
  "server_error",
];

describe("接口文档端点清单", () => {
  const signatures = apiEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);

  test("契约里的端点一个不少", () => {
    expect(apiEndpoints.length).toBe(expectedEndpoints.length);
    for (const signature of expectedEndpoints) {
      expect(signatures).toContain(signature);
    }
  });

  test("端点 id 唯一", () => {
    const ids = new Set(apiEndpoints.map((endpoint) => endpoint.id));
    expect(ids.size).toBe(apiEndpoints.length);
  });

  test("每个端点都写清了鉴权方式和摘要", () => {
    for (const endpoint of apiEndpoints) {
      expect(endpoint.auth === "session" || endpoint.auth === "bearer").toBe(true);
      expect(endpoint.summary.length).toBeGreaterThan(0);
      expect(endpoint.title.length).toBeGreaterThan(0);
    }
  });

  test("二进制端点不给 JSON 示例，其余端点必须给", () => {
    const binary = apiEndpoints.filter((endpoint) => endpoint.responseExample === null);
    expect(binary.length).toBe(1);
    expect(binary[0].path).toBe("/api/v1/images/{id}");
  });
});

describe("示例 JSON 真实可用", () => {
  test("所有响应示例都能 JSON.parse", () => {
    for (const endpoint of apiEndpoints) {
      if (!endpoint.responseExample) {
        continue;
      }
      const parsed = JSON.parse(endpoint.responseExample) as Record<string, unknown>;
      expect(typeof parsed).toBe("object");
    }
  });

  test("所有请求示例都能 JSON.parse", () => {
    for (const endpoint of apiEndpoints) {
      if (!endpoint.requestExample) {
        continue;
      }
      const parsed = JSON.parse(endpoint.requestExample) as Record<string, unknown>;
      expect(typeof parsed).toBe("object");
    }
  });

  test("替换域名占位符之后仍是合法 JSON", () => {
    const generations = apiEndpoints.find((endpoint) => endpoint.id === "generations");
    expect(Boolean(generations?.responseExample)).toBe(true);
    const replaced = withOrigin(generations?.responseExample ?? "", "https://img.example.com");
    const parsed = JSON.parse(replaced) as { task: { images: { url: string }[] } };
    expect(parsed.task.images[0].url.startsWith("https://img.example.com/api/files/")).toBe(true);
    expect(replaced).toContain("sig=");
    expect(replaced).toContain("exp=");
  });

  test("文生图任务对象字段与契约一致", () => {
    const detail = apiEndpoints.find((endpoint) => endpoint.id === "task-detail");
    const parsed = JSON.parse(detail?.responseExample ?? "{}") as { task: Record<string, unknown> };
    const fields = Object.keys(parsed.task);
    for (const field of [
      "id",
      "status",
      "progress_stage",
      "mode",
      "prompt",
      "size",
      "quality",
      "n",
      "created_at",
      "started_at",
      "completed_at",
      "error",
      "images",
    ]) {
      expect(fields).toContain(field);
    }
  });

  test("错误响应体示例符合 { error: { code, message } }", () => {
    const parsed = JSON.parse(errorBodyExample) as { error: { code: string; message: string } };
    expect(typeof parsed.error.code).toBe("string");
    expect(typeof parsed.error.message).toBe("string");
  });

  test("创建密钥示例返回的 secret 是 hj_ + 24 位", () => {
    const create = apiEndpoints.find((endpoint) => endpoint.id === "create-key");
    const parsed = JSON.parse(create?.responseExample ?? "{}") as { secret: string };
    expect(/^hj_[A-Za-z0-9]{24}$/.test(parsed.secret)).toBe(true);
  });
});

describe("尺寸选项表", () => {
  test("覆盖 lib/image-options 里的全部尺寸键", () => {
    expect(sizeRows.length).toBe(sizeOptions.length);
    const keys = sizeRows.map((row) => row.option);
    for (const option of sizeOptions) {
      expect(keys).toContain(option);
    }
  });

  test("每一行都有中文说明和像素信息", () => {
    for (const row of sizeRows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.pixels.length).toBeGreaterThan(0);
    }
  });

  test("auto 标成由上游决定，具体尺寸给出像素串", () => {
    const auto = sizeRows.find((row) => row.option === "auto");
    expect(auto?.pixels).toBe("由上游决定");
    const square = sizeRows.find((row) => row.option === "ecommerce_main_1_1");
    expect(square?.pixels).toBe("1024x1024");
  });
});

describe("错误码与限制说明", () => {
  test("九个错误码齐全且 HTTP 状态码对得上", () => {
    expect(errorCodes.length).toBe(expectedErrorCodes.length);
    const codes = errorCodes.map((row) => row.code);
    for (const code of expectedErrorCodes) {
      expect(codes).toContain(code);
    }
    expect(errorCodes.find((row) => row.code === "rate_limited")?.status).toBe(429);
    expect(errorCodes.find((row) => row.code === "too_many_active_tasks")?.status).toBe(429);
    expect(errorCodes.find((row) => row.code === "api_disabled")?.status).toBe(403);
    expect(errorCodes.find((row) => row.code === "unauthorized")?.status).toBe(401);
  });

  test("限制说明覆盖频率、并发、额度、链接有效期", () => {
    const joined = limitRows.map((row) => `${row.title}${row.detail}`).join("\n");
    expect(joined).toContain("60");
    expect(joined).toContain("5");
    expect(joined).toContain("7 天");
    expect(joined).toContain("api_disabled");
  });
});

describe("代码示例与目录", () => {
  test("目录锚点与文档小节 id 唯一", () => {
    const ids = new Set(docSections.map((section) => section.id));
    expect(ids.size).toBe(docSections.length);
    expect(docSections.length).toBeGreaterThan(5);
  });

  test("快速开始给了同步与异步两种写法", () => {
    const joined = quickStartSamples.map((sample) => sample.code).join("\n");
    expect(joined).toContain("\"wait\": true");
    expect(joined).toContain("/api/v1/tasks/");
    expect(joined).toContain("/api/v1/images/edits");
  });

  test("Python 与 Node 示例各一段，且都用占位符拼域名", () => {
    expect(languageSamples.length).toBe(2);
    const languages = languageSamples.map((sample) => sample.language);
    expect(languages).toContain("python");
    expect(languages).toContain("javascript");
    for (const sample of [...languageSamples, ...quickStartSamples]) {
      expect(sample.code).toContain(originToken);
    }
  });

  test("withOrigin 用空 origin 时退回占位域名", () => {
    expect(withOrigin(originToken, "")).toBe(originPlaceholder);
    expect(withOrigin(originToken, "https://a.example")).toBe("https://a.example");
  });
});

describe("密钥页纯逻辑", () => {
  function key(overrides: Partial<DeveloperApiKey> = {}): DeveloperApiKey {
    return {
      id: "key_1",
      name: "生产环境",
      prefix: "hj_9fQ2",
      status: "active",
      lastUsedAt: null,
      requestCount: 0,
      createdAt: "2026-08-21T09:32:11.000Z",
      ...overrides,
    };
  }

  test("前缀统一展示成 hj_xxxx… 形式", () => {
    expect(formatKeyPrefix("hj_9fQ2")).toBe("hj_9fQ2…");
    expect(formatKeyPrefix("hj_9fQ2…")).toBe("hj_9fQ2…");
    expect(formatKeyPrefix("  ")).toBe("");
  });

  test("只统计生效中的密钥", () => {
    const keys = [key(), key({ id: "key_2", status: "revoked" }), key({ id: "key_3" })];
    expect(countActiveKeys(keys)).toBe(2);
    expect(maxActiveApiKeys).toBe(5);
  });

  test("密钥名称校验", () => {
    expect(validateKeyName("批量出图")).toBe(null);
    expect(typeof validateKeyName("   ")).toBe("string");
    expect(typeof validateKeyName("x".repeat(41))).toBe("string");
    expect(validateKeyName("x".repeat(40))).toBe(null);
  });

  test("两种错误体都能抽出可展示的文案", () => {
    expect(errorMessageFromPayload({ error: "名称已被占用" }, 400)).toBe("名称已被占用");
    expect(errorMessageFromPayload({ error: { code: "api_disabled", message: "开放 API 已关闭" } }, 403)).toBe("开放 API 已关闭");
    expect(errorMessageFromPayload({ error: { code: "server_error" } }, 500)).toBe("server_error");
    expect(errorMessageFromPayload(null, 502)).toBe("请求失败：502");
  });
});
