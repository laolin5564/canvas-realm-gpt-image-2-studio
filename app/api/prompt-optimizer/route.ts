import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { optimizePromptWithModel } from "@/lib/prompt-optimizer";
import { optimizePromptSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireUser(request);
    const input = optimizePromptSchema.parse(await request.json());
    const prompt = await optimizePromptWithModel({
      prompt: input.prompt,
      mode: input.mode,
      sizeLabel: input.sizeLabel,
      negativePrompt: input.negativePrompt,
      templateName: input.templateName,
      templateDescription: input.templateDescription,
      variables: input.variables,
    });
    return NextResponse.json({ prompt });
  } catch (error) {
    return handleRouteError(error);
  }
}
