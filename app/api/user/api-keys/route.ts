import { NextRequest, NextResponse } from "next/server";
import { generateApiKeySecret } from "@/lib/api-keys";
import { withApiHandler } from "@/lib/api-v1";
import { assertApiEnabled, requireUser } from "@/lib/auth";
import { createUserApiKey, listUserApiKeys, toPublicUserApiKey } from "@/lib/db";
import { createApiKeySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 开发者页用的自助密钥列表：session cookie 鉴权，明文永不回显。 */
export const GET = withApiHandler(async (request: NextRequest) => {
  const user = requireUser(request);
  return NextResponse.json({ keys: listUserApiKeys(user.id).map(toPublicUserApiKey) });
});

export const POST = withApiHandler(async (request: NextRequest) => {
  const user = requireUser(request);
  assertApiEnabled();
  const input = createApiKeySchema.parse(await request.json());

  // 明文只在这里出现一次：库里只留 sha256，之后任何接口都拿不回来。
  const secret = generateApiKeySecret();
  const key = createUserApiKey({ userId: user.id, name: input.name, secret });

  return NextResponse.json(
    {
      key: { id: key.id, name: key.name, prefix: key.key_prefix, createdAt: key.created_at },
      secret,
    },
    { status: 201 },
  );
});
