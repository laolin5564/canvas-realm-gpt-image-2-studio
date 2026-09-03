import Link from "next/link";
import type { ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Database,
  KeyRound,
  Settings,
  Shield,
  SlidersHorizontal,
  Ticket,
  Users,
} from "lucide-react";
import clsx from "clsx";

export type AdminSection = "overview" | "users" | "groups" | "discounts" | "models" | "history" | "settings";

const adminNavItems: Array<{
  section: AdminSection;
  href: string;
  label: string;
  description: string;
  icon: typeof BarChart3;
}> = [
  { section: "overview", href: "/admin", label: "总览", description: "系统健康和关键指标", icon: BarChart3 },
  { section: "users", href: "/admin/users", label: "账号管理", description: "搜索、筛选、批量管理用户", icon: Users },
  { section: "groups", href: "/admin/groups", label: "分组与额度", description: "用户策略和额度池", icon: Shield },
  { section: "discounts", href: "/admin/discounts", label: "折扣码", description: "购买次数的折扣与赠送规则", icon: Ticket },
  { section: "models", href: "/admin/models", label: "模型与接口", description: "渠道、并发和 OAuth", icon: KeyRound },
  { section: "history", href: "/admin/history", label: "历史与素材", description: "生成记录和清理策略", icon: Database },
  { section: "settings", href: "/admin/settings", label: "站点设置", description: "注册、标题和系统设置", icon: Settings },
];

export function AdminShell({
  active,
  title,
  description,
  actions,
  children,
}: Readonly<{
  active: AdminSection;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <section className="admin-console">
      <aside className="admin-console-sidebar" aria-label="管理员后台导航">
        <div className="admin-console-brand">
          <span>
            <SlidersHorizontal size={18} aria-hidden="true" />
          </span>
          <div>
            <strong>运营控制台</strong>
            <small>Admin workspace</small>
          </div>
        </div>
        <nav className="admin-console-nav">
          {adminNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className={clsx("admin-console-link", active === item.section && "active")}>
                <Icon size={17} aria-hidden="true" />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="admin-console-note">
          <Activity size={16} aria-hidden="true" />
          <span>面向大规模账号、模型稳定性和运营数据设计。</span>
        </div>
      </aside>

      <div className="admin-console-main">
        <section className="admin-console-heading">
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {actions ? <div className="admin-console-actions">{actions}</div> : null}
        </section>
        {children}
      </div>
    </section>
  );
}
