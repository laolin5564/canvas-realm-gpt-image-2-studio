import { describe, expect, test } from "bun:test";
import {
  buildPromptOptimizerSystemPrompt,
  buildPromptOptimizerUserPrompt,
  extractOptimizedPrompt,
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
