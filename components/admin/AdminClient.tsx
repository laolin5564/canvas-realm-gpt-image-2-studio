"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Ban,
  CheckCircle2,
  Clock,
  DollarSign,
  Gauge,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from "lucide-react";
import clsx from "clsx";
import type {
  AdminStats,
  CurrentUser,
  ImageProvider,
  PublicAdminSettings,
  PublicImageProviderChannel,
  PublicOpenAIOAuthAccount,
  PublicUser,
  PublicUserGroup,
  SystemUpdateInfo,
  WebUpdateTask,
} from "@/lib/types";
import { imageConcurrencyLimits } from "@/lib/types";
import { apiJson, copyTextToClipboard } from "@/components/client-api";

interface StatsResponse {
  stats: AdminStats;
}

interface SettingsResponse {
  settings: PublicAdminSettings;
}

interface GroupsResponse {
  groups: PublicUserGroup[];
}

interface GroupResponse {
  group: PublicUserGroup;
}

interface UsersResponse {
  users: PublicUser[];
}

interface OpenAIOAuthAccountsResponse {
  accounts: PublicOpenAIOAuthAccount[];
}

interface SystemUpdateResponse {
  update: SystemUpdateInfo;
  error: string | null;
}

interface WebUpdateStatusResponse {
  task: WebUpdateTask;
}

interface OpenAIOAuthStartResponse {
  authUrl: string;
  sessionId: string;
  redirectUri: string;
  expiresAt: string;
  experimental: boolean;
}

interface OpenAIOAuthAccountResponse {
  account: PublicOpenAIOAuthAccount;
}

interface UserResponse {
  user: PublicUser;
}

interface MeResponse {
  user: CurrentUser | null;
}

type EditableImageProviderChannel = PublicImageProviderChannel & {
  apiKey: string;
};

export function AdminClient() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [settings, setSettings] = useState<PublicAdminSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [imageProvider, setImageProvider] = useState<ImageProvider>("sub2api");
  const [baseUrl, setBaseUrl] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [providerChannels, setProviderChannels] = useState<EditableImageProviderChannel[]>([]);
  const [promptOptimizerModel, setPromptOptimizerModel] = useState("gpt-5.5");
  const [imageConcurrency, setImageConcurrency] = useState(2);
  const [imageRetentionDays, setImageRetentionDays] = useState(0);
  const [siteTitle, setSiteTitle] = useState("");
  const [siteSubtitle, setSiteSubtitle] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [registrationDefaultGroupId, setRegistrationDefaultGroupId] = useState("");
  const [registrationDefaultQuota, setRegistrationDefaultQuota] = useState(100);
  const [groups, setGroups] = useState<PublicUserGroup[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [openAIAccounts, setOpenAIAccounts] = useState<PublicOpenAIOAuthAccount[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [systemUpdate, setSystemUpdate] = useState<SystemUpdateInfo | null>(null);
  const [webUpdateTask, setWebUpdateTask] = useState<WebUpdateTask | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [pendingOpenAIAuthUrl, setPendingOpenAIAuthUrl] = useState("");
  const [pendingOpenAIAuthSessionId, setPendingOpenAIAuthSessionId] = useState("");
  const [pendingOpenAIAuthState, setPendingOpenAIAuthState] = useState("");
  const [openAICallbackInput, setOpenAICallbackInput] = useState("");
  const [openAIProxyUrl, setOpenAIProxyUrl] = useState("");
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateRunning, setUpdateRunning] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupQuota, setNewGroupQuota] = useState(100);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<PublicUser["role"]>("member");
  const [newUserGroupId, setNewUserGroupId] = useState("");
  const [newUserQuota, setNewUserQuota] = useState(100);
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<"all" | PublicUser["status"]>("all");
  const [error, setError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [openAIMessage, setOpenAIMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [accountsSaving, setAccountsSaving] = useState(false);
  const [openAISaving, setOpenAISaving] = useState(false);
  const isOpenAIOAuthProvider = imageProvider === "openai_oauth";

  async function loadStats(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson<StatsResponse>("/api/admin/stats");
      setStats(payload.stats);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "统计加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings(): Promise<void> {
    const payload = await apiJson<SettingsResponse>("/api/admin/settings");
    setSettings(payload.settings);
    setImageProvider(payload.settings.imageProvider);
    setBaseUrl(payload.settings.sub2apiBaseUrl);
    setImageModel(payload.settings.imageModel);
    setProviderChannels(
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
    setPromptOptimizerModel(payload.settings.promptOptimizerModel);
    setImageConcurrency(payload.settings.imageConcurrency);
    setImageRetentionDays(payload.settings.imageRetentionDays);
    setSiteTitle(payload.settings.siteTitle);
    setSiteSubtitle(payload.settings.siteSubtitle);
    setRegistrationEnabled(payload.settings.registrationEnabled);
    setRegistrationDefaultGroupId(payload.settings.registrationDefaultGroupId);
    setRegistrationDefaultQuota(payload.settings.registrationDefaultQuota);
    setOpenAIProxyUrl("");
    setNewUserGroupId((current) => current || payload.settings.registrationDefaultGroupId);
    setNewUserQuota(payload.settings.registrationDefaultQuota);
  }

  async function loadAccounts(): Promise<void> {
    const [groupsPayload, usersPayload, openAIPayload] = await Promise.all([
      apiJson<GroupsResponse>("/api/admin/groups"),
      apiJson<UsersResponse>("/api/admin/users"),
      apiJson<OpenAIOAuthAccountsResponse>("/api/admin/openai-accounts"),
    ]);
    setGroups(groupsPayload.groups);
    setUsers(usersPayload.users);
    setOpenAIAccounts(openAIPayload.accounts);
  }

  async function loadCurrentUser(): Promise<void> {
    const payload = await apiJson<MeResponse>("/api/auth/me");
    setCurrentUser(payload.user);
  }

  async function loadSystemUpdate(): Promise<void> {
    setUpdateChecking(true);
    setUpdateMessage("");
    try {
      const payload = await apiJson<SystemUpdateResponse>("/api/admin/system-update");
      setSystemUpdate(payload.update);
      setUpdateError(payload.error ?? "");
    } catch (caught) {
      setUpdateError(caught instanceof Error ? caught.message : "检查更新失败");
    } finally {
      setUpdateChecking(false);
    }
  }

  async function loadWebUpdateStatus(): Promise<WebUpdateTask> {
    const payload = await apiJson<WebUpdateStatusResponse>("/api/admin/system-update/status");
    setWebUpdateTask(payload.task);
    return payload.task;
  }

  async function runWebUpdate(): Promise<void> {
    if (!webUpdateTask?.enabled) {
      setUpdateError(webUpdateTask?.enabledReason ?? "Web 一键更新未启用");
      return;
    }

    const confirmed = window.confirm("确认立即执行 Web 一键更新？脚本会备份 data/ 和 .env*，然后拉取代码并执行 Docker Compose 重建。建议确认当前没有生成任务正在进行。");
    if (!confirmed) {
      return;
    }

    setUpdateRunning(true);
    setUpdateError("");
    setUpdateMessage("已触发更新任务，页面会自动刷新日志。");
    try {
      const payload = await apiJson<WebUpdateStatusResponse>("/api/admin/system-update/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setWebUpdateTask(payload.task);
    } catch (caught) {
      setUpdateError(caught instanceof Error ? caught.message : "触发更新失败");
    } finally {
      setUpdateRunning(false);
    }
  }

  async function copyUpdateCommand(): Promise<void> {
    if (!systemUpdate) {
      return;
    }
    try {
      await copyTextToClipboard(systemUpdate.updateCommand);
      setUpdateMessage("更新命令已复制。请在服务器项目目录手动执行，执行前确认已备份 data/ 和 .env。");
    } catch (caught) {
      setUpdateMessage(caught instanceof Error ? caught.message : "复制失败，请手动复制下方命令。");
    }
  }

  async function connectOpenAIAccount(): Promise<void> {
    const authWindow = window.open("about:blank", "_blank");
    if (authWindow) {
      authWindow.opener = null;
      authWindow.document.title = "正在打开 OpenAI 授权";
      authWindow.document.body.textContent = "正在打开 OpenAI 授权页...";
      authWindow.document.body.style.fontFamily = "system-ui, sans-serif";
      authWindow.document.body.style.padding = "24px";
    }

    setOpenAISaving(true);
    setOpenAIMessage("");
    setPendingOpenAIAuthUrl("");
    setPendingOpenAIAuthSessionId("");
    setPendingOpenAIAuthState("");
    setOpenAICallbackInput("");
    setError("");
    try {
      const payload = await apiJson<OpenAIOAuthStartResponse>("/api/admin/openai-accounts", {
        method: "POST",
        body: JSON.stringify(openAIProxyUrl.trim() ? { proxyUrl: openAIProxyUrl.trim() } : {}),
      });
      if (openAIProxyUrl.trim()) {
        await loadSettings();
      }
      const oauthState = getQueryParam(payload.authUrl, "state");
      setPendingOpenAIAuthUrl(payload.authUrl);
      setPendingOpenAIAuthSessionId(payload.sessionId);
      setPendingOpenAIAuthState(oauthState);
      if (authWindow) {
        authWindow.location.href = payload.authUrl;
        setOpenAIMessage("已打开 OpenAI 授权页。授权完成后复制浏览器地址栏中的 localhost 回调地址，粘贴到下方完成连接。");
      } else {
        setOpenAIMessage("浏览器拦截了授权弹窗，请点击下方备用授权链接打开 OpenAI，并在授权后粘贴回调地址。");
      }
    } catch (caught) {
      authWindow?.close();
      setError(caught instanceof Error ? caught.message : "OpenAI 授权发起失败");
    } finally {
      setOpenAISaving(false);
    }
  }

  async function completeOpenAIAccountAuth(): Promise<void> {
    if (!openAICallbackInput.trim()) {
      setError("请粘贴授权后的 localhost 回调地址或 code。");
      return;
    }

    setOpenAISaving(true);
    setOpenAIMessage("");
    setError("");
    try {
      const payload = await apiJson<OpenAIOAuthAccountResponse>("/api/admin/openai-accounts/oauth/callback", {
        method: "POST",
        body: JSON.stringify({
          callbackUrl: openAICallbackInput.trim(),
          sessionId: pendingOpenAIAuthSessionId,
          state: pendingOpenAIAuthState,
        }),
      });
      setOpenAIAccounts((current) => {
        const rest = current.filter((item) => item.id !== payload.account.id);
        return [payload.account, ...rest];
      });
      setPendingOpenAIAuthUrl("");
      setPendingOpenAIAuthSessionId("");
      setPendingOpenAIAuthState("");
      setOpenAICallbackInput("");
      setOpenAIMessage("OpenAI 账号已连接，后续可切换到内置 OpenAI OAuth 模式测试。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OpenAI 授权完成失败");
    } finally {
      setOpenAISaving(false);
    }
  }

  async function setOpenAIAccountStatus(account: PublicOpenAIOAuthAccount, status: "active" | "disabled"): Promise<void> {
    setOpenAISaving(true);
    setOpenAIMessage("");
    setError("");
    try {
      const payload = await apiJson<OpenAIOAuthAccountResponse>(`/api/admin/openai-accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setOpenAIAccounts((current) => current.map((item) => (item.id === payload.account.id ? payload.account : item)));
      setOpenAIMessage(status === "active" ? "OpenAI 账号已启用。" : "OpenAI 账号已禁用。更新 provider 后 Worker 会停止使用它。 ");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OpenAI 账号状态更新失败");
    } finally {
      setOpenAISaving(false);
    }
  }

  async function updateOpenAIProxy(proxyUrl: string | null): Promise<void> {
    setOpenAISaving(true);
    setOpenAIMessage("");
    setError("");
    try {
      const payload = await apiJson<SettingsResponse>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ openaiOAuthProxyUrl: proxyUrl }),
      });
      setSettings(payload.settings);
      setOpenAIProxyUrl("");
      setOpenAIMessage(proxyUrl === null ? "OpenAI OAuth 代理已清除。" : "OpenAI OAuth 代理已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OpenAI OAuth 代理保存失败");
    } finally {
      setOpenAISaving(false);
    }
  }

  async function saveSettings(): Promise<void> {
    setSettingsSaving(true);
    setSettingsMessage("");
    setError("");

    try {
      const body: {
        imageProvider?: ImageProvider;
        sub2apiApiKey?: string;
        sub2apiBaseUrl?: string;
        imageProviderChannels?: Array<{
          id?: string;
          name: string;
          enabled: boolean;
          priority: number;
          baseUrl: string;
          model: string;
          apiKey?: string | null;
        }>;
        imageModel?: string;
        promptOptimizerModel?: string;
        imageConcurrency?: number;
        imageRetentionDays?: number;
        siteTitle?: string;
        siteSubtitle?: string;
        registrationEnabled?: boolean;
        registrationDefaultGroupId?: string;
        registrationDefaultQuota?: number;
      } = {
        imageProvider,
        imageConcurrency,
        imageRetentionDays,
        siteTitle,
        siteSubtitle,
        registrationEnabled,
        registrationDefaultGroupId,
        registrationDefaultQuota,
        promptOptimizerModel,
      };

      if (!isOpenAIOAuthProvider) {
        body.sub2apiBaseUrl = baseUrl;
        body.imageModel = imageModel;
        body.imageProviderChannels = providerChannels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          enabled: channel.enabled,
          priority: channel.priority,
          baseUrl: channel.baseUrl,
          model: channel.model,
          apiKey: channel.apiKey.trim() ? channel.apiKey.trim() : null,
        }));
      }

      if (!isOpenAIOAuthProvider && apiKey.trim()) {
        body.sub2apiApiKey = apiKey.trim();
      }
      const payload = await apiJson<SettingsResponse>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setSettings(payload.settings);
      setImageProvider(payload.settings.imageProvider);
      setBaseUrl(payload.settings.sub2apiBaseUrl);
      setImageModel(payload.settings.imageModel);
      setProviderChannels(payload.settings.imageProviderChannels.map((channel) => ({ ...channel, apiKey: "" })));
      setPromptOptimizerModel(payload.settings.promptOptimizerModel);
      setImageConcurrency(payload.settings.imageConcurrency);
      setImageRetentionDays(payload.settings.imageRetentionDays);
      setSiteTitle(payload.settings.siteTitle);
      setSiteSubtitle(payload.settings.siteSubtitle);
      setRegistrationEnabled(payload.settings.registrationEnabled);
      setRegistrationDefaultGroupId(payload.settings.registrationDefaultGroupId);
      setRegistrationDefaultQuota(payload.settings.registrationDefaultQuota);
      setApiKey("");
      setSettingsMessage("配置已保存，后续生成任务会使用新的服务端配置。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "配置保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function createGroup(): Promise<void> {
    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      const payload = await apiJson<GroupResponse>("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({
          name: newGroupName,
          monthlyQuota: newGroupQuota,
        }),
      });
      setGroups((current) => [...current, payload.group]);
      setNewGroupName("");
      setNewGroupQuota(100);
      setAccountMessage("分组已创建。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "分组创建失败");
    } finally {
      setAccountsSaving(false);
    }
  }

  async function saveGroup(group: PublicUserGroup): Promise<void> {
    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      const payload = await apiJson<GroupResponse>(`/api/admin/groups/${group.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: group.name,
          monthlyQuota: group.monthlyQuota,
        }),
      });
      setGroups((current) => current.map((item) => (item.id === payload.group.id ? payload.group : item)));
      setAccountMessage("分组已保存。");
      await loadAccounts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "分组保存失败");
    } finally {
      setAccountsSaving(false);
    }
  }

  async function saveUser(user: PublicUser): Promise<void> {
    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      const payload = await apiJson<UserResponse>(`/api/admin/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: user.name,
          role: user.role,
          status: user.status,
          groupId: user.groupId,
          monthlyQuota: user.quotaOverride ?? user.monthlyQuota ?? 0,
        }),
      });
      setUsers((current) => current.map((item) => (item.id === payload.user.id ? payload.user : item)));
      setAccountMessage("账号已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号保存失败");
    } finally {
      setAccountsSaving(false);
    }
  }

  async function setUserStatus(user: PublicUser, status: PublicUser["status"]): Promise<void> {
    const label = status === "disabled" ? "禁用" : "启用";
    if (status === "disabled") {
      const confirmed = window.confirm(`确定禁用账号「${user.name}」吗？禁用后该用户无法登录，也无法继续调用接口。`);
      if (!confirmed) {
        return;
      }
    }

    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      const payload = await apiJson<UserResponse>(`/api/admin/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: user.name,
          role: user.role,
          status,
          groupId: user.groupId,
          monthlyQuota: user.quotaOverride ?? user.monthlyQuota ?? 0,
        }),
      });
      setUsers((current) => current.map((item) => (item.id === payload.user.id ? payload.user : item)));
      setAccountMessage(`账号已${label}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `账号${label}失败`);
    } finally {
      setAccountsSaving(false);
    }
  }

  async function deleteUserAccount(user: PublicUser): Promise<void> {
    const confirmed = window.confirm(`确定删除账号「${user.name}」吗？该操作会移除账号和登录会话，历史图片仍保留为已删除用户记录。`);
    if (!confirmed) {
      return;
    }

    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      await apiJson(`/api/admin/users/${user.id}`, { method: "DELETE" });
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setAccountMessage("账号已删除。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号删除失败");
    } finally {
      setAccountsSaving(false);
    }
  }

  async function createUser(): Promise<void> {
    setAccountsSaving(true);
    setAccountMessage("");
    setError("");
    try {
      const payload = await apiJson<UserResponse>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: newUserEmail,
          name: newUserName,
          password: newUserPassword,
          role: newUserRole,
          groupId: newUserGroupId || null,
          monthlyQuota: newUserQuota,
        }),
      });
      setUsers((current) => [...current, payload.user]);
      setNewUserEmail("");
      setNewUserName("");
      setNewUserPassword("");
      setNewUserRole("member");
      setNewUserQuota(registrationDefaultQuota);
      setAccountMessage("账号已创建。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号创建失败");
    } finally {
      setAccountsSaving(false);
    }
  }

  function updateProviderChannel(id: string, patch: Partial<EditableImageProviderChannel>): void {
    setProviderChannels((current) =>
      current.map((channel) => (channel.id === id ? { ...channel, ...patch } : channel)),
    );
  }

  function addProviderChannel(): void {
    const now = new Date().toISOString();
    setProviderChannels((current) => [
      ...current,
      {
        id: `draft_${crypto.randomUUID()}`,
        name: `备用渠道 ${current.length + 1}`,
        enabled: true,
        priority: current.length + 1,
        baseUrl: baseUrl || "https://s2a.laolin.ai/v1",
        model: imageModel || "gpt-image-2",
        apiKeyConfigured: false,
        apiKey: "",
        createdAt: now,
        updatedAt: now,
      },
    ]);
  }

  function removeProviderChannel(id: string): void {
    setProviderChannels((current) => {
      if (current.length <= 1) {
        setError("至少需要保留一个模型渠道。");
        return current;
      }
      return current.filter((channel) => channel.id !== id).map((channel, index) => ({ ...channel, priority: index + 1 }));
    });
  }

  useEffect(() => {
    loadStats().catch((caught: Error) => setError(caught.message));
    loadSettings().catch((caught: Error) => setError(caught.message));
    loadAccounts().catch((caught: Error) => setError(caught.message));
    loadCurrentUser().catch((caught: Error) => setError(caught.message));
    loadSystemUpdate().catch((caught: Error) => setUpdateError(caught.message));
    loadWebUpdateStatus().catch((caught: Error) => setUpdateError(caught.message));
    const timer = window.setInterval(() => {
      loadStats().catch((caught: Error) => setError(caught.message));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (webUpdateTask?.status !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      loadWebUpdateStatus().catch((caught: Error) => setUpdateError(caught.message));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [webUpdateTask?.status]);

  const userSummary = useMemo(() => {
    return users.reduce(
      (summary, user) => {
        summary.total += 1;
        summary[user.status] += 1;
        summary[user.role] += 1;
        return summary;
      },
      { total: 0, active: 0, disabled: 0, admin: 0, member: 0 },
    );
  }, [users]);

  const filteredUsers = useMemo(() => {
    const keyword = userSearch.trim().toLowerCase();
    return users.filter((user) => {
      const matchesStatus = userStatusFilter === "all" || user.status === userStatusFilter;
      const matchesKeyword =
        keyword.length === 0 ||
        user.name.toLowerCase().includes(keyword) ||
        user.email.toLowerCase().includes(keyword) ||
        (user.groupName ?? "").toLowerCase().includes(keyword);
      return matchesStatus && matchesKeyword;
    });
  }, [userSearch, userStatusFilter, users]);

  const displayStats: AdminStats = stats ?? {
    today: { totalTasks: 0, succeededTasks: 0, failedTasks: 0, totalImages: 0, estimatedCost: 0 },
    week: { totalTasks: 0, succeededTasks: 0, failedTasks: 0, totalImages: 0, estimatedCost: 0 },
    popularTemplates: [],
    health: {
      provider: imageProvider,
      baseUrl: baseUrl || "未配置",
      imageModel: imageModel || "未配置",
      imageConcurrency,
      timeoutStreak: 0,
      autoDegradedAt: null,
      averageDurationSeconds: null,
      failureRate: 0,
      availabilityRate: 100,
      weekTimeoutTasks: 0,
      upstreamMaxInflight: 0,
    },
    channelHealth: { last24h: [], last7d: [] },
    topErrors: [],
    userSuccessRanking: [],
    groupUsage: [],
  };

  return (
    <>
      <section className="page-heading">
        <div>
          <h1>管理员后台</h1>
          <p>集中管理模型健康、系统更新、账号权限、分组额度和站点配置。</p>
        </div>
        <button className="button" type="button" onClick={loadStats} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? "刷新中" : "刷新"}
        </button>
      </section>

      <div className={clsx("toast-line", error && "error")}>{error}</div>

      {stats ? null : <div className="toast-line" aria-live="polite">统计加载中，配置面板可继续使用。</div>}

        <>
          <section className="stats-grid">
            <StatCard label="今日生成次数" value={displayStats.today.totalTasks} icon={<BarChart3 size={18} />} />
            <StatCard label="本周生成次数" value={displayStats.week.totalTasks} icon={<TrendingUp size={18} />} />
            <StatCard label="成功 / 失败" value={`${displayStats.week.succeededTasks} / ${displayStats.week.failedTasks}`} icon={<BarChart3 size={18} />} />
            <StatCard label="本周预估成本" value={`$${displayStats.week.estimatedCost.toFixed(2)}`} icon={<DollarSign size={18} />} />
            <StatCard label="模型可用率" value={`${displayStats.health.availabilityRate}%`} icon={<Activity size={18} />} />
            <StatCard label="平均耗时" value={displayStats.health.averageDurationSeconds === null ? "暂无" : `${displayStats.health.averageDurationSeconds}s`} icon={<Clock size={18} />} />
            <StatCard label="本周超时任务" value={displayStats.health.weekTimeoutTasks} icon={<AlertTriangle size={18} />} />
            <StatCard label="当前并发" value={displayStats.health.imageConcurrency} icon={<Gauge size={18} />} />
          </section>

          <div className="admin-dashboard-grid">
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>模型健康</h2>
                </div>
                <span className={clsx("badge", displayStats.health.timeoutStreak > 0 ? "warning" : "success")}>
                  连续超时 {displayStats.health.timeoutStreak}
                </span>
              </div>
              <div className="panel-body popular-list">
                <div className="popular-row">
                  <strong>接口模式</strong>
                  <span className="badge">{displayStats.health.provider === "openai_oauth" ? "内置 OAuth" : "API Key"}</span>
                </div>
                <div className="popular-row">
                  <strong>Base URL</strong>
                  <span>{displayStats.health.baseUrl}</span>
                </div>
                <div className="popular-row">
                  <strong>模型</strong>
                  <span>{displayStats.health.imageModel}</span>
                </div>
                <div className="popular-row">
                  <strong>失败率</strong>
                  <span className={clsx("badge", displayStats.health.failureRate > 20 ? "danger" : displayStats.health.failureRate > 0 ? "warning" : "success")}>
                    {displayStats.health.failureRate}%
                  </span>
                </div>
                {displayStats.health.autoDegradedAt ? (
                  <div className="popular-row">
                    <strong>最近自动降并发</strong>
                    <span>{new Date(displayStats.health.autoDegradedAt).toLocaleString()}</span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>系统更新</h2>
                </div>
                <span className={clsx("badge", systemUpdate?.updateAvailable ? "warning" : "success")}>
                  {systemUpdate?.updateAvailable ? "发现新版本" : "当前已是最新"}
                </span>
              </div>
              <div className="panel-body form-stack">
                <div className="field-row">
                  <div className="field">
                    <label>当前版本</label>
                    <span className="badge">v{systemUpdate?.currentVersion ?? "检测中"}</span>
                  </div>
                  <div className="field">
                    <label>最新版本</label>
                    <span className="badge">{systemUpdate?.latestTag ?? "暂未获取"}</span>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>发布时间</label>
                    <span>{systemUpdate?.publishedAt ? new Date(systemUpdate.publishedAt).toLocaleString() : "暂未获取"}</span>
                  </div>
                  <div className="field">
                    <label>更新源</label>
                    <span>{systemUpdate?.updateRepo ?? "laolin5564/canvas-realm-gpt-image-2-studio"}</span>
                  </div>
                </div>
                {systemUpdate?.releaseNotesUrl ? (
                  <a className="button subtle" href={systemUpdate.releaseNotesUrl} target="_blank" rel="noreferrer">
                    查看 Release Notes
                  </a>
                ) : null}
                <div className="field">
                  <label>推荐更新命令</label>
                  <code className="command-box">{systemUpdate?.updateCommand ?? "WEB_UPDATE_ENABLED=true bash scripts/web-update.sh"}</code>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Web 一键更新</label>
                    <span className={clsx("badge", webUpdateTask?.enabled ? "success" : "warning")}>{webUpdateTask?.enabled ? "已启用" : "未启用"}</span>
                    {webUpdateTask?.enabledReason ? <small>{webUpdateTask.enabledReason}</small> : null}
                  </div>
                  <div className="field">
                    <label>任务状态</label>
                    <span className={clsx("badge", webUpdateTask?.status === "failed" ? "danger" : webUpdateTask?.status === "running" ? "warning" : "success")}>{webUpdateTask?.status ?? "idle"}</span>
                    <small>
                      {webUpdateTask?.startedAt ? `开始：${new Date(webUpdateTask.startedAt).toLocaleString()}` : "尚未执行"}
                      {webUpdateTask?.finishedAt ? `；结束：${new Date(webUpdateTask.finishedAt).toLocaleString()}` : ""}
                    </small>
                  </div>
                </div>
                <div className="section-title-row">
                  <button className="button" type="button" onClick={loadSystemUpdate} disabled={updateChecking}>
                    <RefreshCw size={16} aria-hidden="true" />
                    {updateChecking ? "检查中" : "检查更新"}
                  </button>
                  <button className="button" type="button" onClick={() => loadWebUpdateStatus().catch((caught: Error) => setUpdateError(caught.message))}>
                    <RefreshCw size={16} aria-hidden="true" />
                    刷新更新状态
                  </button>
                  <button className="button primary" type="button" onClick={runWebUpdate} disabled={!webUpdateTask?.enabled || webUpdateTask.status === "running" || updateRunning}>
                    <ShieldCheck size={16} aria-hidden="true" />
                    {webUpdateTask?.status === "running" || updateRunning ? "更新中" : "立即更新"}
                  </button>
                  <button className="button primary" type="button" onClick={copyUpdateCommand} disabled={!systemUpdate}>
                    <Terminal size={16} aria-hidden="true" />
                    复制更新命令
                  </button>
                </div>
                {updateError ? <div className="toast-line error">{updateError}</div> : null}
                <div className="toast-line">{updateMessage}</div>
                {webUpdateTask?.error ? <div className="toast-line error">{webUpdateTask.error}</div> : null}
                <div className="field">
                  <label>更新日志</label>
                  <pre className="command-box update-log">{webUpdateTask?.logs.length ? webUpdateTask.logs.join("\n") : "暂无更新日志"}</pre>
                </div>
              </div>
            </section>
          </div>

          <section className="panel admin-account-panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>账号与分组</h2>
              </div>
              <span className="badge">
                <Users size={13} aria-hidden="true" />
                {userSummary.total} 个账号
              </span>
            </div>
            <div className="panel-body form-stack">
              <div className="admin-account-metrics" aria-label="账号概览">
                <div>
                  <span>可用账号</span>
                  <strong>{userSummary.active}</strong>
                </div>
                <div>
                  <span>已禁用</span>
                  <strong>{userSummary.disabled}</strong>
                </div>
                <div>
                  <span>管理员</span>
                  <strong>{userSummary.admin}</strong>
                </div>
                <div>
                  <span>普通成员</span>
                  <strong>{userSummary.member}</strong>
                </div>
              </div>

              <div className="admin-account-layout">
                <div className="admin-subsection">
                  <div className="section-title-row">
                    <strong>分组限额</strong>
                    <span className="badge">按月统计</span>
                  </div>
                  <div className="admin-grid admin-grid-groups">
                    <div className="admin-grid-head">分组</div>
                    <div className="admin-grid-head">每月次数</div>
                    <div className="admin-grid-head">操作</div>
                    {groups.map((group) => (
                      <div className="admin-grid-row" key={group.id}>
                        <input
                          className="input"
                          value={group.name}
                          onChange={(event) =>
                            setGroups((current) =>
                              current.map((item) =>
                                item.id === group.id ? { ...item, name: event.target.value } : item,
                              ),
                            )
                          }
                        />
                        <input
                          className="input"
                          type="number"
                          min={0}
                          value={group.monthlyQuota}
                          onChange={(event) =>
                            setGroups((current) =>
                              current.map((item) =>
                                item.id === group.id
                                  ? { ...item, monthlyQuota: Number(event.target.value) }
                                  : item,
                              ),
                            )
                          }
                        />
                        <button
                          className="button"
                          type="button"
                          onClick={() => saveGroup(group)}
                          disabled={accountsSaving}
                        >
                          <Save size={16} aria-hidden="true" />
                          保存
                        </button>
                      </div>
                    ))}
                    <div className="admin-grid-row new-row">
                      <input
                        className="input"
                        value={newGroupName}
                        onChange={(event) => setNewGroupName(event.target.value)}
                        placeholder="新分组名称"
                      />
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={newGroupQuota}
                        onChange={(event) => setNewGroupQuota(Number(event.target.value))}
                      />
                      <button
                        className="button primary"
                        type="button"
                        onClick={createGroup}
                        disabled={accountsSaving || !newGroupName.trim()}
                      >
                        <ShieldCheck size={16} aria-hidden="true" />
                        新建
                      </button>
                    </div>
                  </div>
                </div>

                <div className="admin-subsection">
                  <div className="section-title-row">
                    <strong>账号管理</strong>
                    <span className="badge">已用 / 限额</span>
                  </div>
                  <details className="admin-create-user-details">
                    <summary>
                      <UserPlus size={16} aria-hidden="true" />
                      新增账号
                    </summary>
                    <div className="admin-create-user">
                      <div className="field">
                        <label htmlFor="newUserName">名称</label>
                        <input
                          id="newUserName"
                          className="input"
                          value={newUserName}
                          onChange={(event) => setNewUserName(event.target.value)}
                          placeholder="成员名称"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="newUserEmail">邮箱</label>
                        <input
                          id="newUserEmail"
                          className="input"
                          type="email"
                          value={newUserEmail}
                          onChange={(event) => setNewUserEmail(event.target.value)}
                          placeholder="name@example.com"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="newUserPassword">初始密码</label>
                        <input
                          id="newUserPassword"
                          className="input"
                          type="password"
                          value={newUserPassword}
                          onChange={(event) => setNewUserPassword(event.target.value)}
                          placeholder="至少 8 位"
                          autoComplete="new-password"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="newUserRole">角色</label>
                        <select
                          id="newUserRole"
                          className="select"
                          value={newUserRole}
                          onChange={(event) => setNewUserRole(event.target.value as PublicUser["role"])}
                        >
                          <option value="member">成员</option>
                          <option value="admin">管理员</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="newUserGroup">分组</label>
                        <select
                          id="newUserGroup"
                          className="select"
                          value={newUserGroupId}
                          onChange={(event) => setNewUserGroupId(event.target.value)}
                        >
                          <option value="">无分组</option>
                          {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="newUserQuota">额度</label>
                        <input
                          id="newUserQuota"
                          className="input"
                          type="number"
                          min={0}
                          value={newUserQuota}
                          onChange={(event) => setNewUserQuota(Number(event.target.value))}
                        />
                      </div>
                      <button
                        className="button primary"
                        type="button"
                        onClick={createUser}
                        disabled={accountsSaving || !newUserName.trim() || !newUserEmail.trim() || newUserPassword.length < 8}
                      >
                        <UserPlus size={16} aria-hidden="true" />
                        创建账号
                      </button>
                    </div>
                  </details>

                  <div className="admin-user-toolbar">
                    <input
                      className="input"
                      value={userSearch}
                      onChange={(event) => setUserSearch(event.target.value)}
                      placeholder="搜索名称、邮箱或分组"
                    />
                    <select
                      className="select"
                      value={userStatusFilter}
                      onChange={(event) => setUserStatusFilter(event.target.value as typeof userStatusFilter)}
                    >
                      <option value="all">全部状态</option>
                      <option value="active">可用账号</option>
                      <option value="disabled">已禁用</option>
                    </select>
                  </div>

                  <div className="admin-user-list">
                    {filteredUsers.map((user) => {
                      const isSelf = currentUser?.id === user.id;
                      return (
                        <article className={clsx("admin-user-card", user.status === "disabled" && "disabled")} key={user.id}>
                          <div className="admin-user-card-main">
                            <div className="admin-user-avatar" aria-hidden="true">
                              {user.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="admin-user-identity">
                              <input
                                className="input"
                                value={user.name}
                                onChange={(event) =>
                                  setUsers((current) =>
                                    current.map((item) =>
                                      item.id === user.id ? { ...item, name: event.target.value } : item,
                                    ),
                                  )
                                }
                              />
                              <div className="admin-user-meta-line">
                                <span>{user.email}</span>
                                {isSelf ? <span className="badge success">当前账号</span> : null}
                                <span className={clsx("badge", user.status === "active" ? "success" : "danger")}>
                                  {user.status === "active" ? (
                                    <CheckCircle2 size={13} aria-hidden="true" />
                                  ) : (
                                    <Ban size={13} aria-hidden="true" />
                                  )}
                                  {user.status === "active" ? "可用" : "已禁用"}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="admin-user-fields">
                            <div className="field">
                              <label>角色</label>
                              <select
                                className="select"
                                value={user.role}
                                disabled={isSelf}
                                onChange={(event) =>
                                  setUsers((current) =>
                                    current.map((item) =>
                                      item.id === user.id
                                        ? { ...item, role: event.target.value as PublicUser["role"] }
                                        : item,
                                    ),
                                  )
                                }
                              >
                                <option value="member">成员</option>
                                <option value="admin">管理员</option>
                              </select>
                            </div>
                            <div className="field">
                              <label>分组</label>
                              <select
                                className="select"
                                value={user.groupId ?? ""}
                                onChange={(event) =>
                                  setUsers((current) =>
                                    current.map((item) =>
                                      item.id === user.id ? { ...item, groupId: event.target.value || null } : item,
                                    ),
                                  )
                                }
                              >
                                <option value="">无分组</option>
                                {groups.map((group) => (
                                  <option key={group.id} value={group.id}>
                                    {group.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field">
                              <label>账号额度</label>
                              <input
                                className="input"
                                type="number"
                                min={0}
                                value={user.monthlyQuota ?? 0}
                                onChange={(event) =>
                                  setUsers((current) =>
                                    current.map((item) =>
                                      item.id === user.id
                                        ? {
                                            ...item,
                                            quotaOverride: Number(event.target.value),
                                            monthlyQuota: Number(event.target.value),
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </div>
                          </div>

                          <div className="admin-user-stats">
                            <span>
                              <strong>{user.monthUsed}</strong>
                              <small>已用</small>
                            </span>
                            <span>
                              <strong>{user.monthlyQuota ?? "不限"}</strong>
                              <small>限额</small>
                            </span>
                            <span>
                              <strong>{user.groupName ?? "无分组"}</strong>
                              <small>当前分组</small>
                            </span>
                            <span>
                              <strong>{new Date(user.createdAt).toLocaleDateString("zh-CN")}</strong>
                              <small>注册时间</small>
                            </span>
                          </div>

                          <div className="admin-user-actions">
                            <button
                              className="button"
                              type="button"
                              onClick={() => saveUser(user)}
                              disabled={accountsSaving}
                            >
                              <Save size={16} aria-hidden="true" />
                              保存
                            </button>
                            <button
                              className="button"
                              type="button"
                              onClick={() => setUserStatus(user, user.status === "active" ? "disabled" : "active")}
                              disabled={accountsSaving || isSelf}
                            >
                              {user.status === "active" ? (
                                <UserX size={16} aria-hidden="true" />
                              ) : (
                                <UserCheck size={16} aria-hidden="true" />
                              )}
                              {user.status === "active" ? "禁用" : "启用"}
                            </button>
                            <button
                              className="button danger"
                              type="button"
                              onClick={() => deleteUserAccount(user)}
                              disabled={accountsSaving || isSelf}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                              删除
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {filteredUsers.length === 0 ? (
                    <div className="empty-state compact">
                      <div>
                        <strong>没有匹配账号</strong>
                        <span>换个关键词或状态筛选再试。</span>
                      </div>
                    </div>
                  ) : null}
                  <div className="toast-line">{accountMessage}</div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>站点与模型配置</h2>
              </div>
              {isOpenAIOAuthProvider ? (
                <span className="badge">
                  <KeyRound size={13} aria-hidden="true" />
                  OAuth 模式
                </span>
              ) : (
                <span className={clsx("badge", settings?.sub2apiApiKeyConfigured ? "success" : "danger")}>
                  <KeyRound size={13} aria-hidden="true" />
                  {settings?.sub2apiApiKeyConfigured ? "API Key 已配置" : "API Key 未配置"}
                </span>
              )}
            </div>
            <div className="panel-body form-stack">
              <div className="field-row">
                <div className="field">
                  <label htmlFor="siteTitle">站点标题</label>
                  <input
                    id="siteTitle"
                    className="input"
                    value={siteTitle}
                    onChange={(event) => setSiteTitle(event.target.value)}
                    placeholder="Canvas Realm Studio"
                  />
                </div>
                <div className="field">
                  <label htmlFor="siteSubtitle">站点副标题</label>
                  <input
                    id="siteSubtitle"
                    className="input"
                    value={siteSubtitle}
                    onChange={(event) => setSiteSubtitle(event.target.value)}
                    placeholder="image-2 workspace"
                  />
                </div>
              </div>
              <div className="field-row">
                <label className="switch-row" htmlFor="registrationEnabled">
                  <input
                    id="registrationEnabled"
                    type="checkbox"
                    checked={registrationEnabled}
                    onChange={(event) => setRegistrationEnabled(event.target.checked)}
                  />
                  <span>
                    <strong>开放注册</strong>
                  </span>
                </label>
                <div className="field">
                  <label htmlFor="registrationDefaultGroup">注册默认分组</label>
                  <select
                    id="registrationDefaultGroup"
                    className="select"
                    value={registrationDefaultGroupId}
                    onChange={(event) => setRegistrationDefaultGroupId(event.target.value)}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="registrationDefaultQuota">注册默认额度</label>
                <input
                  id="registrationDefaultQuota"
                  className="input"
                  type="number"
                  min={0}
                  value={registrationDefaultQuota}
                  onChange={(event) => setRegistrationDefaultQuota(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="imageProvider">图片接口模式</label>
                <select
                  id="imageProvider"
                  className="select"
                  value={imageProvider}
                  onChange={(event) => setImageProvider(event.target.value as ImageProvider)}
                >
                  <option value="sub2api">sub2api / OpenAI-compatible API Key</option>
                  <option value="openai_oauth">内置 OpenAI OAuth（实验性）</option>
                </select>
              </div>
              {isOpenAIOAuthProvider ? null : (
                <div className="provider-channel-section">
                  <div className="section-title-row">
                    <strong>模型渠道池</strong>
                    <button className="button subtle" type="button" onClick={addProviderChannel}>
                      <ShieldCheck size={16} aria-hidden="true" />
                      增加渠道
                    </button>
                  </div>
                  <div className="provider-channel-list">
                    {providerChannels.map((channel, index) => (
                      <article className={clsx("provider-channel-card", !channel.enabled && "disabled")} key={channel.id}>
                        <div className="provider-channel-head">
                          <label className="switch-row">
                            <input
                              type="checkbox"
                              checked={channel.enabled}
                              onChange={(event) => updateProviderChannel(channel.id, { enabled: event.target.checked })}
                            />
                            <span>
                              <strong>{channel.name || `渠道 ${index + 1}`}</strong>
                              <small>优先级 {channel.priority}</small>
                            </span>
                          </label>
                          <span className={clsx("badge", channel.apiKeyConfigured || channel.apiKey ? "success" : "danger")}>
                            {channel.apiKeyConfigured || channel.apiKey ? "Key 已配置" : "缺少 Key"}
                          </span>
                        </div>
                        <div className="provider-channel-fields">
                          <div className="field">
                            <label>渠道名称</label>
                            <input
                              className="input"
                              value={channel.name}
                              onChange={(event) => updateProviderChannel(channel.id, { name: event.target.value })}
                              placeholder="例如：主线路 / 备用线路"
                            />
                          </div>
                          <div className="field">
                            <label>优先级</label>
                            <input
                              className="input"
                              type="number"
                              min={1}
                              value={channel.priority}
                              onChange={(event) => updateProviderChannel(channel.id, { priority: Number(event.target.value) })}
                            />
                          </div>
                          <div className="field">
                            <label>Base URL</label>
                            <input
                              className="input"
                              value={channel.baseUrl}
                              onChange={(event) => {
                                updateProviderChannel(channel.id, { baseUrl: event.target.value });
                                if (index === 0) setBaseUrl(event.target.value);
                              }}
                              placeholder="https://s2a.laolin.ai/v1"
                            />
                          </div>
                          <div className="field">
                            <label>模型</label>
                            <input
                              className="input"
                              value={channel.model}
                              onChange={(event) => {
                                updateProviderChannel(channel.id, { model: event.target.value });
                                if (index === 0) setImageModel(event.target.value);
                              }}
                              placeholder="gpt-image-2"
                            />
                          </div>
                          <div className="field">
                            <label>API Key</label>
                            <input
                              className="input"
                              type="password"
                              value={channel.apiKey}
                              onChange={(event) => {
                                updateProviderChannel(channel.id, { apiKey: event.target.value });
                                if (index === 0) setApiKey(event.target.value);
                              }}
                              placeholder={channel.apiKeyConfigured ? "留空表示不修改现有密钥" : "填写后保存"}
                              autoComplete="off"
                            />
                          </div>
                        </div>
                        <div className="provider-channel-actions">
                          <button
                            className="button danger"
                            type="button"
                            onClick={() => removeProviderChannel(channel.id)}
                            disabled={providerChannels.length <= 1}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            移除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
              <div className="field">
                <label htmlFor="imageConcurrency">并发请求数</label>
                <input
                  id="imageConcurrency"
                  className="input"
                  type="number"
                  min={imageConcurrencyLimits.min}
                  max={imageConcurrencyLimits.max}
                  value={imageConcurrency}
                  onChange={(event) => setImageConcurrency(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="imageRetentionDays">图片自动删除天数</label>
                <input
                  id="imageRetentionDays"
                  className="input"
                  type="number"
                  min={0}
                  max={3650}
                  value={imageRetentionDays}
                  onChange={(event) => setImageRetentionDays(Number(event.target.value))}
                />
                <small className="field-hint">0 表示不自动删除；开启后 Worker 会定期清理超过保留天数的历史生成图。</small>
              </div>
              <div className="settings-subsection">
                <div>
                  <h3>AI 提示词优化</h3>
                </div>
                <div className="field">
                  <label htmlFor="promptOptimizerModel">提示词优化模型</label>
                  <input
                    id="promptOptimizerModel"
                    className="input"
                    value={promptOptimizerModel}
                    onChange={(event) => setPromptOptimizerModel(event.target.value)}
                    placeholder="gpt-5.5"
                  />
                  <small className="field-hint">
                    工作台“优化提示词”复用上方图片接口模式的 Base URL / API Key / OpenAI OAuth，只切换为这个文本模型。
                  </small>
                </div>
              </div>
              <button className="button primary" type="button" onClick={saveSettings} disabled={settingsSaving}>
                <Save size={16} aria-hidden="true" />
                {settingsSaving ? "保存中" : "保存配置"}
              </button>
              <div className="toast-line">{settingsMessage}</div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>OpenAI 账号连接</h2>
              </div>
              <span className="badge">实验性</span>
            </div>
            <div className="panel-body form-stack">
              <div className="field">
                <label htmlFor="openAIProxyUrl">OAuth 代理（可选）</label>
                <input
                  id="openAIProxyUrl"
                  className="input"
                  value={openAIProxyUrl}
                  onChange={(event) => setOpenAIProxyUrl(event.target.value)}
                  placeholder={
                    settings?.openaiOAuthProxyConfigured
                      ? `已配置：${settings.openaiOAuthProxyDisplay ?? "代理地址"}，留空不修改`
                      : "http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="button-row">
                <button
                  className="button"
                  type="button"
                  onClick={() => updateOpenAIProxy(openAIProxyUrl.trim())}
                  disabled={openAISaving || !openAIProxyUrl.trim()}
                >
                  <Save size={16} aria-hidden="true" />
                  保存代理
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => updateOpenAIProxy(null)}
                  disabled={openAISaving || !settings?.openaiOAuthProxyConfigured}
                >
                  清除代理
                </button>
              </div>
              <div className="section-title-row">
                <strong>已连接账号</strong>
                <button className="button" type="button" onClick={loadAccounts} disabled={openAISaving}>
                  <RefreshCw size={16} aria-hidden="true" />
                  刷新账号
                </button>
              </div>
              {openAIAccounts.length > 0 ? (
                <div className="admin-grid admin-grid-groups">
                  <div className="admin-grid-head">账号</div>
                  <div className="admin-grid-head">状态</div>
                  <div className="admin-grid-head">操作</div>
                  {openAIAccounts.map((account) => (
                    <div className="admin-grid-row" key={account.id}>
                      <div className="field compact-field">
                        <strong>{account.email ?? account.accountId ?? "OpenAI 账号"}</strong>
                        <small>
                          {account.planType ?? "未知套餐"} · token 到期 {new Date(account.expiresAt).toLocaleString()}
                        </small>
                        {account.lastError ? <small>错误：{account.lastError}</small> : null}
                      </div>
                      <span className={clsx("badge", account.status === "active" ? "success" : "danger")}>
                        {account.status === "active" ? "可用" : account.status === "disabled" ? "已禁用" : "异常"}
                      </span>
                      <button
                        className="button"
                        type="button"
                        onClick={() => setOpenAIAccountStatus(account, account.status === "active" ? "disabled" : "active")}
                        disabled={openAISaving}
                      >
                        {account.status === "active" ? "禁用" : "启用"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span>还没有连接 OpenAI 账号</span>
                </div>
              )}
              <button className="button primary" type="button" onClick={connectOpenAIAccount} disabled={openAISaving}>
                <KeyRound size={16} aria-hidden="true" />
                {openAISaving ? "处理中" : "连接 OpenAI 账号"}
              </button>
              {pendingOpenAIAuthUrl ? (
                <div className="oauth-callback-panel">
                  <div className="section-title-row">
                    <strong>完成授权</strong>
                    <a className="button" href={pendingOpenAIAuthUrl} target="_blank" rel="noreferrer">
                      打开备用授权链接
                    </a>
                  </div>
                  <textarea
                    className="textarea oauth-callback-input"
                    value={openAICallbackInput}
                    onChange={(event) => setOpenAICallbackInput(event.target.value)}
                    placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                  />
                  <button
                    className="button primary"
                    type="button"
                    onClick={completeOpenAIAccountAuth}
                    disabled={openAISaving || !openAICallbackInput.trim()}
                  >
                    <ShieldCheck size={16} aria-hidden="true" />
                    完成连接
                  </button>
                </div>
              ) : null}
              <div className="toast-line">{openAIMessage}</div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>热门模板</h2>
              </div>
            </div>
            <div className="panel-body popular-list">
              {displayStats.popularTemplates.length > 0 ? (
                displayStats.popularTemplates.map((template) => (
                  <div className="popular-row" key={template.templateId}>
                    <strong>{template.name}</strong>
                    <span className="badge">{template.count} 次</span>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <span>暂无模板使用数据</span>
                </div>
              )}
            </div>
          </section>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>高频错误</h2>
              </div>
            </div>
            <div className="panel-body popular-list">
              {displayStats.topErrors.length > 0 ? (
                displayStats.topErrors.map((item) => (
                  <div className="popular-row" key={item.message}>
                    <strong>{item.message}</strong>
                    <span className="badge danger">{item.count} 次</span>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <span>暂无失败数据</span>
                </div>
              )}
            </div>
          </section>

          <section className="panel" style={{ marginTop: "1rem" }}>
            <div className="panel-header">
              <div>
                <h2>账号与分组消耗</h2>
              </div>
              <span className="badge">本周 / 本月</span>
            </div>
            <div className="panel-body popular-list">
              {displayStats.userSuccessRanking.length > 0 ? (
                displayStats.userSuccessRanking.map((user) => (
                  <div className="popular-row" key={user.userId ?? "anonymous"}>
                    <strong>{user.name}</strong>
                    <span className="badge">{user.succeededTasks}/{user.totalTasks} · {user.successRate}%</span>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <span>暂无账号生成数据</span>
                </div>
              )}
              {displayStats.groupUsage.map((group) => (
                <div className="popular-row" key={group.groupId ?? "ungrouped"}>
                  <strong>{group.name}</strong>
                  <span className="badge">{group.used}/{group.quota ?? "不限"}</span>
                </div>
              ))}
            </div>
          </section>
        </>
    </>
  );
}

function getQueryParam(rawUrl: string, key: string): string {
  try {
    return new URL(rawUrl).searchParams.get(key) ?? "";
  } catch {
    const match = rawUrl.match(new RegExp(`[?&]${key}=([^&#]+)`));
    if (!match?.[1]) {
      return "";
    }
    try {
      return decodeURIComponent(match[1].replaceAll("+", "%20"));
    } catch {
      return match[1];
    }
  }
}

function StatCard({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <article className="stat-card">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </article>
  );
}
