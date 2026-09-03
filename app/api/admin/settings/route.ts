import { NextRequest, NextResponse } from "next/server";
import { getPublicAdminSettings, getUserGroup, saveImageProviderChannels, setAppSetting } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { normalizeProxyUrl } from "@/lib/proxy";
import { updateAdminSettingsSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    return NextResponse.json({ settings: getPublicAdminSettings() });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(request);
    const input = updateAdminSettingsSchema.parse(await request.json());

    if (input.imageProvider) {
      setAppSetting("image_provider", input.imageProvider);
    }
    if (input.sub2apiApiKey) {
      setAppSetting("sub2api_api_key", input.sub2apiApiKey);
    }
    if (input.sub2apiBaseUrl) {
      setAppSetting("sub2api_base_url", input.sub2apiBaseUrl.replace(/\/+$/, ""));
    }
    if (input.imageProviderChannels) {
      try {
        saveImageProviderChannels(input.imageProviderChannels);
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "模型渠道配置不正确", 400);
      }
    }
    if (Object.prototype.hasOwnProperty.call(input, "openaiOAuthProxyUrl")) {
      try {
        const proxyUrl = input.openaiOAuthProxyUrl === null ? "" : normalizeProxyUrl(input.openaiOAuthProxyUrl);
        setAppSetting("openai_oauth_proxy_url", proxyUrl);
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "代理地址不正确", 400);
      }
    }
    if (input.imageModel) {
      setAppSetting("image_model", input.imageModel);
    }
    if (input.promptOptimizerModel) {
      setAppSetting("prompt_optimizer_model", input.promptOptimizerModel);
    }
    if (input.imageConcurrency !== undefined) {
      setAppSetting("image_concurrency", String(input.imageConcurrency));
    }
    if (input.imageRetentionDays !== undefined) {
      setAppSetting("image_retention_days", String(input.imageRetentionDays));
    }
    if (input.siteTitle) {
      setAppSetting("site_title", input.siteTitle);
    }
    if (input.siteSubtitle) {
      setAppSetting("site_subtitle", input.siteSubtitle);
    }
    if (input.registrationEnabled !== undefined) {
      setAppSetting("registration_enabled", String(input.registrationEnabled));
    }
    if (input.apiEnabled !== undefined) {
      setAppSetting("api_enabled", String(input.apiEnabled));
    }
    if (input.registrationDefaultGroupId) {
      if (!getUserGroup(input.registrationDefaultGroupId)) {
        return jsonError("注册默认分组不存在", 400);
      }
      setAppSetting("registration_default_group_id", input.registrationDefaultGroupId);
    }

    return NextResponse.json({ settings: getPublicAdminSettings() });
  } catch (error) {
    return handleRouteError(error);
  }
}
