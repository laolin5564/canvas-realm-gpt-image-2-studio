import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { defaultUpdateCheckUrl, defaultUpdateRepo } from "./version";

loadLocalEnvFiles();

function loadLocalEnvFiles(): void {
  for (const filename of [".env.local", ".env"]) {
    const envPath = path.resolve(process.cwd(), filename);
    if (!existsSync(envPath)) {
      continue;
    }

    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (!match) {
        continue;
      }
      const key = match[1];
      if (process.env[key] !== undefined) {
        continue;
      }
      process.env[key] = parseEnvValue(match[2] ?? "");
    }
  }
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const commentIndex = trimmed.search(/\s#/);
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

function resolvePathFromEnv(value: string | undefined, fallback: string): string {
  if (!value || value.trim() === "") {
    return path.resolve(process.cwd(), fallback);
  }

  if (value.startsWith("file:")) {
    const rawPath = value.slice("file:".length);
    return path.resolve(process.cwd(), rawPath);
  }

  return path.resolve(process.cwd(), value);
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

export const appConfig = {
  databasePath: resolvePathFromEnv(process.env.DATABASE_URL, "data/app.db"),
  imageStorageDir: resolvePathFromEnv(process.env.IMAGE_STORAGE_DIR, "data/images"),
  sub2apiBaseUrl: process.env.SUB2API_BASE_URL || "https://s2a.laolin.ai/v1",
  sub2apiApiKey: process.env.SUB2API_API_KEY || "",
  imageModel: process.env.IMAGE_MODEL || "gpt-image-2",
  promptOptimizerModel: process.env.PROMPT_OPTIMIZER_MODEL || "gpt-5.5",
  imageRequestTimeoutMs: readNumberEnv("IMAGE_REQUEST_TIMEOUT_MS", 300_000),
  workerPollIntervalMs: readNumberEnv("WORKER_POLL_INTERVAL_MS", 3_000),
  costPerImage: readNumberEnv("COST_PER_IMAGE", 0.04),
  openaiOAuthApiBaseUrl: process.env.OPENAI_OAUTH_API_BASE_URL || "https://api.openai.com/v1",
  openaiOAuthClientId: process.env.OPENAI_OAUTH_CLIENT_ID || "",
  openaiOAuthRedirectUri: process.env.OPENAI_OAUTH_REDIRECT_URI || "",
  openaiOAuthTokenEncryptionKey: process.env.OPENAI_OAUTH_TOKEN_ENCRYPTION_KEY || "",
  laolinyunUserApiUrl: process.env.LAOLINYUN_USER_API_URL || "https://www.laolinyun.cn/api/user.php",
  laolinyunAppstoreApiUrl: process.env.LAOLINYUN_APPSTORE_API_URL || "https://www.laolinyun.cn/api/appstore.php",
  updateCheckUrl: process.env.UPDATE_CHECK_URL || defaultUpdateCheckUrl,
  updateRepo: process.env.UPDATE_REPO || defaultUpdateRepo,
  webUpdateEnabled: readBooleanEnv("WEB_UPDATE_ENABLED"),
};

export const IMAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const PUBLIC_FILE_PREFIX = "/api/files";
