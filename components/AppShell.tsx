"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  GalleryHorizontalEnd,
  History,
  Images,
  LayoutTemplate,
  LogIn,
  LogOut,
  MousePointer2,
  Sparkles,
  UserPlus,
} from "lucide-react";
import clsx from "clsx";
import { apiJson } from "@/components/client-api";
import type { CurrentUser } from "@/lib/types";

interface SiteSettings {
  siteTitle: string;
  siteSubtitle: string;
  registrationEnabled: boolean;
}

interface AuthResponse {
  user: CurrentUser | null;
}

interface SiteSettingsResponse {
  settings: SiteSettings;
}

const navItems = [
  { href: "/", label: "生成工作台", icon: Sparkles },
  { href: "/history", label: "历史记录", icon: History },
  { href: "/canvas", label: "画布", icon: MousePointer2 },
  { href: "/cases", label: "案例中心", icon: Images },
  { href: "/templates", label: "模板管理", icon: LayoutTemplate },
  { href: "/admin", label: "管理员后台", icon: BarChart3 },
];

const quotaRefreshEventName = "aiimage:quota-updated";

export function AppShell({
  children,
  initialSiteSettings,
}: Readonly<{ children: React.ReactNode; initialSiteSettings: SiteSettings }>) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [siteSettings, setSiteSettings] = useState(initialSiteSettings);

  useEffect(() => {
    document.title = siteSettings.siteTitle;
  }, [siteSettings.siteTitle]);

  useEffect(() => {
    const refreshAuth = () => {
      apiJson<AuthResponse>("/api/auth/me")
        .then((payload) => setUser(payload.user))
        .catch(() => setUser(null))
        .finally(() => setAuthLoaded(true));
    };

    refreshAuth();
    window.addEventListener(quotaRefreshEventName, refreshAuth);

    apiJson<SiteSettingsResponse>("/api/site-settings")
      .then((payload) => setSiteSettings(payload.settings))
      .catch(() => undefined);

    return () => window.removeEventListener(quotaRefreshEventName, refreshAuth);
  }, []);

  useEffect(() => {
    if (!authLoaded || user || pathname === "/login") {
      return;
    }
    router.replace("/login");
  }, [authLoaded, pathname, router, user]);

  async function logout(): Promise<void> {
    await apiJson("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    window.location.href = "/login";
  }

  const visibleNavItems = navItems.filter((item) => item.href !== "/admin" || user?.role === "admin");

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="返回生成工作台">
          <span className="brand-mark">
            <GalleryHorizontalEnd size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{siteSettings.siteTitle}</strong>
            <small>{siteSettings.siteSubtitle}</small>
          </span>
        </Link>

        <div className="topbar-actions">
          {user ? (
            <nav className="main-nav" aria-label="主导航">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link key={item.href} href={item.href} className={clsx("nav-link", active && "active")}>
                    <Icon size={16} aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          ) : (
            <nav className="main-nav" aria-label="认证导航">
              <Link href="/login" className={clsx("nav-link", pathname === "/login" && "active")}>
                <LogIn size={16} aria-hidden="true" />
                <span>登录</span>
              </Link>
              {siteSettings.registrationEnabled ? (
                <Link href="/login?mode=register" className="nav-link">
                  <UserPlus size={16} aria-hidden="true" />
                  <span>注册</span>
                </Link>
              ) : null}
            </nav>
          )}

          {user ? (
            <button className="nav-link account-button" type="button" onClick={logout}>
              <span>{user.name}</span>
              <span className="badge">{user.monthUsed}/{user.monthlyQuota ?? "不限"}</span>
              <LogOut size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      <main className="main-content">{authLoaded && (user || pathname === "/login") ? children : null}</main>
    </div>
  );
}
