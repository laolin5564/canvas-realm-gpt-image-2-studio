"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock,
  DollarSign,
  Gauge,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import clsx from "clsx";
import type { AdminStats, ChannelAttemptStats } from "@/lib/types";
import { apiJson } from "@/components/client-api";
import { AdminShell } from "./AdminShell";

interface StatsResponse {
  stats: AdminStats;
}

const emptyStats: AdminStats = {
  today: { totalTasks: 0, succeededTasks: 0, failedTasks: 0, totalImages: 0, estimatedCost: 0 },
  week: { totalTasks: 0, succeededTasks: 0, failedTasks: 0, totalImages: 0, estimatedCost: 0 },
  popularTemplates: [],
  health: {
    provider: "sub2api",
    baseUrl: "未配置",
    imageModel: "未配置",
    imageConcurrency: 1,
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

type ChannelHealthWindow = "last24h" | "last7d";

// 数字列对齐：globals.css 里没有通用的 tabular-nums 工具类，这里就近内联。
const numericCellStyle: CSSProperties = { fontVariantNumeric: "tabular-nums" };

function formatDurationMs(value: number): string {
  if (value <= 0) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

export function AdminOverviewClient() {
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [channelWindow, setChannelWindow] = useState<ChannelHealthWindow>("last24h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  useEffect(() => {
    void loadStats();
  }, []);

  return (
    <AdminShell
      active="overview"
      title="管理员后台"
      description="把系统健康、用户运营、模型稳定性和更新状态放在一个控制台里。"
      actions={
        <button className="button" type="button" onClick={loadStats} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? "刷新中" : "刷新"}
        </button>
      }
    >
      {error ? <div className="toast-line error">{error}</div> : null}

      <section className="stats-grid">
        <StatCard label="今日生成次数" value={stats.today.totalTasks} icon={<BarChart3 size={18} />} />
        <StatCard label="本周生成次数" value={stats.week.totalTasks} icon={<TrendingUp size={18} />} />
        <StatCard label="成功 / 失败" value={`${stats.week.succeededTasks} / ${stats.week.failedTasks}`} icon={<BarChart3 size={18} />} />
        <StatCard label="本周预估成本" value={`$${stats.week.estimatedCost.toFixed(2)}`} icon={<DollarSign size={18} />} />
        <StatCard label="模型可用率" value={`${stats.health.availabilityRate}%`} icon={<Activity size={18} />} />
        <StatCard label="平均耗时" value={stats.health.averageDurationSeconds === null ? "暂无" : `${stats.health.averageDurationSeconds}s`} icon={<Clock size={18} />} />
        <StatCard label="本周超时任务" value={stats.health.weekTimeoutTasks} icon={<AlertTriangle size={18} />} />
        <StatCard label="当前并发" value={stats.health.imageConcurrency} icon={<Gauge size={18} />} />
      </section>

      <section className="admin-command-grid">
        <Link className="admin-command-card" href="/admin/users">
          <Users size={20} aria-hidden="true" />
          <strong>管理账号</strong>
          <span>分页、搜索、筛选、批量禁用和调整额度。</span>
        </Link>
        <Link className="admin-command-card" href="/admin/groups">
          <Gauge size={20} aria-hidden="true" />
          <strong>调整分组策略</strong>
          <span>按分组控制额度、查看成员数和本月消耗。</span>
        </Link>
        <Link className="admin-command-card" href="/admin/models">
          <Activity size={20} aria-hidden="true" />
          <strong>检查模型稳定性</strong>
          <span>查看渠道、并发、OAuth 账号和失败状态。</span>
        </Link>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>生成链路健康</h2>
            <p>按渠道统计每次上游 n=1 请求的结果，看清是哪个渠道在拖后腿。</p>
          </div>
          <div className="segmented two" style={{ maxWidth: "16rem" }}>
            <button
              type="button"
              className={clsx(channelWindow === "last24h" && "active")}
              onClick={() => setChannelWindow("last24h")}
            >
              近 24 小时
            </button>
            <button
              type="button"
              className={clsx(channelWindow === "last7d" && "active")}
              onClick={() => setChannelWindow("last7d")}
            >
              近 7 天
            </button>
          </div>
        </div>
        <div className="panel-body">
          <ChannelHealthTable rows={stats.channelHealth[channelWindow]} />
        </div>
      </section>

      <div className="admin-dashboard-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>模型健康</h2>
            </div>
            <span className={clsx("badge", stats.health.timeoutStreak > 0 ? "warning" : "success")}>
              连续超时 {stats.health.timeoutStreak}
            </span>
          </div>
          <div className="panel-body popular-list">
            <div className="popular-row">
              <strong>接口模式</strong>
              <span className="badge">{stats.health.provider === "openai_oauth" ? "内置 OAuth" : "API Key"}</span>
            </div>
            <div className="popular-row">
              <strong>Base URL</strong>
              <span>{stats.health.baseUrl}</span>
            </div>
            <div className="popular-row">
              <strong>模型</strong>
              <span>{stats.health.imageModel}</span>
            </div>
            <div className="popular-row">
              <strong>上游并发上限</strong>
              <span className="badge" style={numericCellStyle}>
                IMAGE_UPSTREAM_MAX_INFLIGHT {stats.health.upstreamMaxInflight}
              </span>
            </div>
            <div className="popular-row">
              <strong>失败率</strong>
              <span className={clsx("badge", stats.health.failureRate > 20 ? "danger" : stats.health.failureRate > 0 ? "warning" : "success")}>
                {stats.health.failureRate}%
              </span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>账号与分组消耗</h2>
            </div>
            <span className="badge">本周 / 本月</span>
          </div>
          <div className="panel-body popular-list">
            {stats.userSuccessRanking.length > 0 ? (
              stats.userSuccessRanking.map((user) => (
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
            {stats.groupUsage.map((group) => (
              <div className="popular-row" key={group.groupId ?? "ungrouped"}>
                <strong>{group.name}</strong>
                <span className="badge">{group.used}/{group.quota ?? "不限"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function ChannelHealthTable({ rows }: { rows: ChannelAttemptStats[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <span>
          <strong>暂无上游调用记录</strong>
          该时间窗口内还没有发起过生成请求。
        </span>
      </div>
    );
  }

  return (
    <div className="admin-table-wrap">
      <table className="admin-data-table">
        <thead>
          <tr>
            <th>渠道</th>
            <th>请求数</th>
            <th>成功率</th>
            <th>p50 耗时</th>
            <th>p95 耗时</th>
            <th>最近失败原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.channelId}>
              <td>
                <div className="table-stack">
                  <strong>{row.channelName}</strong>
                  <small>{row.channelId}</small>
                </div>
              </td>
              <td style={numericCellStyle}>
                <div className="table-stack">
                  <strong>{row.total}</strong>
                  <small>成功 {row.succeeded} · 失败 {row.failed}</small>
                </div>
              </td>
              <td style={numericCellStyle}>
                <span
                  className={clsx(
                    "badge",
                    row.successRate >= 95 ? "success" : row.successRate >= 80 ? "warning" : "danger",
                  )}
                  style={numericCellStyle}
                >
                  {row.successRate}%
                </span>
              </td>
              <td style={numericCellStyle}>{formatDurationMs(row.p50DurationMs)}</td>
              <td style={numericCellStyle}>{formatDurationMs(row.p95DurationMs)}</td>
              <td>
                {row.topErrors.length === 0 ? (
                  <span className="badge success">无失败</span>
                ) : (
                  <div className="table-stack">
                    {row.topErrors.map((failure) => (
                      <small key={failure.message}>
                        <span style={numericCellStyle}>×{failure.count}</span> {failure.message}
                      </small>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string | number; icon: ReactNode }) {
  return (
    <div className="stat-card">
      <span>{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
