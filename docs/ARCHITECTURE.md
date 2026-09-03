# Canvas Realm Studio / 画境工坊架构说明

本文面向二开者和维护者，说明主要模块边界、数据升级约定和发布维护流程。

## 模块边界

| 模块 | 入口文件 | 职责 | 不应该做什么 |
| --- | --- | --- | --- |
| 配置 | `lib/config.ts` | 读取环境变量、提供运行期默认值、路径解析 | 不访问数据库、不发起网络请求 |
| 数据库 | `lib/db.ts` | SQLite schema 初始化、兼容性 `ALTER TABLE`、CRUD 与行到公开 DTO 的转换 | 不调用图片 provider、不读 HTTP request |
| 认证与权限 | `lib/auth.ts`, `lib/permissions.ts` | session cookie、用户身份、管理员校验、资源归属校验 | 不保存业务配置、不直接拼接响应 UI |
| 图片 Provider | `lib/image-provider.ts`, `lib/sub2api.ts`, `lib/openai-oauth.ts` | 选择图片接口、调用 OpenAI-compatible API、OAuth token 加解密/刷新 | 不直接写任务状态、不绕过队列 |
| 队列与 Worker | `lib/queue.ts`, `workers/image-worker.ts` | 领取任务、调用 provider、落库结果、失败回写 | 不处理登录态、不暴露管理接口 |
| 文件存储 | `lib/storage.ts`, `app/api/files/[...path]/route.ts` | 上传/生成图片的本地存储和受控读取 | 不接受任意绝对路径、不暴露 `data/app.db` |
| 参考图归一化 | `lib/source-image-normalize.ts` | 参考图落盘前 EXIF 转正、最长边 ≤ 2048、体积压到约 3MB（webp），并给出真实宽高 | 不做业务校验（类型/上限由 `storage.ts` 与路由负责）、不拒绝超出软目标的图 |
| 系统更新 | `lib/update.ts`, `lib/system-update-runner.ts`, `scripts/update.sh`, `scripts/web-update.sh` | 检查 GitHub Release、执行受限更新脚本、备份数据 | 不接受用户传入 shell 命令 |

## 请求/任务数据流

1. 用户通过 Next.js API 创建生成任务。
2. API 层用 `requireUser`/`requireAdmin` 与 `permissions` 校验权限。
3. `lib/db.ts` 写入 `generation_tasks`，状态为 `queued`。
4. Worker 轮询 `claimNextQueuedTask()`，把任务置为 `processing`。
5. `lib/image-provider.ts` 按后台设置选择 `sub2api` 或 `openai_oauth`。
6. provider 返回图片后，`lib/storage.ts` 写入 `IMAGE_STORAGE_DIR`，`lib/db.ts` 写入 `generated_images` 与会话消息。
7. 前端通过任务/会话接口读取结果，图片文件经 `/api/files/...` 受控输出。

## 数据升级约定

- `getDb()` 每次打开数据库都会调用 `initializeSchema()`；新增表使用 `CREATE TABLE IF NOT EXISTS`。
- 给已有表新增可空列或带安全默认值的列时，使用 `ensureColumn()` 做兼容迁移。
- 不要在自动迁移里删除列、重命名表、清空数据或重建数据库。
- 破坏性变更必须：
  1. 先在 Release Notes 标注；
  2. 提供手动备份/迁移步骤；
  3. 保证 `scripts/update.sh` 已备份 `data/` 和 `.env*`。
- 本项目当前没有独立 migration runner；复杂迁移应先引入版本化 migrations，再发布。

## OpenAI OAuth 维护边界

内置 OpenAI OAuth 是实验性连接器：它参考 Codex CLI OAuth + PKCE 流程，但不是 OpenAI 官方稳定图片 API 接入方式。维护时请保证：

- 默认仍保留 `sub2api / OpenAI-compatible API Key` 稳定模式。
- OAuth 失败时错误要可见、可回退，不应阻断 API Key 模式。
- token 只能通过 `OPENAI_OAUTH_TOKEN_ENCRYPTION_KEY` 加密存储，日志和错误信息必须脱敏。
- 如果 OpenAI OAuth 流程或 token 权限变化，应优先更新文档中的实验性声明。

## 发布流程

1. 确认 `package.json` 的 `version` 是要发布的版本。
2. 运行：

   ```bash
   bun run secret:scan
   bun run lint
   bun run build
   ```

3. 合并到 `main`。
4. 打 tag 并推送：

   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. 在 GitHub Releases 基于该 tag 创建 Release，写清楚：新增功能、修复、升级风险、是否需要手动迁移。
6. 已安装实例通过后台「检查更新」或 `bash scripts/update.sh` 更新。
