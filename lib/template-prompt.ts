import type { PublicTemplate } from "./types";

export type TemplateVariableValues = Record<string, string>;

const placeholderPattern = /\{([^{}]+)\}/g;
const promptSegmentPattern = /[^。！？!?；;\n]+[。！？!?；;]?|\n+/g;
const clauseSeparatorPattern = /([，,、])/;
const segmentEnderPattern = /[。！？!?；;]$/;
const trailingPlaceholderPattern = /\{([^{}]+)\}[\s。！？!?；;：:，,、]*$/;
const droppableClausePattern = /^[\s，,、；;：:。！？!?（）()【】[\]"'“”‘’·—\-…]*$/;
const emptyMarker = "\u0000";

function splitPromptSegments(prompt: string): string[] {
  return prompt.match(promptSegmentPattern) ?? [prompt];
}

function placeholderValue(values: TemplateVariableValues, rawKey: string): string {
  return values[rawKey.trim()]?.trim() ?? "";
}

function placeholderKeys(text: string): string[] {
  return Array.from(text.matchAll(placeholderPattern)).map((match) => match[1] ?? "");
}

function hasEmptyPlaceholder(text: string, values: TemplateVariableValues): boolean {
  return placeholderKeys(text).some((key) => !placeholderValue(values, key));
}

function hasFilledPlaceholder(text: string, values: TemplateVariableValues): boolean {
  return placeholderKeys(text).some((key) => Boolean(placeholderValue(values, key)));
}

// 「标题文案：{标题文案}」这类整条只有标签和空变量的子句，整条去掉，避免留下孤立标签。
function isLabelOnlyClause(text: string, values: TemplateVariableValues): boolean {
  const match = text.match(trailingPlaceholderPattern);
  if (!match) {
    return false;
  }
  return !placeholderValue(values, match[1] ?? "") && !hasFilledPlaceholder(text, values);
}

function substitutePlaceholders(text: string, values: TemplateVariableValues): string {
  return text.replace(placeholderPattern, (_match, rawKey: string) => placeholderValue(values, rawKey) || emptyMarker);
}

// 只抹掉空占位符本身，连带紧邻的包裹符号、中英文连接标点与多余空格。
function stripEmptyMarkers(text: string): string {
  return text
    .replace(/[（(【[「『“"']\s*\u0000\s*[）)】\]」』”"']/g, "")
    .replace(/\s*[、/／|｜]\s*\u0000/g, "")
    .replace(/\u0000\s*[、/／|｜]\s*/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

interface PromptClause {
  text: string;
  separator: string;
}

function splitClauses(body: string): PromptClause[] {
  const parts = body.split(clauseSeparatorPattern);
  const clauses: PromptClause[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    clauses.push({ text: parts[index] ?? "", separator: parts[index + 1] ?? "" });
  }
  return clauses;
}

function renderSegment(segment: string, values: TemplateVariableValues): string {
  if (!segment.trim()) {
    return segment;
  }

  const ender = segment.match(segmentEnderPattern)?.[0] ?? "";
  const body = ender ? segment.slice(0, -ender.length) : segment;

  const kept: PromptClause[] = [];
  for (const clause of splitClauses(body)) {
    if (!hasEmptyPlaceholder(clause.text, values)) {
      kept.push({ text: substitutePlaceholders(clause.text, values), separator: clause.separator });
      continue;
    }
    if (isLabelOnlyClause(clause.text, values)) {
      continue;
    }
    const cleaned = stripEmptyMarkers(substitutePlaceholders(clause.text, values));
    if (droppableClausePattern.test(cleaned)) {
      continue;
    }
    kept.push({ text: cleaned, separator: clause.separator });
  }

  if (kept.length === 0) {
    return "";
  }

  const rebuilt = kept
    .map((clause, index) => (index === kept.length - 1 ? clause.text : `${clause.text}${clause.separator || "，"}`))
    .join("")
    .replace(/^[\s，,、]+/, "");

  return rebuilt.trim() ? `${rebuilt}${ender}` : "";
}

export function defaultValuesForTemplate(template: PublicTemplate): TemplateVariableValues {
  return Object.fromEntries(
    template.templateVariables.map((variable) => [
      variable.key,
      variable.defaultValue ?? variable.options[0]?.value ?? "",
    ]),
  );
}

export function renderTemplatePrompt(template: PublicTemplate, values: TemplateVariableValues): string {
  return splitPromptSegments(template.defaultPrompt)
    .map((segment) => renderSegment(segment, values))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
