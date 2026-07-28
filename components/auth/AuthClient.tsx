"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { LogIn, QrCode, RefreshCw, Sparkles, UserPlus } from "lucide-react";
import clsx from "clsx";
import { apiJson } from "@/components/client-api";
import type { CurrentUser } from "@/lib/types";

type AuthMode = "login" | "register";

interface AuthResponse {
  user: CurrentUser | null;
}

interface SiteSettingsResponse {
  settings: {
    registrationEnabled: boolean;
  };
}

interface QrLoginResponse {
  imageUrl: string;
  webCode: string;
}

interface QrLoginStatusResponse {
  login: boolean;
  state: number | string;
  user?: CurrentUser;
}

export function AuthClient() {
  const searchParams = useSearchParams();
  const initialMode = useMemo<AuthMode>(
    () => (searchParams.get("mode") === "register" ? "register" : "login"),
    [searchParams],
  );
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrCode, setQrCode] = useState<QrLoginResponse | null>(null);
  const formReady = account.trim() && password;

  useEffect(() => {
    setMode(registrationEnabled ? initialMode : "login");
  }, [initialMode, registrationEnabled]);

  useEffect(() => {
    apiJson<SiteSettingsResponse>("/api/site-settings")
      .then((payload) => {
        setRegistrationEnabled(payload.settings.registrationEnabled);
      })
      .catch(() => undefined);

    apiJson<AuthResponse>("/api/auth/me")
      .then((payload) => {
        if (payload.user) {
          window.location.href = "/";
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode === "register" && registrationEnabled) {
      void loadQrCode();
    }
  }, [mode, registrationEnabled]);

  useEffect(() => {
    if (mode !== "register" || !qrCode?.webCode) {
      return;
    }

    const timer = window.setInterval(() => {
      void pollQrStatus(qrCode.webCode);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [mode, qrCode?.webCode]);

  async function loadQrCode(): Promise<void> {
    setError("");
    setMessage("请使用微信扫描二维码，确认后会自动登录。");
    setQrLoading(true);
    try {
      const payload = await apiJson<QrLoginResponse>("/api/auth/qr-login");
      setQrCode(payload);
    } catch (caught) {
      setQrCode(null);
      setError(caught instanceof Error ? caught.message : "二维码获取失败");
    } finally {
      setQrLoading(false);
    }
  }

  async function pollQrStatus(webCode: string): Promise<void> {
    try {
      const payload = await apiJson<QrLoginStatusResponse>("/api/auth/qr-login", {
        method: "POST",
        body: JSON.stringify({ webCode }),
      });
      if (payload.login) {
        setMessage("扫码成功，正在进入工作台...");
        window.location.href = "/";
        return;
      }
      setMessage(qrStatusText(payload.state));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "二维码状态检查失败");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (mode !== "login") {
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await apiJson<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ name: account, password }),
      });
      window.location.href = "/";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "认证失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-layout">
      <div className="auth-copy">
        <span className="badge">
          <Sparkles size={13} aria-hidden="true" />
          image-2 workspace
        </span>
        <h1>进入生成工作台</h1>
        <p>
          {registrationEnabled
            ? "登录注册已接入老林云账号体系。已有账号可用密码登录，新用户直接微信扫码注册并自动进入工作台。"
            : "当前站点未开放扫码注册，请使用老林云账号登录。"}
        </p>
      </div>

      <form className="panel auth-card" onSubmit={submit}>
        <div className="panel-header">
          <div>
            <h2>{mode === "login" ? "账号登录" : "扫码注册 / 登录"}</h2>
            <p>{mode === "login" ? "使用老林云账号或手机号和密码进入系统" : "微信扫码后会自动创建或绑定账号"}</p>
          </div>
        </div>
        <div className="panel-body form-stack">
          <div className={clsx("segmented auth-tabs", !registrationEnabled && "single")}>
            <button
              type="button"
              className={clsx(mode === "login" && "active")}
              onClick={() => setMode("login")}
            >
              <LogIn size={16} aria-hidden="true" />
              密码登录
            </button>
            {registrationEnabled ? (
              <button
                type="button"
                className={clsx(mode === "register" && "active")}
                onClick={() => setMode("register")}
              >
                <UserPlus size={16} aria-hidden="true" />
                扫码注册
              </button>
            ) : null}
          </div>

          {mode === "login" ? (
            <>
              <div className="field">
                <label htmlFor="account">账号或手机号</label>
                <input
                  id="account"
                  className="input"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  autoComplete="username"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="password">密码</label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>

              <button className="button primary" type="submit" disabled={busy || !formReady}>
                <LogIn size={16} aria-hidden="true" />
                {busy ? "登录中" : "登录"}
              </button>
            </>
          ) : (
            <div className="auth-qr-panel">
              <div className="auth-qr-box">
                {qrCode ? (
                  <img src={qrImageSrc(qrCode.imageUrl)} alt="老林云微信扫码登录二维码" />
                ) : (
                  <QrCode size={76} aria-hidden="true" />
                )}
              </div>
              <button className="button subtle" type="button" onClick={loadQrCode} disabled={qrLoading}>
                <RefreshCw size={16} aria-hidden="true" />
                {qrLoading ? "刷新中" : "刷新二维码"}
              </button>
            </div>
          )}

          <div className={clsx("toast-line", error && "error")}>{error || message}</div>
        </div>
      </form>
    </section>
  );
}

function qrImageSrc(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return `https://www.laolinyun.cn/api/qrcode.php?url=${encodeURIComponent(value)}`;
  }
  return value;
}

function qrStatusText(state: number | string): string {
  if (Number(state) === 2) {
    return "已扫码，请在微信中确认登录。";
  }
  return "请使用微信扫描二维码，确认后会自动登录。";
}
