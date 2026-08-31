import { describe, expect, test } from "bun:test";
import { apiQualityForOption, apiSizeForOption, normalizeImageQualityOption } from "@/lib/image-options";

describe("image quality option", () => {
  test("auto and unknown values are normalized to auto and omitted from API calls", () => {
    expect(normalizeImageQualityOption(null)).toBe("auto");
    expect(normalizeImageQualityOption("")).toBe("auto");
    expect(normalizeImageQualityOption("ultra")).toBe("auto");
    expect(apiQualityForOption(null)).toBe(null);
    expect(apiQualityForOption("auto")).toBe(null);
  });

  test("explicit qualities pass through", () => {
    expect(apiQualityForOption("low")).toBe("low");
    expect(apiQualityForOption("medium")).toBe("medium");
    expect(apiQualityForOption("high")).toBe("high");
  });
});

describe("hd size options", () => {
  test("map to 2K/4K API sizes", () => {
    expect(apiSizeForOption("hd_2k_1_1")).toBe("2048x2048");
    expect(apiSizeForOption("hd_4k_16_9")).toBe("3840x2160");
    expect(apiSizeForOption("hd_4k_9_16")).toBe("2160x3840");
  });

  test("legacy sizes unchanged", () => {
    expect(apiSizeForOption("ecommerce_main_1_1")).toBe("1024x1024");
    expect(apiSizeForOption("auto")).toBe(null);
  });
});
