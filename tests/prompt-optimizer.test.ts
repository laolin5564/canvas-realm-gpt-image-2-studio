import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import {
  buildPromptOptimizerSystemPrompt,
  buildPromptOptimizerUserPrompt,
  extractOptimizedPrompt,
  requestChatCompletionsApi,
  requestResponsesApi,
  toPromptOptimizerNetworkError,
} from "@/lib/prompt-optimizer";
import { optimizePromptSchema } from "@/lib/validation";

describe("prompt optimizer", () => {
  test("omits empty template variables from optimizer context", () => {
    const prompt = buildPromptOptimizerUserPrompt({
      prompt: "生成一张公众号封面图",
      mode: "text_to_image",
      sizeLabel: "公众号封面 2.35:1",
      templateName: "公众号封面图",
      templateDescription: "横版封面",
      variables: {
        文章主题: "AI 图片工作流",
        标题文案: "",
        品牌风格: "理性科技",
      },
    });

    expect(prompt.includes("文章主题: AI 图片工作流")).toBe(true);
    expect(prompt.includes("品牌风格: 理性科技")).toBe(true);
    expect(prompt.includes("标题文案:")).toBe(false);
  });

  test("carries mode, size and negative prompt into the optimizer context", () => {
    const prompt = buildPromptOptimizerUserPrompt({
      prompt: "把背景换成浅灰摄影棚",
      mode: "image_to_image",
      sizeLabel: "电商主图 1:1",
      negativePrompt: "多余文字、水印",
      templateName: null,
      templateDescription: null,
      variables: {},
    });

    expect(prompt.includes("图生图")).toBe(true);
    expect(prompt.includes("电商主图 1:1")).toBe(true);
    expect(prompt.includes("多余文字、水印")).toBe(true);
  });

  test("falls back to safe defaults when optional context is missing", () => {
    const prompt = buildPromptOptimizerUserPrompt({ prompt: "一只橘猫" });

    expect(prompt.includes("文生图")).toBe(true);
    expect(prompt.includes("目标规格：不限制")).toBe(true);
    expect(prompt.trim().endsWith("一只橘猫")).toBe(true);
  });

  test("tells the model to keep edit semantics for image_to_image", () => {
    const editSystemPrompt = buildPromptOptimizerSystemPrompt("image_to_image");
    expect(editSystemPrompt.includes("编辑指令")).toBe(true);
    expect(editSystemPrompt.includes("不要把编辑指令改写成完整场景描述")).toBe(true);

    const textSystemPrompt = buildPromptOptimizerSystemPrompt("text_to_image");
    expect(textSystemPrompt.includes("本次是文生图")).toBe(true);
    expect(textSystemPrompt.includes("不要把编辑指令改写成完整场景描述")).toBe(false);
    expect(buildPromptOptimizerSystemPrompt(undefined)).toBe(textSystemPrompt);
  });

  test("accepts the optional optimizer context over the API schema", () => {
    const parsed = optimizePromptSchema.parse({
      prompt: "把背景换成浅灰摄影棚",
      mode: "image_to_image",
      sizeLabel: "电商主图 1:1",
      negativePrompt: "  多余文字  ",
    });

    expect(parsed.mode).toBe("image_to_image");
    expect(parsed.negativePrompt).toBe("多余文字");
    expect(Object.keys(parsed.variables).length).toBe(0);

    const minimal = optimizePromptSchema.parse({ prompt: "一只橘猫" });
    expect(minimal.mode).toBe("text_to_image");
    expect(minimal.sizeLabel).toBe("不限制");
    expect(minimal.negativePrompt).toBe(null);
  });

  test("extracts JSON prompt from model payloads", () => {
    expect(extractOptimizedPrompt({
      output_text: "{\"prompt\":\"优化后的提示词\"}",
    })).toBe("优化后的提示词");

    expect(extractOptimizedPrompt({
      choices: [{ message: { content: "```json\n{\"prompt\":\"聊天接口提示词\"}\n```" } }],
    })).toBe("聊天接口提示词");
  });
});

describe("prompt optimizer transport", () => {
  interface Captured {
    url: string;
    host: string | null;
    authorization: string | null;
    body: unknown;
  }

  let server: http.Server;
  let baseUrl = "";
  const captured: Captured[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured.push({
          url: request.url ?? "",
          host: request.headers.host ?? null,
          authorization: request.headers.authorization ?? null,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "content-type": "application/json" });
        if ((request.url ?? "").endsWith("/responses")) {
          response.end(JSON.stringify({ output_text: JSON.stringify({ prompt: "来自 responses" }) }));
        } else {
          response.end(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: "来自 chat" }) } }] }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器没有拿到端口");
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("hostHeader 透传到 Responses / Chat Completions 两条请求的 Host 头", async () => {
    captured.length = 0;

    const responses = await requestResponsesApi(baseUrl, "gpt-5.5", "sk-test", "系统", "用户", "s2a.laolin.ai");
    const chat = await requestChatCompletionsApi(baseUrl, "gpt-5.5", "sk-test", "系统", "用户", "s2a.laolin.ai");

    expect(extractOptimizedPrompt(responses)).toBe("来自 responses");
    expect(extractOptimizedPrompt(chat)).toBe("来自 chat");
    expect(captured.map((item) => item.url).join(",")).toBe("/v1/responses,/v1/chat/completions");
    expect(captured.map((item) => item.host).join(",")).toBe("s2a.laolin.ai,s2a.laolin.ai");
    expect(captured.every((item) => item.authorization === "Bearer sk-test")).toBe(true);
    expect((captured[0]?.body as { model: string }).model).toBe("gpt-5.5");
  });

  test("hostHeader 为 undefined 时 Host 就是 URL 里的地址", async () => {
    captured.length = 0;

    await requestResponsesApi(baseUrl, "gpt-5.5", "sk-test", "系统", "用户", undefined);

    expect(captured[0]?.host).toBe(new URL(baseUrl).host);
  });

  test("连不上源站：给前端的是中文短文案，不带源站 IP/端口", async () => {
    let failure: unknown = null;
    try {
      await requestResponsesApi("http://127.0.0.1:1/v1", "gpt-5.5", "sk-test", "系统", "用户", "s2a.laolin.ai");
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toBe("提示词优化服务连接失败，请稍后重试或直接使用当前提示词。");
    expect((failure as Error).cause instanceof TypeError).toBe(true);
  });

  test("toPromptOptimizerNetworkError 的映射", () => {
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 69.63.221.194:80") });
    const mapped = toPromptOptimizerNetworkError(refused);
    expect(mapped.message).toBe("提示词优化服务连接失败，请稍后重试或直接使用当前提示词。");
    expect(mapped.message.includes("69.63.221.194")).toBe(false);
    expect(mapped.cause).toBe(refused);

    expect(toPromptOptimizerNetworkError(new DOMException("timed out", "TimeoutError")).message).toBe(
      "提示词优化超时，请稍后重试或直接使用当前提示词。",
    );
    const other = new Error("提示词优化模型返回为空");
    expect(toPromptOptimizerNetworkError(other)).toBe(other);
    expect(toPromptOptimizerNetworkError("boom").message).toBe("提示词优化调用失败");
  });
});
