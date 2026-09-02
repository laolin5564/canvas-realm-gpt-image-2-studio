"use client";

import { useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { ImageProvider, PublicAdminSettings, PublicImageProviderChannel } from "@/lib/types";
import { imageConcurrencyLimits } from "@/lib/types";
import { apiJson } from "@/components/client-api";
import { AdminShell } from "./AdminShell";

type EditableChannel = PublicImageProviderChannel & { apiKey: string };

interface SettingsResponse {
  settings: PublicAdminSettings;
}

export function AdminModelsClient() {
  const [settings, setSettings] = useState<PublicAdminSettings | null>(null);
  const [imageProvider, setImageProvider] = useState<ImageProvider>("sub2api");
  const [channels, setChannels] = useState<EditableChannel[]>([]);
  const [imageConcurrency, setImageConcurrency] = useState(2);
  const [promptOptimizerModel, setPromptOptimizerModel] = useState("gpt-5.5");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSettings(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson<SettingsResponse>("/api/admin/settings");
      setSettings(payload.settings);
      setImageProvider(payload.settings.imageProvider);
      setImageConcurrency(payload.settings.imageConcurrency);
      setPromptOptimizerModel(payload.settings.promptOptimizerModel);
      setChannels(
        payload.settings.imageProviderChannels.length > 0
          ? payload.settings.imageProviderChannels.map((channel) => ({ ...channel, apiKey: "" }))
          : [{
              id: "legacy_sub2api",
              name: "默认 API Key 渠道",
              enabled: true,
              priority: 1,
              baseUrl: payload.settings.sub2apiBaseUrl,
              model: payload.settings.imageModel,
              apiKeyConfigured: payload.settings.sub2apiApiKeyConfigured,
              apiKey: "",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  function updateChannel(id: string, patch: Partial<EditableChannel>): void {
    setChannels((current) => current.map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)));
  }

  function addChannel(): void {
    setChannels((current) => [
      ...current,
      {
        id: `channel_${Date.now()}`,
        name: `备用渠道 ${current.length + 1}`,
        enabled: true,
        priority: current.length + 1,
        baseUrl: current[0]?.baseUrl || "https://api.example.com/v1",
        model: current[0]?.model || "gpt-image-2",
        apiKeyConfigured: false,
        apiKey: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  }

  function removeChannel(id: string): void {
    setChannels((current) => (current.length <= 1 ? current : current.filter((channel) => channel.id !== id)));
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await apiJson<SettingsResponse>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          imageProvider,
          imageConcurrency,
          promptOptimizerModel,
          imageProviderChannels:
            imageProvider === "openai_oauth"
              ? undefined
              : channels.map((channel) => ({
                  id: channel.id,
                  name: channel.name,
                  enabled: channel.enabled,
                  priority: channel.priority,
                  baseUrl: channel.baseUrl,
                  model: channel.model,
                  apiKey: channel.apiKey.trim() ? channel.apiKey.trim() : null,
                })),
        }),
      });
      setMessage("模型与接口配置已保存。");
      await loadSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      active="models"
      title="模型与接口"
      description="集中管理图片模型渠道、OAuth 模式、并发请求数和提示词优化模型。"
      actions={
        <>
          <button className="button" type="button" onClick={loadSettings} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </button>
          <button className="button primary" type="button" onClick={saveSettings} disabled={saving}>
            <Save size={16} aria-hidden="true" />
            保存配置
          </button>
        </>
      }
    >
      {error ? <div className="toast-line error">{error}</div> : null}
      {message ? <div className="toast-line">{message}</div> : null}

      <section className="panel admin-ops-panel">
        <div className="panel-body form-stack">
          <div className="field-row">
            <div className="field">
              <label>图片接口模式</label>
              <select className="select" value={imageProvider} onChange={(event) => setImageProvider(event.target.value as ImageProvider)}>
                <option value="sub2api">OpenAI-compatible API Key</option>
                <option value="openai_oauth">内置 OpenAI OAuth（实验性）</option>
              </select>
            </div>
            <div className="field">
              <label>同时处理的任务数</label>
              <input className="input" type="number" min={imageConcurrencyLimits.min} max={imageConcurrencyLimits.max} value={imageConcurrency} onChange={(event) => setImageConcurrency(Number(event.target.value))} />
              <span className="field-hint">
                worker 同时开工的任务上限。单个任务内部还会按张数拆成多个上游请求，真正打到上游的总并发另由
                IMAGE_UPSTREAM_MAX_INFLIGHT 封顶：当前
                <strong style={{ fontVariantNumeric: "tabular-nums" }}> {settings?.upstreamImageMaxInflight ?? "—"} </strong>
                （只读，改环境变量后重启生效）。
              </span>
            </div>
            <div className="field">
              <label>提示词优化模型</label>
              <input className="input" value={promptOptimizerModel} onChange={(event) => setPromptOptimizerModel(event.target.value)} placeholder="gpt-5.5" />
            </div>
          </div>

          {imageProvider === "openai_oauth" ? (
            <div className="admin-model-note">
              <KeyRound size={18} aria-hidden="true" />
              <span>当前使用内置 OAuth 模式。Base URL、模型和 API Key 会由已连接的 OpenAI 账号接管。</span>
            </div>
          ) : (
            <div className="provider-channel-section">
              <div className="section-title-row">
                <strong>模型渠道池</strong>
                <button className="button subtle" type="button" onClick={addChannel}>
                  <Plus size={16} aria-hidden="true" />
                  增加渠道
                </button>
              </div>
              <div className="provider-channel-list">
                {channels.map((channel) => (
                  <article className={clsx("provider-channel-card", !channel.enabled && "disabled")} key={channel.id}>
                    <div className="provider-channel-head">
                      <label className="switch-row">
                        <input type="checkbox" checked={channel.enabled} onChange={(event) => updateChannel(channel.id, { enabled: event.target.checked })} />
                        <span>
                          <strong>{channel.name}</strong>
                          <small>优先级 {channel.priority}</small>
                        </span>
                      </label>
                      <span className={clsx("badge", channel.apiKeyConfigured || channel.apiKey ? "success" : "danger")}>
                        {channel.apiKeyConfigured || channel.apiKey ? "Key 已配置" : "缺少 Key"}
                      </span>
                    </div>
                    <div className="provider-channel-fields">
                      <label>
                        渠道名称
                        <input value={channel.name} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} />
                      </label>
                      <label>
                        优先级
                        <input type="number" min={1} value={channel.priority} onChange={(event) => updateChannel(channel.id, { priority: Number(event.target.value) })} />
                      </label>
                      <label>
                        Base URL
                        <input value={channel.baseUrl} onChange={(event) => updateChannel(channel.id, { baseUrl: event.target.value })} />
                      </label>
                      <label>
                        模型
                        <input value={channel.model} onChange={(event) => updateChannel(channel.id, { model: event.target.value })} />
                      </label>
                      <label>
                        API Key
                        <input type="password" value={channel.apiKey} onChange={(event) => updateChannel(channel.id, { apiKey: event.target.value })} placeholder={channel.apiKeyConfigured ? "留空表示不修改" : "填写后保存"} />
                      </label>
                    </div>
                    <button className="button danger" type="button" onClick={() => removeChannel(channel.id)} disabled={channels.length <= 1}>
                      <Trash2 size={16} aria-hidden="true" />
                      移除
                    </button>
                  </article>
                ))}
              </div>
            </div>
          )}
          {settings?.openaiOAuthProxyConfigured ? <div className="toast-line">OAuth 代理已配置：{settings.openaiOAuthProxyDisplay}</div> : null}
        </div>
      </section>
    </AdminShell>
  );
}
