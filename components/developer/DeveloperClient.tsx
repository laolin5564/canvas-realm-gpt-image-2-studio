"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { copyTextToClipboard, formatDateTime } from "@/components/client-api";
import { ApiDocs } from "./ApiDocs";
import { formatKeyPrefix, originPlaceholder } from "./api-docs-content";
import {
  apiKeyNameMaxLength,
  apiKeyStatusLabels,
  countActiveKeys,
  maxActiveApiKeys,
  requestDeveloperJson,
  validateKeyName,
} from "./developer-api";
import type {
  CreateApiKeyResponse,
  DeveloperApiKey,
  DeveloperApiKeyListResponse,
  RevokeApiKeyResponse,
} from "./developer-api";

/** 只关心开放 API 开关，其余站点设置字段这里用不到；后端未下发时按未知处理。 */
interface DeveloperSiteSettings {
  apiEnabled?: boolean;
}

interface SiteSettingsResponse {
  settings: DeveloperSiteSettings;
}

interface RevealedSecret {
  name: string;
  secret: string;
}

export function DeveloperClient() {
  const [keys, setKeys] = useState<DeveloperApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [apiEnabled, setApiEnabled] = useState<boolean | null>(null);
  const [origin, setOrigin] = useState(originPlaceholder);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const notice = useCallback((text: string, tone: "info" | "error" = "info") => {
    if (tone === "error") {
      setMessage("");
      setError(text);
      return;
    }
    setError("");
    setMessage(text);
  }, []);

  const loadKeys = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const payload = await requestDeveloperJson<DeveloperApiKeyListResponse>("/api/user/api-keys");
      setKeys(payload.keys);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密钥列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    requestDeveloperJson<SiteSettingsResponse>("/api/site-settings")
      .then((payload) => {
        const value = payload.settings?.apiEnabled;
        setApiEnabled(typeof value === "boolean" ? value : null);
      })
      .catch(() => setApiEnabled(null));
  }, []);

  const activeCount = countActiveKeys(keys);
  const reachedLimit = activeCount >= maxActiveApiKeys;
  const apiDisabled = apiEnabled === false;

  async function createKey(): Promise<void> {
    const invalid = validateKeyName(keyName);
    if (invalid) {
      notice(invalid, "error");
      return;
    }

    setCreating(true);
    setMessage("");
    setError("");
    try {
      const payload = await requestDeveloperJson<CreateApiKeyResponse>("/api/user/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: keyName.trim() }),
      });
      setKeyName("");
      setSecretCopied(false);
      setRevealed({ name: payload.key.name, secret: payload.secret });
      await loadKeys();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密钥创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id: string): Promise<void> {
    setBusyId(id);
    setMessage("");
    setError("");
    try {
      await requestDeveloperJson<RevokeApiKeyResponse>(`/api/user/api-keys/${id}`, { method: "DELETE" });
      setPendingRevokeId("");
      setMessage("密钥已撤销，使用它的程序会立刻收到 401。");
      await loadKeys();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密钥撤销失败");
    } finally {
      setBusyId("");
    }
  }

  async function copySecret(): Promise<void> {
    if (!revealed) {
      return;
    }
    try {
      await copyTextToClipboard(revealed.secret);
      setSecretCopied(true);
    } catch (caught) {
      notice(caught instanceof Error ? caught.message : "复制失败，请手动选中复制。", "error");
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <h1>开发者 API</h1>
          <p>用自己的密钥直接调用图片生成：创建密钥、按文档发请求，生成的图片照常进入你的历史记录。</p>
        </div>
        <div className="developer-heading-actions">
          <button className="button" type="button" onClick={() => void loadKeys()} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新密钥
          </button>
        </div>
      </section>

      {apiDisabled ? (
        <div className="developer-alert" role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <span>
            <strong>管理员已关闭开放 API</strong>
            <small>现有密钥暂时不可用，所有 /api/v1 请求会返回 403 api_disabled。文档仍可查阅。</small>
          </span>
        </div>
      ) : null}

      {error ? <div className="toast-line error">{error}</div> : null}
      {message && !error ? <div className="toast-line">{message}</div> : null}

      <section className="panel developer-keys-panel">
        <div className="panel-header">
          <div>
            <h2>我的 API 密钥</h2>
            <p>
              最多同时持有 {maxActiveApiKeys} 把有效密钥，当前 {activeCount} 把。完整密钥只在创建时显示一次。
            </p>
          </div>
          <span className={clsx("badge", reachedLimit ? "warning" : "neutral")}>
            {activeCount}/{maxActiveApiKeys}
          </span>
        </div>
        <div className="panel-body developer-stack">
          <div className="developer-create-row">
            <div className="field">
              <label htmlFor="developer-key-name">密钥名称</label>
              <input
                id="developer-key-name"
                className="input"
                value={keyName}
                maxLength={apiKeyNameMaxLength}
                placeholder="例如：生产环境、批量出图脚本"
                onChange={(event) => setKeyName(event.target.value)}
              />
            </div>
            <button
              className="button primary developer-create-button"
              type="button"
              onClick={() => void createKey()}
              disabled={creating || reachedLimit || apiDisabled}
            >
              <Plus size={16} aria-hidden="true" />
              新建密钥
            </button>
          </div>
          {reachedLimit ? (
            <p className="developer-hint">已达到 {maxActiveApiKeys} 把有效密钥上限，先撤销一把再新建。</p>
          ) : null}
          {apiDisabled && !reachedLimit ? <p className="developer-hint">开放 API 已关闭，暂时无法新建密钥。</p> : null}

          <div className="admin-table-wrap">
            <table className="admin-data-table developer-keys-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>前缀</th>
                  <th>状态</th>
                  <th>最近使用</th>
                  <th>请求次数</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={clsx(key.status === "revoked" && "is-muted")}>
                    <td>
                      <div className="table-stack">
                        <strong>{key.name}</strong>
                        <small>{key.id}</small>
                      </div>
                    </td>
                    <td>
                      <code className="developer-inline-code">{formatKeyPrefix(key.prefix)}</code>
                    </td>
                    <td>
                      <span className={clsx("badge", key.status === "active" ? "success" : "neutral")}>
                        {apiKeyStatusLabels[key.status]}
                      </span>
                    </td>
                    <td>{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "未使用"}</td>
                    <td>{key.requestCount}</td>
                    <td>{formatDateTime(key.createdAt)}</td>
                    <td>
                      {key.status === "active" ? (
                        pendingRevokeId === key.id ? (
                          <div className="table-actions">
                            <button
                              className="button danger"
                              type="button"
                              onClick={() => void revokeKey(key.id)}
                              disabled={busyId === key.id}
                            >
                              确认撤销
                            </button>
                            <button className="button ghost" type="button" onClick={() => setPendingRevokeId("")}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button className="button subtle" type="button" onClick={() => setPendingRevokeId(key.id)}>
                            <Trash2 size={14} aria-hidden="true" />
                            撤销
                          </button>
                        )
                      ) : (
                        <span className="developer-hint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!keys.length ? (
                  <tr>
                    <td colSpan={7}>
                      <span className="developer-empty">
                        {loading ? "正在加载密钥…" : "还没有密钥，先在上方新建一把。"}
                      </span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <ApiDocs origin={origin} onNotice={notice} />

      {revealed ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="新密钥">
          <div className="admin-modal developer-secret-modal">
            <div className="panel-header">
              <div>
                <h2>
                  <KeyRound size={16} aria-hidden="true" /> 密钥「{revealed.name}」已创建
                </h2>
                <p>请立刻复制保存，关闭后无法再次查看。</p>
              </div>
              <button
                className="button ghost"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setRevealed(null);
                  setSecretCopied(false);
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="panel-body developer-stack">
              <p className="developer-secret-warning">
                <strong>只显示这一次</strong>
                <small>服务端只保存哈希，密钥丢失后只能撤销重建。</small>
              </p>
              <code className="developer-secret-value">{revealed.secret}</code>
              <div className="button-row">
                <button className="button primary" type="button" onClick={() => void copySecret()}>
                  {secretCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  {secretCopied ? "已复制" : "复制密钥"}
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setRevealed(null);
                    setSecretCopied(false);
                    setMessage("密钥已创建，记得妥善保存。");
                  }}
                >
                  我已保存
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
