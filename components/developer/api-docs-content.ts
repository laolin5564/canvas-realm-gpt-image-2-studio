import { apiSizeForOption, imageQualityLabels, imageQualityOptions, imageSizeLabels, sizeOptions } from "@/lib/image-options";
import type { ImageQualityOption, ImageSizeOption } from "@/lib/image-options";

/**
 * 文档里所有示例的站点地址占位符。SSR 阶段拿不到真实域名，先渲染占位符，
 * 客户端挂载后统一用 window.location.origin 替换，避免把域名写死在仓库里。
 */
export const originToken = "{{ORIGIN}}";
export const originPlaceholder = "https://your-domain.example";

export function withOrigin(text: string, origin: string): string {
  return text.replaceAll(originToken, origin || originPlaceholder);
}

/** 把多行 JSON 片段嵌进外层示例时补齐缩进，保证拼出来的字符串仍是合法 JSON。 */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${pad}${line}`))
    .join("\n");
}

export interface DocSection {
  id: string;
  title: string;
}

export const docSections: DocSection[] = [
  { id: "auth", title: "鉴权方式" },
  { id: "quickstart", title: "快速开始" },
  { id: "endpoints", title: "接口列表" },
  { id: "sizes", title: "尺寸选项" },
  { id: "params", title: "质量与数量" },
  { id: "errors", title: "错误码" },
  { id: "limits", title: "使用限制" },
  { id: "samples", title: "代码示例" },
];

export const apiKeyPattern = "hj_<24 位大小写字母或数字>";

export const authNotes: string[] = [
  "所有 /api/v1 接口都用请求头 Authorization: Bearer <你的密钥> 鉴权，不读浏览器 Cookie。",
  `密钥格式为 ${apiKeyPattern}，例如 hj_9fQ2aB3cD4eF5gH6jK7mN8pR。`,
  "完整密钥只在创建时返回一次，服务端只保存哈希；丢失后无法找回，只能撤销后重新创建。",
  "密钥等同账号权限：调用产生的图片进入你自己的历史记录，消耗你自己的月度额度。",
  "请把密钥放在服务端环境变量里，不要写进前端代码或公开仓库。",
];

export const authHeaderExample = "Authorization: Bearer hj_9fQ2aB3cD4eF5gH6jK7mN8pR";

/** 密钥列表里统一展示成 hj_xxxx… 的省略形式。 */
export function formatKeyPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("…") ? trimmed : `${trimmed}…`;
}

const succeededTaskExample = `{
  "id": "task_5NpQx7Kd",
  "status": "succeeded",
  "progress_stage": "completed",
  "mode": "text_to_image",
  "prompt": "青瓷色背景上的极简香薰瓶，柔和顶光，产品主图",
  "size": "ecommerce_main_1_1",
  "quality": "high",
  "n": 1,
  "created_at": "2026-09-03T02:14:07.000Z",
  "started_at": "2026-09-03T02:14:08.000Z",
  "completed_at": "2026-09-03T02:14:41.000Z",
  "error": null,
  "images": [
    {
      "id": "img_8Ff1Ac",
      "url": "${originToken}/api/files/2026/09/03/img_8Ff1Ac.png?sig=6f0a9c1d&exp=1788768847",
      "thumbnail_url": "${originToken}/api/files/2026/09/03/img_8Ff1Ac.png?sig=6f0a9c1d&exp=1788768847&thumb=1",
      "width": 1024,
      "height": 1024
    }
  ]
}`;

const queuedTaskExample = `{
  "id": "task_5NpQx7Kd",
  "status": "queued",
  "progress_stage": "queued",
  "mode": "text_to_image",
  "prompt": "青瓷色背景上的极简香薰瓶，柔和顶光，产品主图",
  "size": "ecommerce_main_1_1",
  "quality": "high",
  "n": 2,
  "created_at": "2026-09-03T02:14:07.000Z",
  "started_at": null,
  "completed_at": null,
  "error": null,
  "images": []
}`;

export type EndpointAuth = "session" | "bearer";

export interface ApiEndpoint {
  id: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  title: string;
  auth: EndpointAuth;
  summary: string;
  notes: string[];
  requestExample: string | null;
  requestLabel: string;
  responseExample: string | null;
  responseLabel: string;
  responseNote: string | null;
}

export const endpointAuthLabels: Record<EndpointAuth, string> = {
  session: "登录态（浏览器 Cookie）",
  bearer: "Bearer 密钥",
};

export const apiEndpoints: ApiEndpoint[] = [
  {
    id: "list-keys",
    method: "GET",
    path: "/api/user/api-keys",
    title: "查询自己的密钥列表",
    auth: "session",
    summary: "本页密钥表格用的就是这个接口，只返回前缀，不返回完整密钥。",
    notes: ["status 取值 active / revoked。", "lastUsedAt 为 null 表示这把密钥还没被调用过。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "keys": [
    {
      "id": "key_7Kq2Xn",
      "name": "生产环境",
      "prefix": "hj_9fQ2",
      "status": "active",
      "lastUsedAt": "2026-09-03T02:14:07.000Z",
      "requestCount": 128,
      "createdAt": "2026-08-21T09:32:11.000Z"
    }
  ]
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "create-key",
    method: "POST",
    path: "/api/user/api-keys",
    title: "创建新密钥",
    auth: "session",
    summary: "name 长度 1-40；返回体里的 secret 是唯一一次能看到完整密钥的机会。",
    notes: ["每个账号最多同时持有 5 把有效密钥，超出会返回 400 参数错误。", "管理员关闭开放 API 后，这个接口返回 403 api_disabled。"],
    requestExample: `{
  "name": "生产环境"
}`,
    requestLabel: "请求体",
    responseExample: `{
  "key": {
    "id": "key_7Kq2Xn",
    "name": "生产环境",
    "prefix": "hj_9fQ2",
    "createdAt": "2026-08-21T09:32:11.000Z"
  },
  "secret": "hj_9fQ2aB3cD4eF5gH6jK7mN8pR"
}`,
    responseLabel: "响应 201",
    responseNote: null,
  },
  {
    id: "revoke-key",
    method: "DELETE",
    path: "/api/user/api-keys/{id}",
    title: "撤销密钥",
    auth: "session",
    summary: "撤销后 status 变成 revoked，立即失效且不可恢复，已生成的图片不受影响。",
    notes: ["id 取自密钥列表的 id 字段。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "ok": true
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "me",
    method: "GET",
    path: "/api/v1/me",
    title: "查询密钥归属账号与剩余额度",
    auth: "bearer",
    summary: "用来自检密钥是否有效、本月还剩多少张额度。",
    notes: ["monthlyQuota 为 null 表示该账号不限额度，此时 remaining 也是 null。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "user": {
    "id": "usr_3d81f0",
    "name": "老林"
  },
  "quota": {
    "monthlyQuota": 500,
    "monthUsed": 128,
    "remaining": 372
  }
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "generations",
    method: "POST",
    path: "/api/v1/images/generations",
    title: "文生图",
    auth: "bearer",
    summary: "JSON 请求体。wait=false 立刻返回 202 任务；wait=true 时服务端最长等 240 秒，完成则直接带回图片。",
    notes: [
      "prompt 必填，长度 1-8000。",
      "size 默认 auto，取值见下方尺寸选项表；quality 默认 high；n 默认 1，只能是 1 / 2 / 4。",
      "response_format 默认 url；填 b64_json 时图片同时以 base64 内联返回。",
      "wait=true 超过 240 秒仍未完成时返回 202，改用轮询即可，任务不会被取消。",
    ],
    requestExample: `{
  "prompt": "青瓷色背景上的极简香薰瓶，柔和顶光，产品主图",
  "negative_prompt": "文字, 水印",
  "size": "ecommerce_main_1_1",
  "quality": "high",
  "n": 1,
  "wait": true,
  "response_format": "url"
}`,
    requestLabel: "请求体",
    responseExample: `{
  "task": ${indentBlock(succeededTaskExample, 2)},
  "data": [
    {
      "id": "img_8Ff1Ac",
      "url": "${originToken}/api/files/2026/09/03/img_8Ff1Ac.png?sig=6f0a9c1d&exp=1788768847",
      "width": 1024,
      "height": 1024
    }
  ]
}`,
    responseLabel: "响应 200（wait=true 且已完成）",
    responseNote: "wait=false 或等待超时时返回 202，响应体只有 task 字段。",
  },
  {
    id: "edits",
    method: "POST",
    path: "/api/v1/images/edits",
    title: "图生图",
    auth: "bearer",
    summary: "multipart/form-data 上传 1-4 张参考图（PNG / JPG / WEBP，第一张为主图），其余参数与文生图一致，mode 固定为 image_to_image。",
    notes: [
      "表单字段：image（可重复 1-4 次）、prompt、negative_prompt、size、quality、n、wait、response_format。",
      "也可以直接发 JSON，用 image_base64 数组代替文件，元素支持 data URL 或纯 base64。",
      "参考图只用于本次生成，不会写进模板库。",
    ],
    requestExample: `{
  "image_base64": [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
  ],
  "prompt": "把背景换成青瓷色影棚，保留瓶身材质",
  "size": "ecommerce_main_1_1",
  "quality": "high",
  "n": 1,
  "wait": false
}`,
    requestLabel: "请求体（JSON 写法）",
    responseExample: `{
  "task": ${indentBlock(queuedTaskExample, 2)}
}`,
    responseLabel: "响应 202（wait=false）",
    responseNote: "wait=true 且在 240 秒内完成时返回 200，并附带 data 数组。",
  },
  {
    id: "task-detail",
    method: "GET",
    path: "/api/v1/tasks/{id}",
    title: "查询单个任务",
    auth: "bearer",
    summary: "轮询这个接口直到 status 变成 succeeded 或 failed。建议间隔 3 秒。",
    notes: ["只能查到自己账号下 source=api 的任务。", "图片链接过期后重新查询这个接口即可拿到新签名。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "task": ${indentBlock(succeededTaskExample, 2)}
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "task-list",
    method: "GET",
    path: "/api/v1/tasks",
    title: "查询任务列表",
    auth: "bearer",
    summary: "按创建时间倒序返回本账号通过 API 创建的任务，limit 默认 20。",
    notes: ["查询参数：limit，例如 /api/v1/tasks?limit=20。", "网页端创建的任务不在这个列表里，请到历史记录页查看。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "tasks": [
    ${indentBlock(succeededTaskExample, 4)}
  ]
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "task-cancel",
    method: "POST",
    path: "/api/v1/tasks/{id}/cancel",
    title: "停止任务",
    auth: "bearer",
    summary: "停止仍在排队或生成中的任务，已完成的任务不受影响。",
    notes: ["取消后 status 变成 failed，progress_stage 为 canceled。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: `{
  "task": {
    "id": "task_5NpQx7Kd",
    "status": "failed",
    "progress_stage": "canceled",
    "mode": "text_to_image",
    "prompt": "青瓷色背景上的极简香薰瓶，柔和顶光，产品主图",
    "size": "ecommerce_main_1_1",
    "quality": "high",
    "n": 2,
    "created_at": "2026-09-03T02:14:07.000Z",
    "started_at": "2026-09-03T02:14:08.000Z",
    "completed_at": "2026-09-03T02:14:20.000Z",
    "error": {
      "message": "任务已停止"
    },
    "images": []
  }
}`,
    responseLabel: "响应 200",
    responseNote: null,
  },
  {
    id: "image-binary",
    method: "GET",
    path: "/api/v1/images/{id}",
    title: "下载图片原图",
    auth: "bearer",
    summary: "直接返回图片二进制流，带 ETag，命中缓存时返回 304。",
    notes: ["适合服务端拉图；浏览器直接展示时更推荐用任务里带签名的 url。", "加 ?thumb=1 取缩略图。"],
    requestExample: null,
    requestLabel: "请求",
    responseExample: null,
    responseLabel: "响应 200",
    responseNote: "响应体是图片二进制（Content-Type: image/png），不是 JSON。",
  },
];

export interface SizeRow {
  option: ImageSizeOption;
  label: string;
  pixels: string;
}

export const sizeRows: SizeRow[] = sizeOptions.map((option) => ({
  option,
  label: imageSizeLabels[option],
  pixels: apiSizeForOption(option) ?? "由上游决定",
}));

export interface QualityRow {
  option: ImageQualityOption;
  label: string;
}

export const qualityRows: QualityRow[] = imageQualityOptions.map((option) => ({
  option,
  label: imageQualityLabels[option],
}));

export const apiQuantityOptions = [1, 2, 4] as const;

export const paramNotes: string[] = [
  "quality 默认 high；填 auto 表示不指定，交给上游模型决定。",
  "n 只接受 1 / 2 / 4，其它值返回 400 validation_error。",
  "size 传尺寸选项键（不是像素串），传 auto 表示不限制画幅。",
  "文生图 mode 恒为 text_to_image，图生图 mode 恒为 image_to_image。",
];

export interface ErrorCodeRow {
  code: string;
  status: number;
  meaning: string;
}

export const errorCodes: ErrorCodeRow[] = [
  { code: "unauthorized", status: 401, meaning: "缺少 Authorization 头，或密钥无效、已撤销。" },
  { code: "forbidden", status: 403, meaning: "密钥有效但无权访问该资源，例如别人的任务。" },
  { code: "quota_exceeded", status: 403, meaning: "本月生成额度不足，规则与网页端一致。" },
  { code: "validation_error", status: 400, meaning: "参数不合法，message 会指出具体字段。" },
  { code: "not_found", status: 404, meaning: "任务或图片不存在。" },
  { code: "rate_limited", status: 429, meaning: "超过每分钟 60 次调用，响应头 Retry-After 给出等待秒数。" },
  { code: "too_many_active_tasks", status: 429, meaning: "同时进行中的 API 任务超过 5 个，等已有任务完成再提交。" },
  { code: "api_disabled", status: 403, meaning: "管理员已在后台关闭开放 API。" },
  { code: "server_error", status: 500, meaning: "服务端异常，可稍后重试或联系管理员。" },
];

export const errorBodyExample = `{
  "error": {
    "code": "quota_exceeded",
    "message": "本月生成额度已用完"
  }
}`;

export interface LimitRow {
  title: string;
  detail: string;
}

export const limitRows: LimitRow[] = [
  { title: "调用频率", detail: "每把密钥 60 次 / 分钟。超限返回 429 rate_limited，响应头 Retry-After 告诉你还要等几秒。" },
  { title: "并发任务", detail: "每个账号同时最多 5 个 queued 或 processing 的 API 任务，超出返回 429 too_many_active_tasks。" },
  { title: "额度扣减", detail: "与网页端共用同一份月度额度，按张数扣减，创建任务前校验，额度不足返回 403 quota_exceeded。" },
  { title: "图片链接", detail: "任务返回的 url / thumbnail_url 是带签名的绝对地址，7 天内可免鉴权下载；过期后重新查询任务拿新链接。" },
  { title: "任务来源", detail: "API 任务不会创建对话，但生成的图片照常出现在历史记录页。" },
  { title: "总开关", detail: "管理员可以在后台站点设置里关闭开放 API，关闭后所有 /api/v1 请求与密钥创建返回 403 api_disabled。" },
];

export interface CodeSample {
  id: string;
  label: string;
  language: string;
  code: string;
}

export const quickStartSamples: CodeSample[] = [
  {
    id: "quickstart-wait",
    label: "一步拿图（wait=true）",
    language: "bash",
    code: `curl -X POST "${originToken}/api/v1/images/generations" \\
  -H "Authorization: Bearer $HUAJING_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "青瓷色背景上的极简香薰瓶，柔和顶光，产品主图",
    "size": "ecommerce_main_1_1",
    "quality": "high",
    "n": 1,
    "wait": true
  }'`,
  },
  {
    id: "quickstart-async",
    label: "异步：创建后轮询",
    language: "bash",
    code: `# 1. 创建任务，立刻返回 202 和 task.id
curl -X POST "${originToken}/api/v1/images/generations" \\
  -H "Authorization: Bearer $HUAJING_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"青瓷色背景上的极简香薰瓶","n":2}'

# 2. 每 3 秒查一次，status 变成 succeeded 后读取 task.images
curl "${originToken}/api/v1/tasks/task_5NpQx7Kd" \\
  -H "Authorization: Bearer $HUAJING_API_KEY"`,
  },
  {
    id: "quickstart-edits",
    label: "图生图（上传参考图）",
    language: "bash",
    code: `curl -X POST "${originToken}/api/v1/images/edits" \\
  -H "Authorization: Bearer $HUAJING_API_KEY" \\
  -F "image=@main.png" \\
  -F "image=@reference.png" \\
  -F "prompt=把背景换成青瓷色影棚，保留瓶身材质" \\
  -F "size=ecommerce_main_1_1" \\
  -F "wait=true"`,
  },
];

export const languageSamples: CodeSample[] = [
  {
    id: "sample-python",
    label: "Python（requests）",
    language: "python",
    code: `import os
import time

import requests

BASE = "${originToken}"
HEADERS = {"Authorization": f"Bearer {os.environ['HUAJING_API_KEY']}"}


def generate(prompt: str) -> list[str]:
    created = requests.post(
        f"{BASE}/api/v1/images/generations",
        headers=HEADERS,
        json={"prompt": prompt, "size": "ecommerce_main_1_1", "quality": "high", "n": 1, "wait": True},
        timeout=300,
    )
    if not created.ok:
        detail = created.json()["error"]
        raise RuntimeError(f"{detail['code']}: {detail['message']}")

    task = created.json()["task"]
    # wait 超时会返回 202，退回轮询即可
    while task["status"] in ("queued", "processing"):
        time.sleep(3)
        polled = requests.get(f"{BASE}/api/v1/tasks/{task['id']}", headers=HEADERS, timeout=30)
        task = polled.json()["task"]

    if task["status"] != "succeeded":
        raise RuntimeError(task["error"]["message"])
    return [image["url"] for image in task["images"]]


print(generate("青瓷色背景上的极简香薰瓶，柔和顶光，产品主图"))`,
  },
  {
    id: "sample-node",
    label: "Node（fetch）",
    language: "javascript",
    code: `const BASE = "${originToken}";
const HEADERS = { Authorization: \`Bearer \${process.env.HUAJING_API_KEY}\` };

async function generate(prompt) {
  const created = await fetch(\`\${BASE}/api/v1/images/generations\`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size: "ecommerce_main_1_1", quality: "high", n: 1, wait: true }),
  });

  const payload = await created.json();
  if (!created.ok) {
    throw new Error(\`\${payload.error.code}: \${payload.error.message}\`);
  }

  // wait 超时会返回 202，退回轮询即可
  let task = payload.task;
  while (task.status === "queued" || task.status === "processing") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await fetch(\`\${BASE}/api/v1/tasks/\${task.id}\`, { headers: HEADERS });
    task = (await polled.json()).task;
  }

  if (task.status !== "succeeded") {
    throw new Error(task.error.message);
  }
  return task.images.map((image) => image.url);
}

generate("青瓷色背景上的极简香薰瓶，柔和顶光，产品主图").then(console.log);`,
  },
];
