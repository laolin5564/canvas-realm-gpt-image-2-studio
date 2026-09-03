import { NextRequest } from "next/server";
import { apiError, readJsonBody, withApiHandler } from "@/lib/api-v1";
import {
  assertApiActiveTaskLimit,
  assertApiQuota,
  authenticateApiRequest,
  finalizeApiGeneration,
} from "@/lib/api-v1-server";
import { createGenerationTask, getTemplate } from "@/lib/db";
import { assertTemplateReadAccess } from "@/lib/permissions";
import { apiV1GenerationSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// wait=true 最长阻塞 240 秒，给路由留出比它更长的执行预算。
export const maxDuration = 300;

export const POST = withApiHandler(async (request: NextRequest) => {
  const { user } = authenticateApiRequest(request);
  const body = apiV1GenerationSchema.parse(await readJsonBody(request));

  if (body.template_id) {
    const template = getTemplate(body.template_id);
    if (!template) {
      throw apiError("not_found", "模板不存在");
    }
    assertTemplateReadAccess(user, template);
  }

  assertApiActiveTaskLimit(user.id);
  assertApiQuota(user, body.n);

  const task = createGenerationTask({
    userId: user.id,
    mode: "text_to_image",
    prompt: body.prompt,
    negativePrompt: body.negative_prompt,
    size: body.size,
    quality: body.quality,
    quantity: body.n,
    templateId: body.template_id,
    sourceImageId: null,
    referenceStrength: 0.6,
    styleStrength: 0.7,
    source: "api",
  });

  return finalizeApiGeneration({
    request,
    task,
    wait: body.wait,
    responseFormat: body.response_format,
  });
});
