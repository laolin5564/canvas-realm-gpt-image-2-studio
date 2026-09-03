"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import clsx from "clsx";
import { copyTextToClipboard } from "@/components/client-api";
import {
  apiEndpoints,
  apiQuantityOptions,
  authHeaderExample,
  authNotes,
  docSections,
  endpointAuthLabels,
  errorBodyExample,
  errorCodes,
  languageSamples,
  limitRows,
  paramNotes,
  qualityRows,
  quickStartSamples,
  sizeRows,
  withOrigin,
} from "./api-docs-content";

interface ApiDocsProps {
  origin: string;
  onNotice: (message: string, tone?: "info" | "error") => void;
}

interface CodeBlockProps {
  id: string;
  label: string;
  code: string;
  copied: boolean;
  onCopy: (id: string, code: string) => void;
}

function CodeBlock({ id, label, code, copied, onCopy }: CodeBlockProps) {
  return (
    <div className="developer-code">
      <div className="developer-code-head">
        <span>{label}</span>
        <button className="button subtle developer-code-copy" type="button" onClick={() => onCopy(id, code)}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ApiDocs({ origin, onNotice }: ApiDocsProps) {
  const [copiedId, setCopiedId] = useState("");

  async function copyCode(id: string, code: string): Promise<void> {
    try {
      await copyTextToClipboard(code);
      setCopiedId(id);
      onNotice("示例已复制到剪贴板。");
      window.setTimeout(() => setCopiedId((current) => (current === id ? "" : current)), 2000);
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : "复制失败，请手动选中复制。", "error");
    }
  }

  return (
    <section className="developer-docs">
      <nav className="developer-doc-nav" aria-label="文档目录">
        <span className="developer-doc-nav-title">接口文档</span>
        {docSections.map((section) => (
          <a key={section.id} className="developer-doc-nav-link" href={`#${section.id}`}>
            {section.title}
          </a>
        ))}
      </nav>

      <div className="developer-doc-body">
        <section className="panel developer-section" id="auth">
          <div className="panel-header">
            <div>
              <h2>鉴权方式</h2>
              <p>一把密钥等同一个账号，请只在服务端使用。</p>
            </div>
          </div>
          <div className="panel-body">
            <ul className="developer-list">
              {authNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <CodeBlock
              id="auth-header"
              label="请求头"
              code={authHeaderExample}
              copied={copiedId === "auth-header"}
              onCopy={copyCode}
            />
          </div>
        </section>

        <section className="panel developer-section" id="quickstart">
          <div className="panel-header">
            <div>
              <h2>快速开始</h2>
              <p>同步一步拿图，或者创建任务后自行轮询。</p>
            </div>
          </div>
          <div className="panel-body developer-stack">
            {quickStartSamples.map((sample) => (
              <CodeBlock
                key={sample.id}
                id={sample.id}
                label={sample.label}
                code={withOrigin(sample.code, origin)}
                copied={copiedId === sample.id}
                onCopy={copyCode}
              />
            ))}
          </div>
        </section>

        <section className="panel developer-section" id="endpoints">
          <div className="panel-header">
            <div>
              <h2>接口列表</h2>
              <p>密钥管理走登录态，图片生成走 Bearer 密钥。</p>
            </div>
          </div>
          <div className="panel-body developer-stack">
            {apiEndpoints.map((endpoint) => (
              <article className="developer-endpoint" key={endpoint.id}>
                <div className="developer-endpoint-head">
                  <span className={clsx("developer-method", endpoint.method.toLowerCase())}>{endpoint.method}</span>
                  <code className="developer-endpoint-path">{endpoint.path}</code>
                  <span className="badge neutral">{endpointAuthLabels[endpoint.auth]}</span>
                </div>
                <h3>{endpoint.title}</h3>
                <p className="developer-endpoint-summary">{endpoint.summary}</p>
                {endpoint.notes.length ? (
                  <ul className="developer-list">
                    {endpoint.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                {endpoint.requestExample ? (
                  <CodeBlock
                    id={`${endpoint.id}-request`}
                    label={endpoint.requestLabel}
                    code={withOrigin(endpoint.requestExample, origin)}
                    copied={copiedId === `${endpoint.id}-request`}
                    onCopy={copyCode}
                  />
                ) : null}
                {endpoint.responseExample ? (
                  <CodeBlock
                    id={`${endpoint.id}-response`}
                    label={endpoint.responseLabel}
                    code={withOrigin(endpoint.responseExample, origin)}
                    copied={copiedId === `${endpoint.id}-response`}
                    onCopy={copyCode}
                  />
                ) : null}
                {endpoint.responseNote ? <p className="developer-endpoint-note">{endpoint.responseNote}</p> : null}
              </article>
            ))}
          </div>
        </section>

        <section className="panel developer-section" id="sizes">
          <div className="panel-header">
            <div>
              <h2>尺寸选项</h2>
              <p>size 传下表的选项键，不要直接传像素串。</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="admin-table-wrap">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>选项键</th>
                    <th>用途</th>
                    <th>输出像素</th>
                  </tr>
                </thead>
                <tbody>
                  {sizeRows.map((row) => (
                    <tr key={row.option}>
                      <td>
                        <code className="developer-inline-code">{row.option}</code>
                      </td>
                      <td>{row.label}</td>
                      <td>{row.pixels}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="panel developer-section" id="params">
          <div className="panel-header">
            <div>
              <h2>质量与数量</h2>
              <p>quality 默认 high，n 默认 1。</p>
            </div>
          </div>
          <div className="panel-body developer-stack">
            <div className="admin-table-wrap">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>quality 取值</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {qualityRows.map((row) => (
                    <tr key={row.option}>
                      <td>
                        <code className="developer-inline-code">{row.option}</code>
                      </td>
                      <td>{row.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="developer-endpoint-note">
              n 可选值：
              {apiQuantityOptions.map((value) => (
                <code className="developer-inline-code" key={value}>
                  {value}
                </code>
              ))}
            </p>
            <ul className="developer-list">
              {paramNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel developer-section" id="errors">
          <div className="panel-header">
            <div>
              <h2>错误码</h2>
              <p>所有失败响应共用同一个错误体结构。</p>
            </div>
          </div>
          <div className="panel-body developer-stack">
            <CodeBlock
              id="error-body"
              label="错误响应体"
              code={errorBodyExample}
              copied={copiedId === "error-body"}
              onCopy={copyCode}
            />
            <div className="admin-table-wrap">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>code</th>
                    <th>HTTP</th>
                    <th>含义</th>
                  </tr>
                </thead>
                <tbody>
                  {errorCodes.map((row) => (
                    <tr key={row.code}>
                      <td>
                        <code className="developer-inline-code">{row.code}</code>
                      </td>
                      <td>{row.status}</td>
                      <td>{row.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="panel developer-section" id="limits">
          <div className="panel-header">
            <div>
              <h2>使用限制</h2>
              <p>额度和网页端共用一份，别把并发拉满。</p>
            </div>
          </div>
          <div className="panel-body">
            <dl className="developer-limit-list">
              {limitRows.map((row) => (
                <div className="developer-limit-item" key={row.title}>
                  <dt>{row.title}</dt>
                  <dd>{row.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="panel developer-section" id="samples">
          <div className="panel-header">
            <div>
              <h2>代码示例</h2>
              <p>把密钥放进环境变量 HUAJING_API_KEY 再运行。</p>
            </div>
          </div>
          <div className="panel-body developer-stack">
            {languageSamples.map((sample) => (
              <CodeBlock
                key={sample.id}
                id={sample.id}
                label={sample.label}
                code={withOrigin(sample.code, origin)}
                copied={copiedId === sample.id}
                onCopy={copyCode}
              />
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
