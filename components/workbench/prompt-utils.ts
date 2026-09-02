import type { PublicTemplate } from "@/lib/types";
import type { TemplateVariableValues } from "@/lib/template-prompt";
import type { CaseTryPromptPayload } from "@/components/workbench/types";

export function missingTemplateVariables(template: PublicTemplate, values: TemplateVariableValues): string[] {
  return template.templateVariables
    .filter((variable) => variable.required && !values[variable.key]?.trim())
    .map((variable) => variable.label);
}

/** AI 优化提示词失败时的本地兜底规则。 */
export function improvePromptText(value: string, template: PublicTemplate | null, sizeLabel: string): string {
  const promptText = value.trim();
  const additions = [
    `目标规格：${sizeLabel}`,
    "画面要求：主体明确，构图稳定，光线自然，材质清晰，商业摄影质感，高级但不杂乱。",
    "输出要求：避免乱码文字、畸形结构、低清晰度、廉价促销感；如果需要标题区，请预留干净留白。",
  ];
  if (template?.name) {
    additions.unshift(`生产模板：${template.name}`);
  }
  return [promptText, ...additions].filter(Boolean).join("\n");
}

/** 案例中心「试一试」通过 sessionStorage 传 prompt，读完即删。 */
export function readCaseTryPrompt(storageKey: string | null): CaseTryPromptPayload | null {
  if (!storageKey) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    window.sessionStorage.removeItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CaseTryPromptPayload>;
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
      return null;
    }
    return {
      caseId: typeof parsed.caseId === "number" ? parsed.caseId : undefined,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      prompt: parsed.prompt,
      size: typeof parsed.size === "string" ? parsed.size : undefined,
    };
  } catch {
    return null;
  }
}
