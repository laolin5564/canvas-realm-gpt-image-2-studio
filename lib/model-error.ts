import { openAIOAuthImageGenerationScope } from "./openai-oauth";

interface ModelErrorMessages {
  // 面向终端用户：只说清楚“发生了什么、该怎么办”，不暴露上游细节。
  user: string;
  // 面向管理员：保留排查线索（状态码、配置建议）。
  admin: string;
}

export function cleanModelErrorText(text: string): string {
  return text
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[redacted]"')
    .replace(/"id_token"\s*:\s*"[^"]+"/gi, '"id_token":"[redacted]"')
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isModelTimeoutMessage(message: string): boolean {
  return /(?:超时|模型接口超时|timeout|timed out|504|524|gateway time-out)/i.test(message);
}

function classifyModelError(status: number, text: string, fallback: string): ModelErrorMessages {
  const plainText = cleanModelErrorText(text);
  const lowerText = `${plainText} ${text}`.toLowerCase();

  if (status === 524 || status === 504 || /timeout occurred|gateway time-out|timed out/i.test(text)) {
    return {
      user: "生成服务响应超时，请稍后重试。",
      admin: `模型接口超时（${status}）：上游生成服务响应太慢。建议稍后重试，或在管理员后台降低并发请求数；如果走 Cloudflare/Nginx，也需要检查上游网关超时配置。`,
    };
  }

  if (status >= 300 && status < 400) {
    return {
      user: "生成服务暂时不可用，请稍后重试。",
      admin: `源站返回重定向（${status}）：请检查该渠道 Base URL 的协议（http/https）与源站 Host 主机块配置——直连源站 IP 时，Host 对应的 server 块不能有 http→https 跳转（certbot 默认写法 return 301），生图接口不跟随重定向。`,
    };
  }

  if (status === 413) {
    return {
      user: "参考图太大，请压缩后重试或减少参考图数量。",
      admin: "参考图请求体过大（413）：上传图片或多张参考图的总大小超过了模型网关限制。请压缩图片后重试，或在上游 Nginx 调高 client_max_body_size。",
    };
  }

  if (status === 429) {
    return {
      user: "当前排队较多，系统会自动重试，请稍后查看。",
      admin: "模型接口限流（429）：当前请求过快或账号额度被限速。请稍后重试，或在管理员后台降低并发请求数。",
    };
  }

  if (/(insufficient_quota|billing|balance|credit|quota|余额|额度不足|欠费)/i.test(lowerText)) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: "模型账号余额或额度不足：请检查模型服务账号余额、订阅状态或 API 额度。",
    };
  }

  if (status === 404 || /(model_not_found|model .*not found|does not exist|模型不存在)/i.test(lowerText)) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: "模型不存在或接口地址不匹配：请检查管理员后台的 Base URL 与模型名称是否属于同一个服务。",
    };
  }

  if (status === 401 && plainText.includes(openAIOAuthImageGenerationScope)) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: `OpenAI OAuth 不能直接调用官方 Platform 图片接口，缺少 ${openAIOAuthImageGenerationScope}。请确认服务已重启并使用 Codex Responses 图片工具桥接；如果仍失败，请切回 sub2api/API Key 模式。`,
    };
  }

  if ((status === 401 || status === 403) && /(permission|scope|forbidden|unauthorized|无权限|权限不足)/i.test(lowerText)) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: `模型账号权限不足（${status}）：当前账号没有调用该图片模型的权限。请检查账号角色、授权范围或切换到可用的 API Key/OAuth 账号。`,
    };
  }

  if (status === 401) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: "模型接口认证失败（401）：API Key 无效、已过期或没有配置到当前服务。请检查管理员后台的模型配置。",
    };
  }

  if (status === 403) {
    return {
      user: "生成服务暂时不可用，管理员已收到通知。",
      admin: "模型接口拒绝访问（403）：当前账号或网关不允许调用该接口。请检查模型服务权限、IP 白名单或代理配置。",
    };
  }

  if (status >= 500) {
    return {
      user: "生成服务暂时不可用，请稍后重试。",
      admin: `模型服务暂时不可用（${status}）：上游网关或模型服务返回错误。请稍后重试；如果持续出现，请检查 Base URL 后端服务状态。`,
    };
  }

  if (status === 400 || /(content_policy|safety|moderation|blocked|违规|审核|敏感)/i.test(lowerText)) {
    return {
      user: "描述可能不符合平台规范，请调整后重试。",
      admin: `模型接口拒绝了本次请求（${status}）：多为内容审核或参数不合法。请检查 prompt 内容与请求参数。`,
    };
  }

  const detail = plainText || text.trim();
  return {
    user: "生成失败，请稍后重试；如果反复失败请联系管理员。",
    admin: `${fallback}: ${status}${detail ? ` ${detail.slice(0, 220)}` : ""}`,
  };
}

// 面向终端用户的失败文案。
export function formatModelError(status: number, text: string, fallback: string): string {
  return classifyModelError(status, text, fallback).user;
}

// 面向管理员的失败详情：状态码 + 处置建议 + 上游原文片段。
export function formatModelErrorDetail(status: number, text: string, fallback: string): string {
  const { admin } = classifyModelError(status, text, fallback);
  const raw = cleanModelErrorText(text) || text.trim();
  return raw ? `${admin}（HTTP ${status}｜上游原文：${raw.slice(0, 500)}）` : `${admin}（HTTP ${status}）`;
}
