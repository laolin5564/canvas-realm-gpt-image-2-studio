export const sizeOptions = [
  "auto",
  "ecommerce_main_1_1",
  "ecommerce_vertical_3_4",
  "ecommerce_horizontal_4_3",
  "ecommerce_long_1_2",
  "douyin_cover_9_16",
  "xhs_cover_3_4",
  "wechat_cover_235_1",
  "banner_16_9",
  "poster_2_3",
  "hd_2k_1_1",
  "hd_4k_16_9",
  "hd_4k_9_16",
] as const;
export type ImageSizeOption = (typeof sizeOptions)[number];

export const imageQualityOptions = ["auto", "low", "medium", "high"] as const;
export type ImageQualityOption = (typeof imageQualityOptions)[number];

export const imageQualityLabels: Record<ImageQualityOption, string> = {
  auto: "自动（上游默认）",
  low: "低（更快）",
  medium: "中",
  high: "高清（默认）",
};

export function normalizeImageQualityOption(value: string | null | undefined): ImageQualityOption {
  if (value && imageQualityOptions.includes(value as ImageQualityOption)) {
    return value as ImageQualityOption;
  }
  return "auto";
}

export function apiQualityForOption(value: string | null | undefined): string | null {
  const normalized = normalizeImageQualityOption(value);
  return normalized === "auto" ? null : normalized;
}

export const imageSizeLabels: Record<ImageSizeOption, string> = {
  auto: "不限制",
  ecommerce_main_1_1: "电商主图 1:1",
  ecommerce_vertical_3_4: "电商竖图 3:4",
  ecommerce_horizontal_4_3: "电商横图 4:3",
  ecommerce_long_1_2: "电商长图 1:2",
  douyin_cover_9_16: "抖音封面 9:16",
  xhs_cover_3_4: "小红书封面 3:4",
  wechat_cover_235_1: "公众号封面 2.35:1",
  banner_16_9: "横幅 16:9",
  poster_2_3: "海报 2:3",
  hd_2k_1_1: "高清 2K 1:1（实验）",
  hd_4k_16_9: "超清 4K 16:9（实验）",
  hd_4k_9_16: "超清 4K 9:16（实验）",
};

const imageSizeApiMap: Record<ImageSizeOption, string | null> = {
  auto: null,
  ecommerce_main_1_1: "1024x1024",
  ecommerce_vertical_3_4: "1024x1536",
  ecommerce_horizontal_4_3: "1536x1024",
  ecommerce_long_1_2: "1024x1536",
  douyin_cover_9_16: "1024x1536",
  xhs_cover_3_4: "1024x1536",
  wechat_cover_235_1: "1536x1024",
  banner_16_9: "1536x1024",
  poster_2_3: "1024x1536",
  hd_2k_1_1: "2048x2048",
  hd_4k_16_9: "3840x2160",
  hd_4k_9_16: "2160x3840",
};

const imageSizeRatioMap: Record<ImageSizeOption, { width: number; height: number }> = {
  auto: { width: 0, height: 0 },
  ecommerce_main_1_1: { width: 1, height: 1 },
  ecommerce_vertical_3_4: { width: 3, height: 4 },
  ecommerce_horizontal_4_3: { width: 4, height: 3 },
  ecommerce_long_1_2: { width: 1, height: 2 },
  douyin_cover_9_16: { width: 9, height: 16 },
  xhs_cover_3_4: { width: 3, height: 4 },
  wechat_cover_235_1: { width: 235, height: 100 },
  banner_16_9: { width: 16, height: 9 },
  poster_2_3: { width: 2, height: 3 },
  hd_2k_1_1: { width: 1, height: 1 },
  hd_4k_16_9: { width: 16, height: 9 },
  hd_4k_9_16: { width: 9, height: 16 },
};

export function isImageSizeOption(value: string): value is ImageSizeOption {
  return sizeOptions.includes(value as ImageSizeOption);
}

export function normalizeImageSizeOption(value: string | null | undefined): ImageSizeOption {
  if (!value) {
    return "auto";
  }
  if (isImageSizeOption(value)) {
    return value;
  }

  if (value === "1024x1024") {
    return "ecommerce_main_1_1";
  }
  if (value === "1024x1536") {
    return "poster_2_3";
  }
  if (value === "1536x1024") {
    return "banner_16_9";
  }

  return "auto";
}

export function apiSizeForOption(value: string): string | null {
  return imageSizeApiMap[normalizeImageSizeOption(value)];
}

export function ratioForOption(value: string): { width: number; height: number } {
  return imageSizeRatioMap[normalizeImageSizeOption(value)];
}

export function sizeFromDimensions(width: number, height: number): ImageSizeOption {
  if (width <= 0 || height <= 0) {
    return "auto";
  }

  const ratio = width / height;
  const candidates = sizeOptions.filter((option) => option !== "auto");
  const closest = candidates.reduce<ImageSizeOption>((best, candidate) => {
    const bestRatio = imageSizeRatioMap[best].width / imageSizeRatioMap[best].height;
    const candidateRatio = imageSizeRatioMap[candidate].width / imageSizeRatioMap[candidate].height;
    return Math.abs(candidateRatio - ratio) < Math.abs(bestRatio - ratio) ? candidate : best;
  }, "ecommerce_main_1_1");

  return closest;
}
