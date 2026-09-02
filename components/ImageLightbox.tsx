"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, X } from "lucide-react";
import clsx from "clsx";
import type { PublicImage } from "@/lib/types";
import { handleImgError, useImageDirectBase, withDirectBase } from "@/components/image-src";

interface ImageLightboxProps {
  images: PublicImage[];
  index: number;
  /** delta 为 -1 / +1，由外层用函数式更新计算下一张，避免连按方向键时读到过期的 index。 */
  onNavigate: (delta: number) => void;
  onClose: () => void;
}

/**
 * 历史页大图查看（F 工作包）：←/→ 翻页、Esc 关闭、1:1 原始尺寸切换、下载原图。
 * 打开时焦点落到关闭按钮，关闭后焦点回到触发元素。
 */
export function ImageLightbox({ images, index, onNavigate, onClose }: ImageLightboxProps) {
  const directBase = useImageDirectBase();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const [actualSize, setActualSize] = useState(false);

  const total = images.length;
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const image = images[safeIndex];

  const goPrevious = useCallback(() => {
    if (total > 1) {
      onNavigate(-1);
    }
  }, [onNavigate, total]);

  const goNext = useCallback(() => {
    if (total > 1) {
      onNavigate(1);
    }
  }, [onNavigate, total]);

  useEffect(() => {
    setActualSize(false);
  }, [safeIndex]);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) {
        trigger.focus();
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrevious();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goNext, goPrevious, onClose]);

  if (!image) {
    return null;
  }

  return (
    <div className="image-lightbox-backdrop" role="dialog" aria-modal="true" aria-label="历史图片大图" onClick={onClose}>
      <div className="image-lightbox" onClick={(event) => event.stopPropagation()}>
        <div className="image-lightbox-toolbar">
          {total > 1 ? (
            <span className="image-lightbox-counter">
              {safeIndex + 1} / {total}
            </span>
          ) : null}
          <button
            className="icon-button ghost"
            type="button"
            onClick={() => setActualSize((current) => !current)}
            title={actualSize ? "适应窗口" : "1:1 查看"}
            aria-label={actualSize ? "适应窗口" : "1:1 查看"}
            aria-pressed={actualSize}
          >
            {actualSize ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
          </button>
          <a className="icon-button ghost" href={image.url} download title="下载原图" aria-label="下载原图">
            <Download size={17} aria-hidden="true" />
          </a>
          <button
            ref={closeButtonRef}
            className="icon-button ghost"
            type="button"
            onClick={onClose}
            title="关闭大图"
            aria-label="关闭大图"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className={clsx("image-lightbox-viewport", actualSize && "actual")}>
          <img
            src={withDirectBase(directBase, image.url)}
            alt={image.prompt}
            decoding="async"
            onError={handleImgError}
          />
        </div>

        {total > 1 ? (
          <>
            <button
              className="image-lightbox-nav previous"
              type="button"
              onClick={goPrevious}
              title="上一张"
              aria-label="上一张"
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
            <button className="image-lightbox-nav next" type="button" onClick={goNext} title="下一张" aria-label="下一张">
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          </>
        ) : null}

        <div className="image-lightbox-caption">{image.prompt}</div>
      </div>
    </div>
  );
}
