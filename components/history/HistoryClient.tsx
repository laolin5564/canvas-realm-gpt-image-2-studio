"use client";

/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import clsx from "clsx";
import { sizeFromDimensions } from "@/lib/image-options";
import type { CurrentUser, GenerationMode, PublicImage, PublicTemplate } from "@/lib/types";
import { apiJson, categoryLabels, copyTextToClipboard, formatDateTime, modeLabels } from "@/components/client-api";
import { handleImgError, useImageDirectBase, withDirectBase } from "@/components/image-src";
import { ImageLightbox } from "@/components/ImageLightbox";

interface ImageListResponse {
  images: PublicImage[];
  nextCursor?: string | null;
}

interface TemplateListResponse {
  templates: PublicTemplate[];
}

interface MeResponse {
  user: CurrentUser | null;
}

const allModes = ["", "text_to_image", "image_to_image"] as const;
const historyPageSize = 30;
const keywordDebounceMs = 300;

function mergeImages(current: PublicImage[], incoming: PublicImage[]): PublicImage[] {
  const seen = new Set(current.map((image) => image.id));
  return [...current, ...incoming.filter((image) => !seen.has(image.id))];
}

export function HistoryClient({ embedded = false }: { embedded?: boolean } = {}) {
  const imageDirectBase = useImageDirectBase();
  const [keyword, setKeyword] = useState("");
  const [activeKeyword, setActiveKeyword] = useState("");
  const [mode, setMode] = useState<(typeof allModes)[number]>("");
  const [templateId, setTemplateId] = useState("");
  const [images, setImages] = useState<PublicImage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PublicTemplate[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  // 请求序号：只接受最新一次请求的响应，旧响应（例如搜索时的乱序返回）直接丢弃。
  const requestSeqRef = useRef(0);

  const templateMap = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );

  const fetchImages = useCallback(
    async (cursor: string | null): Promise<void> => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError("");

      try {
        const params = new URLSearchParams({ pageSize: String(historyPageSize) });
        if (activeKeyword) {
          params.set("keyword", activeKeyword);
        }
        if (mode) {
          params.set("mode", mode);
        }
        if (templateId) {
          params.set("templateId", templateId);
        }
        if (cursor) {
          params.set("cursor", cursor);
        }

        const payload = await apiJson<ImageListResponse>(`/api/images?${params.toString()}`);
        if (seq !== requestSeqRef.current) {
          return;
        }

        // 搜索/刷新期间保留旧结果，直到新结果返回才整体替换；翻页则按 id 去重后追加。
        setImages((current) => (cursor ? mergeImages(current, payload.images) : payload.images));
        setNextCursor(payload.nextCursor ?? null);
        if (!cursor) {
          const keptIds = new Set(payload.images.map((image) => image.id));
          setSelectedIds((current) => current.filter((id) => keptIds.has(id)));
        }
      } catch (caught) {
        if (seq !== requestSeqRef.current) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "历史记录加载失败");
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
          setInitialized(true);
        }
      }
    },
    [activeKeyword, mode, templateId],
  );

  useEffect(() => {
    Promise.all([
      apiJson<TemplateListResponse>("/api/templates"),
      apiJson<MeResponse>("/api/auth/me"),
    ])
      .then(([templatesPayload, mePayload]) => {
        setTemplates(templatesPayload.templates);
        setCurrentUser(mePayload.user);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  // 关键词输入防抖 300ms，避免每个按键都打一次接口。
  useEffect(() => {
    const trimmed = keyword.trim();
    if (trimmed === activeKeyword) {
      return;
    }
    const timer = window.setTimeout(() => setActiveKeyword(trimmed), keywordDebounceMs);
    return () => window.clearTimeout(timer);
  }, [keyword, activeKeyword]);

  useEffect(() => {
    void fetchImages(null);
  }, [fetchImages]);

  useEffect(() => {
    setLightboxIndex((current) => {
      if (current === null) {
        return null;
      }
      if (images.length === 0) {
        return null;
      }
      return Math.min(current, images.length - 1);
    });
  }, [images]);

  const refresh = useCallback((): void => {
    const trimmed = keyword.trim();
    if (trimmed !== activeKeyword) {
      // 跳过防抖直接生效，加载由依赖 activeKeyword 的 effect 触发，避免打两次接口。
      setActiveKeyword(trimmed);
      return;
    }
    void fetchImages(null);
  }, [activeKeyword, fetchImages, keyword]);

  const navigateLightbox = useCallback(
    (delta: number): void => {
      setLightboxIndex((current) => {
        if (current === null || images.length === 0) {
          return current;
        }
        return (current + delta + images.length) % images.length;
      });
    },
    [images.length],
  );

  const loadMore = useCallback((): void => {
    if (!nextCursor) {
      return;
    }
    void fetchImages(nextCursor);
  }, [fetchImages, nextCursor]);

  async function copyPrompt(value: string): Promise<void> {
    try {
      await copyTextToClipboard(value);
      setMessage("prompt 已复制。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复制失败，请手动复制。");
    }
  }

  const hasFilters = Boolean(activeKeyword || mode || templateId);
  const selectedCount = selectedIds.length;
  const showImageOwner = currentUser?.role === "admin";
  const showGrid = images.length > 0;
  const showInitialLoading = !initialized && loading;

  function toggleImageSelection(imageId: string): void {
    setSelectionMode(true);
    setSelectedIds((current) =>
      current.includes(imageId) ? current.filter((id) => id !== imageId) : [...current, imageId],
    );
  }

  function cancelSelection(): void {
    setSelectionMode(false);
    setSelectedIds([]);
  }

  async function deleteImages(imageIds: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(imageIds));
    if (uniqueIds.length === 0) {
      return;
    }
    const ok = window.confirm(uniqueIds.length === 1 ? "确定删除这张历史图片吗？" : `确定删除选中的 ${uniqueIds.length} 张历史图片吗？`);
    if (!ok) {
      return;
    }
    setError("");
    setMessage("");

    try {
      if (uniqueIds.length === 1) {
        await apiJson(`/api/images/${uniqueIds[0]}`, { method: "DELETE" });
      } else {
        await apiJson("/api/images", {
          method: "DELETE",
          body: JSON.stringify({ imageIds: uniqueIds }),
        });
      }
      setImages((current) => current.filter((image) => !uniqueIds.includes(image.id)));
      setSelectedIds((current) => current.filter((id) => !uniqueIds.includes(id)));
      if (uniqueIds.length > 1 || uniqueIds.some((id) => selectedIds.includes(id))) {
        setSelectionMode(false);
      }
      setMessage(uniqueIds.length === 1 ? "历史图片已删除。" : `已删除 ${uniqueIds.length} 张历史图片。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除历史图片失败");
    }
  }

  async function regenerate(image: PublicImage): Promise<void> {
    try {
      await apiJson("/api/generation-tasks", {
        method: "POST",
        body: JSON.stringify({
          mode: image.mode === "edit_image" ? "image_to_image" : image.mode,
          prompt: image.prompt,
          negativePrompt: null,
          size: sizeFromDimensions(image.width, image.height),
          quantity: 1,
          templateId: image.templateId,
          sourceImageId: image.mode === "text_to_image" ? null : image.id,
          referenceStrength: 0.6,
          styleStrength: 0.7,
        }),
      });
      setMessage("已提交再生成任务。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "再生成失败");
    }
  }

  async function saveTemplate(image: PublicImage): Promise<void> {
    const name = window.prompt("模板名称", image.templateName ? `${image.templateName} 副本` : "历史图片模板");
    if (!name) {
      return;
    }

    try {
      await apiJson("/api/templates/from-image", {
        method: "POST",
        body: JSON.stringify({
          imageId: image.id,
          name,
          category: "company",
          description: "从历史记录保存的用户模板",
        }),
      });
      const payload = await apiJson<TemplateListResponse>("/api/templates");
      setTemplates(payload.templates);
      setMessage("用户模板已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存模板失败");
    }
  }

  return (
    <>
      {!embedded ? (
        <section className="page-heading">
          <div>
            <h1>历史记录</h1>
            <p>默认按生成时间倒序展示，可按模式、模板和 prompt 关键词筛选。</p>
          </div>
          <button className="button" type="button" onClick={refresh} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            {loading ? "刷新中" : "刷新"}
          </button>
        </section>
      ) : null}

      <section className="history-toolbar">
        <div className="field">
          <label htmlFor="keyword">关键词</label>
          <input
            id="keyword"
            className="input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索 prompt"
          />
        </div>
        <div className="field">
          <label htmlFor="modeFilter">模式</label>
          <select id="modeFilter" className="select" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            {allModes.map((item) => (
              <option key={item || "all"} value={item}>
                {item ? modeLabels[item as GenerationMode] : "全部模式"}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="templateFilter">模板</label>
          <select id="templateFilter" className="select" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">全部模板</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
        <div className="history-actions">
          <button className="button primary history-action-button" type="button" onClick={refresh}>
            <Search size={16} aria-hidden="true" />
            筛选
          </button>
          <button
            className="button history-action-button"
            type="button"
            onClick={() => (selectionMode ? cancelSelection() : setSelectionMode(true))}
          >
            {selectionMode ? <X size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            {selectionMode ? "取消" : "选择"}
          </button>
          {selectionMode ? (
            <button className="button danger history-action-button" type="button" onClick={() => deleteImages(selectedIds)} disabled={selectedCount === 0}>
              <Trash2 size={16} aria-hidden="true" />
              删除{selectedCount > 0 ? ` ${selectedCount}` : ""}
            </button>
          ) : null}
        </div>
      </section>

      <div className={clsx("toast-line", error && "error")} role="status" aria-live="polite">{error || message}</div>

      {showInitialLoading ? (
        <div className="empty-state" aria-busy="true">
          <div>
            <strong>正在加载历史图片</strong>
            <span>请稍候，正在读取最新生成记录。</span>
          </div>
        </div>
      ) : showGrid ? (
        <>
          <section
            className={clsx("image-grid", selectionMode && "history-selecting", loading && "history-refreshing")}
            aria-busy={loading}
          >
            {images.map((image, imageIndex) => (
              <article className={clsx("image-card selectable", selectedIds.includes(image.id) && "selected")} key={image.id}>
                <label className="image-select-control">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(image.id)}
                    onChange={() => toggleImageSelection(image.id)}
                    aria-label="选择历史图片"
                  />
                </label>
                <button
                  className="image-frame-button"
                  type="button"
                  onClick={() => (selectionMode ? toggleImageSelection(image.id) : setLightboxIndex(imageIndex))}
                  title={selectionMode ? "选择历史图片" : "查看大图"}
                  aria-label={selectionMode ? "选择历史图片" : "查看大图"}
                >
                  <div className={clsx("image-frame", image.height > image.width && "tall", image.width > image.height && "wide")}>
                    <img
                      src={withDirectBase(imageDirectBase, image.thumbnailUrl ?? image.url)}
                      alt={image.prompt}
                      loading="lazy"
                      decoding="async"
                      onError={handleImgError}
                    />
                  </div>
                </button>
                <div className="image-card-body">
                  <div>
                    <span className="badge">{modeLabels[image.mode]}</span>
                    {image.templateId ? (
                      <span className="badge">{templateMap.get(image.templateId)?.name || image.templateName}</span>
                    ) : null}
                  </div>
                  <div className="image-prompt">{image.prompt}</div>
                  <small>{formatDateTime(image.createdAt)}</small>
                  {showImageOwner ? (
                    <span className="history-owner-badge">
                      <UserRound size={13} aria-hidden="true" />
                      {image.userName || image.userEmail || (image.userId ? "已删除用户" : "系统任务")}
                      {image.userEmail ? <small>{image.userEmail}</small> : null}
                    </span>
                  ) : null}
                  {image.templateId ? <small>{categoryLabels[templateMap.get(image.templateId)?.category ?? "company"]}</small> : null}
                  <div className="card-actions">
                    <a className="icon-button" href={image.url} download title="下载">
                      <Download size={15} aria-hidden="true" />
                    </a>
                    <button className="icon-button" type="button" onClick={() => copyPrompt(image.prompt)} title="复制 prompt">
                      <Copy size={15} aria-hidden="true" />
                    </button>
                    <button className="icon-button" type="button" onClick={() => regenerate(image)} title="再生成">
                      <RefreshCw size={15} aria-hidden="true" />
                    </button>
                    <Link className="icon-button" href={`/?mode=image_to_image&sourceImageId=${image.id}`} title="用这张图生成">
                      <Pencil size={15} aria-hidden="true" />
                    </Link>
                    <button className="icon-button" type="button" onClick={() => saveTemplate(image)} title="保存为模板">
                      <Save size={15} aria-hidden="true" />
                    </button>
                    <button className="icon-button danger" type="button" onClick={() => deleteImages([image.id])} title="删除图片">
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>

          <div className="history-load-more">
            {nextCursor ? (
              <button className="button" type="button" onClick={loadMore} disabled={loadingMore || loading}>
                {loadingMore ? <Loader2 size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                {loadingMore ? "加载中" : "加载更多"}
              </button>
            ) : (
              <span>已加载全部 {images.length} 张历史图片。</span>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <div>
            <strong>{hasFilters ? "没有匹配的历史图片" : "暂无历史图片"}</strong>
            <span>{hasFilters ? "可以换个关键词、模式或模板再试。" : "生成成功后的图片会自动进入这里。"}</span>
          </div>
        </div>
      )}

      {lightboxIndex !== null ? (
        <ImageLightbox
          images={images}
          index={lightboxIndex}
          onNavigate={navigateLightbox}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </>
  );
}
