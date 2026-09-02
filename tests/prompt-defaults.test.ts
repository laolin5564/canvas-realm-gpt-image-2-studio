import { describe, expect, test } from "bun:test";
import { defaultNegativePromptFor, isCopyFriendlyTemplate } from "@/lib/prompt-defaults";
import { createGenerationTaskSchema } from "@/lib/validation";

describe("default negative prompt", () => {
  test("blocks stray text for ordinary templates", () => {
    const negativePrompt = defaultNegativePromptFor("company");
    expect(negativePrompt.includes("多余文字")).toBe(true);
    expect(negativePrompt.includes("低清晰度")).toBe(true);
  });

  test("keeps copy-carrying covers and posters free of the stray-text rule", () => {
    for (const category of ["platform", "公众号封面", "海报", "Cover"]) {
      const negativePrompt = defaultNegativePromptFor(category);
      expect(negativePrompt.includes("多余文字")).toBe(false);
      expect(negativePrompt.includes("文字乱码")).toBe(true);
    }
  });

  test("falls back to the strict rule set without a category", () => {
    expect(defaultNegativePromptFor().includes("多余文字")).toBe(true);
    expect(defaultNegativePromptFor(null).includes("多余文字")).toBe(true);
    expect(isCopyFriendlyTemplate(null)).toBe(false);
    expect(isCopyFriendlyTemplate("海报")).toBe(true);
  });

  test("is accepted by the task schema as a negative prompt", () => {
    const parsed = createGenerationTaskSchema.parse({
      mode: "text_to_image",
      prompt: "一只橘猫",
      negativePrompt: defaultNegativePromptFor("company"),
    });

    expect(parsed.negativePrompt?.includes("多余文字")).toBe(true);
  });
});

describe("reference image limits", () => {
  test("caps workbench reference images at four with a Chinese message", () => {
    const parsed = createGenerationTaskSchema.parse({
      mode: "image_to_image",
      prompt: "换个背景",
      sourceImageId: "src_1",
      sourceImageIds: ["src_1", "src_2", "src_3", "src_4"],
    });
    expect(parsed.sourceImageIds?.length).toBe(4);

    const tooMany = createGenerationTaskSchema.safeParse({
      mode: "image_to_image",
      prompt: "换个背景",
      sourceImageId: "src_1",
      sourceImageIds: ["src_1", "src_2", "src_3", "src_4", "src_5"],
    });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.message).toBe("参考图最多 4 张");
  });
});
