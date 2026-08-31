import { NextRequest, NextResponse } from "next/server";
import {
  createGenerationTask,
  getConversation,
  getGeneratedImage,
  getImageFilePathById,
  getLatestConversationImage,
  getTaskImages,
  toPublicTask,
} from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { normalizeConversationFixedPrompt } from "@/lib/conversation-prompt";
import { handleRouteError, jsonError } from "@/lib/http";
import {
  assertConversationAccess,
  assertGeneratedImageAccess,
  assertImageReferenceAccess,
  assertQuotaAvailable,
} from "@/lib/permissions";
import { continueConversationSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = requireUser(request);
    const { id } = await context.params;
    const conversation = getConversation(id);
    if (!conversation) {
      return jsonError("会话不存在", 404);
    }
    assertConversationAccess(user, conversation);

    const input = continueConversationSchema.parse(await request.json());
    const fixedPrompt = conversation.fixed_prompt_enabled === 1
      ? normalizeConversationFixedPrompt(conversation.fixed_prompt)
      : null;
    if (!input.prompt && !fixedPrompt) {
      return jsonError("请输入本次描述，或先开启会话固定提示词", 400);
    }

    const latestImage = getLatestConversationImage(id);
    const sourceImageId = input.sourceImageId ?? latestImage?.id ?? null;

    if (!sourceImageId || !getImageFilePathById(sourceImageId)) {
      return jsonError("当前会话还没有可继续图生图的图片", 400);
    }
    const generatedSourceImage = getGeneratedImage(sourceImageId);
    if (generatedSourceImage) {
      assertGeneratedImageAccess(user, generatedSourceImage);
    } else {
      assertImageReferenceAccess(user, sourceImageId);
    }
    const allRefIds: string[] = [];
    if (input.referenceImageId) {
      allRefIds.push(input.referenceImageId);
    }
    if (input.referenceImageIds) {
      allRefIds.push(...input.referenceImageIds);
    }
    const uniqueReferenceIds = Array.from(new Set(allRefIds.filter((refId) => refId !== sourceImageId)));
    for (const refId of uniqueReferenceIds) {
      assertImageReferenceAccess(user, refId);
      if (!getImageFilePathById(refId)) {
        return jsonError("参考图不存在或已无法访问", 400);
      }
    }
    assertQuotaAvailable(user, input.quantity);

    const task = createGenerationTask({
      userId: user.id,
      conversationId: id,
      mode: "image_to_image",
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      size: input.size,
      quality: input.quality,
      quantity: input.quantity,
      templateId: generatedSourceImage?.template_id ?? latestImage?.template_id ?? null,
      sourceImageId,
      referenceImageId: uniqueReferenceIds[0] ?? null,
      referenceImageIds: uniqueReferenceIds,
      referenceStrength: input.referenceStrength,
      styleStrength: input.styleStrength,
      applyFixedPrompt: true,
    });

    return NextResponse.json(
      {
        taskId: task.id,
        conversationId: id,
        status: task.status,
        task: toPublicTask(task, getTaskImages(task.id)),
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
