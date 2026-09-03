"use client";

import { useEffect, useMemo, useState } from "react";
import { History, Plus, RefreshCw, Save, Ticket, X } from "lucide-react";
import clsx from "clsx";
import { apiJson, formatDateTime } from "@/components/client-api";
import {
  discountPeriodLabel,
  discountRuleSummary,
  discountTypeLabels,
  discountUsageLabel,
  discountValueFieldMeta,
  formatFenAsYuan,
  fromDateTimeLocalValue,
  normalizeDiscountCode,
  toDateTimeLocalValue,
  validateDiscountForm,
} from "@/components/workbench/discount-ui";
import type { DiscountStatus, DiscountType } from "@/components/workbench/types";
import { AdminShell } from "./AdminShell";

/** 与 GET /api/admin/discount-codes 契约一致的本地类型（后端合入前先在前端声明）。 */
interface PublicDiscountCode {
  id: string;
  code: string;
  name: string | null;
  type: DiscountType;
  value: number;
  minUnits: number;
  maxUses: number | null;
  perUserLimit: number;
  startsAt: string | null;
  expiresAt: string | null;
  status: DiscountStatus;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DiscountRedemption {
  id: string;
  userId: string;
  userName: string;
  orderId: string;
  unitsOriginal: number;
  unitsCharged: number;
  creditCount: number;
  discountFen: number;
  createdAt: string;
}

interface DiscountCodesResponse {
  codes: PublicDiscountCode[];
}

interface DiscountCodeResponse {
  code: PublicDiscountCode;
}

interface RedemptionsResponse {
  redemptions: DiscountRedemption[];
}

/** 表单里的可编辑草稿：maxUses 用字符串承载「留空 = 不限」，时间用 datetime-local 值。 */
interface DiscountDraft {
  code: string;
  name: string;
  type: DiscountType;
  value: number;
  minUnits: number;
  maxUses: string;
  perUserLimit: number;
  startsAt: string;
  expiresAt: string;
  status: DiscountStatus;
}

const discountTypeOptions: DiscountType[] = ["percent", "amount", "bonus"];

function emptyDraft(): DiscountDraft {
  return {
    code: "",
    name: "",
    type: "percent",
    value: 80,
    minUnits: 1,
    maxUses: "",
    perUserLimit: 1,
    startsAt: "",
    expiresAt: "",
    status: "active",
  };
}

function draftFromCode(entry: PublicDiscountCode): DiscountDraft {
  return {
    code: entry.code,
    name: entry.name ?? "",
    type: entry.type,
    value: entry.value,
    minUnits: entry.minUnits,
    maxUses: entry.maxUses === null ? "" : String(entry.maxUses),
    perUserLimit: entry.perUserLimit,
    startsAt: toDateTimeLocalValue(entry.startsAt),
    expiresAt: toDateTimeLocalValue(entry.expiresAt),
    status: entry.status,
  };
}

function parseMaxUses(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

function draftToBody(draft: DiscountDraft): Record<string, unknown> {
  const code = normalizeDiscountCode(draft.code);
  return {
    ...(code ? { code } : {}),
    name: draft.name.trim(),
    type: draft.type,
    value: draft.value,
    minUnits: draft.minUnits,
    maxUses: parseMaxUses(draft.maxUses),
    perUserLimit: draft.perUserLimit,
    startsAt: fromDateTimeLocalValue(draft.startsAt),
    expiresAt: fromDateTimeLocalValue(draft.expiresAt),
    status: draft.status,
  };
}

function validateDraft(draft: DiscountDraft): string | null {
  return validateDiscountForm({
    code: draft.code,
    type: draft.type,
    value: draft.value,
    minUnits: draft.minUnits,
    maxUses: parseMaxUses(draft.maxUses),
    perUserLimit: draft.perUserLimit,
    startsAt: fromDateTimeLocalValue(draft.startsAt),
    expiresAt: fromDateTimeLocalValue(draft.expiresAt),
  });
}

export function AdminDiscountsClient() {
  const [codes, setCodes] = useState<PublicDiscountCode[]>([]);
  const [draft, setDraft] = useState<DiscountDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DiscountDraft>(emptyDraft);
  const [redemptionsId, setRedemptionsId] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<DiscountRedemption[]>([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const totals = useMemo(
    () =>
      codes.reduce(
        (acc, entry) => ({
          codes: acc.codes + 1,
          active: acc.active + (entry.status === "active" ? 1 : 0),
          disabled: acc.disabled + (entry.status === "disabled" ? 1 : 0),
          used: acc.used + entry.usedCount,
        }),
        { codes: 0, active: 0, disabled: 0, used: 0 },
      ),
    [codes],
  );

  async function loadCodes(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson<DiscountCodesResponse>("/api/admin/discount-codes");
      setCodes(payload.codes);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "折扣码加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCodes();
  }, []);

  async function createCode(): Promise<void> {
    const invalid = validateDraft(draft);
    if (invalid) {
      setMessage("");
      setError(invalid);
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const payload = await apiJson<DiscountCodeResponse>("/api/admin/discount-codes", {
        method: "POST",
        body: JSON.stringify(draftToBody(draft)),
      });
      setDraft(emptyDraft());
      setMessage(`折扣码 ${payload.code.code} 已创建。`);
      await loadCodes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "折扣码创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveCode(id: string): Promise<void> {
    const invalid = validateDraft(editDraft);
    if (invalid) {
      setMessage("");
      setError(invalid);
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await apiJson<DiscountCodeResponse>(`/api/admin/discount-codes/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(draftToBody(editDraft)),
      });
      setEditingId(null);
      setMessage("折扣码已保存。");
      await loadCodes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "折扣码保存失败");
    } finally {
      setSaving(false);
    }
  }

  /** 停用走软删接口，启用走 PUT status，两个方向都留在同一个按钮上。 */
  async function toggleStatus(entry: PublicDiscountCode): Promise<void> {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      if (entry.status === "active") {
        await apiJson<{ ok: boolean }>(`/api/admin/discount-codes/${encodeURIComponent(entry.id)}`, {
          method: "DELETE",
        });
        setMessage(`折扣码 ${entry.code} 已停用。`);
      } else {
        await apiJson<DiscountCodeResponse>(`/api/admin/discount-codes/${encodeURIComponent(entry.id)}`, {
          method: "PUT",
          body: JSON.stringify({ status: "active" }),
        });
        setMessage(`折扣码 ${entry.code} 已启用。`);
      }
      await loadCodes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "折扣码状态更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function openRedemptions(id: string): Promise<void> {
    if (redemptionsId === id) {
      setRedemptionsId(null);
      return;
    }
    setRedemptionsId(id);
    setRedemptions([]);
    setRedemptionsLoading(true);
    setError("");
    try {
      const payload = await apiJson<RedemptionsResponse>(
        `/api/admin/discount-codes/${encodeURIComponent(id)}/redemptions`,
      );
      setRedemptions(payload.redemptions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "使用记录加载失败");
    } finally {
      setRedemptionsLoading(false);
    }
  }

  function startEdit(entry: PublicDiscountCode): void {
    if (editingId === entry.id) {
      setEditingId(null);
      return;
    }
    setEditingId(entry.id);
    setEditDraft(draftFromCode(entry));
  }

  return (
    <AdminShell
      active="discounts"
      title="折扣码"
      description="购买次数时的折扣规则：打折、立减、赠送三种玩法，收款金额按折后份数走，发放次数仍按原始份数计算。"
      actions={
        <button className="button" type="button" onClick={loadCodes} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? "刷新中" : "刷新"}
        </button>
      }
    >
      {error ? <div className="toast-line error">{error}</div> : null}
      {message ? <div className="toast-line">{message}</div> : null}

      <section className="admin-metric-strip" aria-label="折扣码概览">
        <Metric label="折扣码数" value={totals.codes} />
        <Metric label="生效中" value={totals.active} />
        <Metric label="已停用" value={totals.disabled} />
        <Metric label="累计使用" value={totals.used} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>新建折扣码</h2>
            <p>折扣码留空则由服务端自动生成 8 位大写码；生效 / 失效时间留空表示长期有效。</p>
          </div>
        </div>
        <div className="panel-body form-stack">
          <DiscountFormFields draft={draft} onChange={setDraft} codePlaceholder="留空自动生成" />
          <div className="button-row">
            <button className="button primary" type="button" onClick={createCode} disabled={saving}>
              <Plus size={16} aria-hidden="true" />
              {saving ? "提交中" : "创建折扣码"}
            </button>
            <button className="button subtle" type="button" onClick={() => setDraft(emptyDraft())} disabled={saving}>
              <X size={16} aria-hidden="true" />
              重置表单
            </button>
          </div>
        </div>
      </section>

      <section className="panel admin-ops-panel">
        <div className="admin-table-wrap">
          <table className="admin-data-table admin-discount-table">
            <thead>
              <tr>
                <th>折扣码</th>
                <th>名称</th>
                <th>规则</th>
                <th>已用 / 上限</th>
                <th>有效期</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7}>
                    <span className="admin-discount-empty">还没有折扣码，先在上方创建一个。</span>
                  </td>
                </tr>
              ) : null}
              {codes.map((entry) => (
                <DiscountRows
                  key={entry.id}
                  entry={entry}
                  saving={saving}
                  editing={editingId === entry.id}
                  editDraft={editDraft}
                  onEditDraftChange={setEditDraft}
                  onStartEdit={() => startEdit(entry)}
                  onSave={() => void saveCode(entry.id)}
                  onToggleStatus={() => void toggleStatus(entry)}
                  onOpenRedemptions={() => void openRedemptions(entry.id)}
                  redemptionsOpen={redemptionsId === entry.id}
                  redemptionsLoading={redemptionsLoading}
                  redemptions={redemptions}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}

function DiscountRows({
  entry,
  saving,
  editing,
  editDraft,
  onEditDraftChange,
  onStartEdit,
  onSave,
  onToggleStatus,
  onOpenRedemptions,
  redemptionsOpen,
  redemptionsLoading,
  redemptions,
}: {
  entry: PublicDiscountCode;
  saving: boolean;
  editing: boolean;
  editDraft: DiscountDraft;
  onEditDraftChange: (draft: DiscountDraft) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onToggleStatus: () => void;
  onOpenRedemptions: () => void;
  redemptionsOpen: boolean;
  redemptionsLoading: boolean;
  redemptions: DiscountRedemption[];
}) {
  const disabled = entry.status === "disabled";
  return (
    <>
      <tr className={clsx(disabled && "is-muted")}>
        <td>
          <strong className="admin-discount-code">{entry.code}</strong>
        </td>
        <td>{entry.name || "—"}</td>
        <td>
          <div className="table-stack">
            <strong>{discountRuleSummary(entry.type, entry.value)}</strong>
            <small>
              最低 {entry.minUnits} 份 · 每人 {entry.perUserLimit} 次
            </small>
          </div>
        </td>
        <td>{discountUsageLabel(entry.usedCount, entry.maxUses)}</td>
        <td>{discountPeriodLabel(entry.startsAt, entry.expiresAt)}</td>
        <td>
          <span className={clsx("badge", disabled ? "neutral" : "success")}>{disabled ? "已停用" : "生效中"}</span>
        </td>
        <td>
          <div className="admin-discount-actions">
            <button className="button subtle mini-button" type="button" onClick={onToggleStatus} disabled={saving}>
              {disabled ? "启用" : "停用"}
            </button>
            <button className="button subtle mini-button" type="button" onClick={onStartEdit} disabled={saving}>
              {editing ? "收起" : "编辑"}
            </button>
            <button className="button subtle mini-button" type="button" onClick={onOpenRedemptions}>
              <History size={13} aria-hidden="true" />
              使用记录
            </button>
          </div>
        </td>
      </tr>
      {editing ? (
        <tr className="admin-discount-expand">
          <td colSpan={7}>
            <div className="admin-discount-expand-body">
              <DiscountFormFields draft={editDraft} onChange={onEditDraftChange} codePlaceholder="折扣码" />
              <div className="button-row">
                <button className="button primary" type="button" onClick={onSave} disabled={saving}>
                  <Save size={16} aria-hidden="true" />
                  保存折扣码
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
      {redemptionsOpen ? (
        <tr className="admin-discount-expand">
          <td colSpan={7}>
            <div className="admin-discount-expand-body">
              <div className="section-title-row">
                <strong>
                  <Ticket size={14} aria-hidden="true" /> {entry.code} 使用记录
                </strong>
                <span className="field-hint">共 {redemptions.length} 条</span>
              </div>
              {redemptionsLoading ? <p className="field-hint">加载中…</p> : null}
              {!redemptionsLoading && redemptions.length === 0 ? (
                <p className="field-hint">该折扣码还没有被使用过。</p>
              ) : null}
              {!redemptionsLoading && redemptions.length > 0 ? (
                <table className="admin-data-table admin-discount-redemption-table">
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>订单</th>
                      <th>原始 / 实付份数</th>
                      <th>到账次数</th>
                      <th>优惠金额</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {redemptions.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <div className="table-stack">
                            <strong>{item.userName || "—"}</strong>
                            <small>{item.userId}</small>
                          </div>
                        </td>
                        <td>{item.orderId}</td>
                        <td>
                          {item.unitsOriginal} / {item.unitsCharged}
                        </td>
                        <td>{item.creditCount}</td>
                        <td>{formatFenAsYuan(item.discountFen)}</td>
                        <td>{formatDateTime(item.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DiscountFormFields({
  draft,
  onChange,
  codePlaceholder,
}: {
  draft: DiscountDraft;
  onChange: (draft: DiscountDraft) => void;
  codePlaceholder: string;
}) {
  const valueMeta = discountValueFieldMeta(draft.type);

  function patch(next: Partial<DiscountDraft>): void {
    onChange({ ...draft, ...next });
  }

  return (
    <div className="admin-discount-form-grid">
      <label className="field">
        <span>折扣码</span>
        <input
          className="input"
          value={draft.code}
          maxLength={32}
          placeholder={codePlaceholder}
          onChange={(event) => patch({ code: normalizeDiscountCode(event.target.value) })}
        />
        <span className="field-hint">4-32 位，仅大写字母和数字。</span>
      </label>

      <label className="field">
        <span>名称</span>
        <input
          className="input"
          value={draft.name}
          placeholder="例如 暑期八折"
          onChange={(event) => patch({ name: event.target.value })}
        />
        <span className="field-hint">仅后台展示，可留空。</span>
      </label>

      <label className="field">
        <span>折扣类型</span>
        <select
          className="select"
          value={draft.type}
          onChange={(event) => patch({ type: event.target.value as DiscountType })}
        >
          {discountTypeOptions.map((type) => (
            <option key={type} value={type}>
              {discountTypeLabels[type]}
            </option>
          ))}
        </select>
        <span className="field-hint">收款金额按折后份数走，发放次数仍按原始份数计算。</span>
      </label>

      <label className="field">
        <span>{valueMeta.label}</span>
        <input
          className="input"
          type="number"
          min={valueMeta.min}
          max={valueMeta.max}
          value={draft.value}
          onChange={(event) => patch({ value: Number.parseInt(event.target.value, 10) || 0 })}
        />
        <span className="field-hint">{valueMeta.hint}</span>
      </label>

      <label className="field">
        <span>最低购买份数</span>
        <input
          className="input"
          type="number"
          min={1}
          value={draft.minUnits}
          onChange={(event) => patch({ minUnits: Number.parseInt(event.target.value, 10) || 0 })}
        />
        <span className="field-hint">低于该份数时折扣码不可用。</span>
      </label>

      <label className="field">
        <span>总可用次数</span>
        <input
          className="input"
          type="number"
          min={1}
          value={draft.maxUses}
          placeholder="留空 = 不限"
          onChange={(event) => patch({ maxUses: event.target.value })}
        />
        <span className="field-hint">留空表示不限总量。</span>
      </label>

      <label className="field">
        <span>每人可用次数</span>
        <input
          className="input"
          type="number"
          min={1}
          value={draft.perUserLimit}
          onChange={(event) => patch({ perUserLimit: Number.parseInt(event.target.value, 10) || 0 })}
        />
        <span className="field-hint">同一账号最多能用几次。</span>
      </label>

      <label className="field">
        <span>状态</span>
        <select
          className="select"
          value={draft.status}
          onChange={(event) => patch({ status: event.target.value as DiscountStatus })}
        >
          <option value="active">生效中</option>
          <option value="disabled">已停用</option>
        </select>
        <span className="field-hint">停用后用户端立即不可用。</span>
      </label>

      <label className="field">
        <span>生效时间</span>
        <input
          className="input"
          type="datetime-local"
          value={draft.startsAt}
          onChange={(event) => patch({ startsAt: event.target.value })}
        />
        <span className="field-hint">留空表示立即生效。</span>
      </label>

      <label className="field">
        <span>失效时间</span>
        <input
          className="input"
          type="datetime-local"
          value={draft.expiresAt}
          onChange={(event) => patch({ expiresAt: event.target.value })}
        />
        <span className="field-hint">留空表示不过期。</span>
      </label>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
