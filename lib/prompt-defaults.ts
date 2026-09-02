import type { TemplateCategory } from "./types";

// 通用负面提示：任何模式都不希望出现的质量问题。
const baseNegativePrompt = [
  "低清晰度",
  "画面模糊",
  "噪点",
  "畸形结构",
  "多余肢体",
  "廉价促销感",
  "杂乱拼贴",
  "水印",
  "logo 乱印",
];

// 文字相关：封面/海报类图本身就要出标题文案，不能一刀切禁掉文字。
const textNegativePrompt = ["多余文字", "文字乱码", "无意义小字"];
const copyFriendlyNegativePrompt = ["文字乱码", "错别字", "文字贴边被裁切"];

// 需要在画面里保留标题/文案的模板类别，不加「多余文字」。
const copyFriendlyCategories: readonly TemplateCategory[] = ["platform"];

const copyFriendlyKeywords = ["封面", "海报", "banner", "cover", "poster", "首图", "头图"];

export function isCopyFriendlyTemplate(templateCategory?: TemplateCategory | string | null): boolean {
  if (!templateCategory) {
    return false;
  }
  if (copyFriendlyCategories.includes(templateCategory as TemplateCategory)) {
    return true;
  }
  const normalized = templateCategory.toLowerCase();
  return copyFriendlyKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

// 默认负面提示词：按模板类别给不同基线，供前端预填使用。
export function defaultNegativePromptFor(templateCategory?: TemplateCategory | string | null): string {
  const textRules = isCopyFriendlyTemplate(templateCategory) ? copyFriendlyNegativePrompt : textNegativePrompt;
  return [...textRules, ...baseNegativePrompt].join("、");
}
