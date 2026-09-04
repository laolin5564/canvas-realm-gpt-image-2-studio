import { describe, expect, test } from "bun:test";
import { ratioPromptTextForOption, sizeOptions } from "@/lib/image-options";

// buildPrompt 那半边在 tests/build-prompt-ratio.node.ts：lib/image-provider 顺着
// lib/db 依赖 node:sqlite，bun 里加载不了，走仓库既有的 node:test 通道。
describe("ratioPromptTextForOption", () => {
  test("auto 不给画幅要求", () => {
    expect(ratioPromptTextForOption("auto")).toBe(null);
  });

  test("各档比例文本正确，2.35:1 不写成 235:100", () => {
    expect(ratioPromptTextForOption("douyin_cover_9_16")).toBe("9:16 竖版");
    expect(ratioPromptTextForOption("banner_16_9")).toBe("16:9 横版");
    expect(ratioPromptTextForOption("ecommerce_main_1_1")).toBe("1:1 方图");
    expect(ratioPromptTextForOption("wechat_cover_235_1")).toBe("2.35:1 横版");
    expect(ratioPromptTextForOption("xhs_cover_3_4")).toBe("3:4 竖版");
    expect(ratioPromptTextForOption("ecommerce_long_1_2")).toBe("1:2 竖版");
    expect(ratioPromptTextForOption("ecommerce_vertical_3_4")).toBe("3:4 竖版");
    expect(ratioPromptTextForOption("ecommerce_horizontal_4_3")).toBe("4:3 横版");
    expect(ratioPromptTextForOption("poster_2_3")).toBe("2:3 竖版");
    expect(ratioPromptTextForOption("hd_2k_1_1")).toBe("1:1 方图");
    expect(ratioPromptTextForOption("hd_4k_16_9")).toBe("16:9 横版");
    expect(ratioPromptTextForOption("hd_4k_9_16")).toBe("9:16 竖版");
  });

  test("除 auto 外每档都给得出画幅文本", () => {
    for (const option of sizeOptions) {
      const text = ratioPromptTextForOption(option);
      if (option === "auto") {
        expect(text).toBe(null);
        continue;
      }
      expect(typeof text).toBe("string");
      expect((text ?? "").length).toBeGreaterThan(0);
    }
  });

  test("未知档位按 auto 处理", () => {
    expect(ratioPromptTextForOption("不存在的档位")).toBe(null);
  });
});
