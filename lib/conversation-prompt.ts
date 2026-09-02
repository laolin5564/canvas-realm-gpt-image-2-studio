export interface ComposedConversationPrompt {
  finalPrompt: string;
  fixedPrompt: string | null;
  promptSuffix: string | null;
  messageContent: string;
}

// 固定提示词经常是多行清单，压缩行内空白但保留换行（最多连续两个换行）。
export function normalizeConversationFixedPrompt(value: string | null | undefined): string | null {
  const normalized = value
    ?.replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function composeConversationPrompt(
  prompt: string,
  fixedPrompt: string | null | undefined,
): ComposedConversationPrompt {
  const normalizedPrompt = prompt.trim();
  const normalizedFixedPrompt = normalizeConversationFixedPrompt(fixedPrompt);

  if (!normalizedFixedPrompt) {
    return {
      finalPrompt: normalizedPrompt,
      fixedPrompt: null,
      promptSuffix: null,
      messageContent: normalizedPrompt,
    };
  }

  const finalPrompt = normalizedPrompt
    ? `${normalizedFixedPrompt}\n\n本次补充：${normalizedPrompt}`
    : normalizedFixedPrompt;

  return {
    finalPrompt,
    fixedPrompt: normalizedFixedPrompt,
    promptSuffix: normalizedPrompt || null,
    messageContent: normalizedPrompt || "按会话固定提示词处理",
  };
}
