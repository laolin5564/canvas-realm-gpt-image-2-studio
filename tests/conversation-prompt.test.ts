import { describe, expect, test } from "bun:test";
import { composeConversationPrompt, normalizeConversationFixedPrompt } from "@/lib/conversation-prompt";
import { continueConversationSchema } from "@/lib/validation";

describe("conversation fixed prompt", () => {
  test("normalizes empty fixed prompts to null", () => {
    expect(normalizeConversationFixedPrompt("  ")).toBe(null);
    expect(normalizeConversationFixedPrompt("  统一白底主图  ")).toBe("统一白底主图");
  });

  test("keeps line breaks in a multi-line fixed prompt", () => {
    const normalized = normalizeConversationFixedPrompt(
      "  统一白底电商主图  \r\n   1. 保持产品轮廓\n\n\n2. 真实阴影  \n  ",
    );

    expect(normalized).toBe("统一白底电商主图\n1. 保持产品轮廓\n\n2. 真实阴影");
  });

  test("still collapses runs of inline whitespace", () => {
    expect(normalizeConversationFixedPrompt("白底    主图\t\t干净")).toBe("白底 主图 干净");
    expect(normalizeConversationFixedPrompt("\n\n  \n")).toBe(null);
  });

  test("composes fixed prompt with an optional per-message supplement", () => {
    const composed = composeConversationPrompt("把阴影更柔和", "统一白底电商主图");

    expect(composed.finalPrompt).toBe("统一白底电商主图\n\n本次补充：把阴影更柔和");
    expect(composed.fixedPrompt).toBe("统一白底电商主图");
    expect(composed.promptSuffix).toBe("把阴影更柔和");
    expect(composed.messageContent).toBe("把阴影更柔和");
  });

  test("caps reference images at four with a Chinese message", () => {
    const parsed = continueConversationSchema.parse({
      prompt: "换个背景",
      sourceImageId: "src_1",
      referenceImageIds: ["a", "b", "c", "d"],
    });
    expect(parsed.referenceImageIds?.length).toBe(4);

    const tooMany = continueConversationSchema.safeParse({
      prompt: "换个背景",
      sourceImageId: "src_1",
      referenceImageIds: ["a", "b", "c", "d", "e"],
    });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.message).toBe("参考图最多 4 张");
  });

  test("allows an empty conversation message so the fixed prompt can drive the task", () => {
    const parsed = continueConversationSchema.parse({
      prompt: "",
      sourceImageId: "src_1",
    });

    expect(parsed.prompt).toBe("");
  });
});
