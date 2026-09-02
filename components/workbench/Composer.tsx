"use client";

/* eslint-disable @next/next/no-img-element */
import { useRef } from "react";
import { ImagePlus, Send, Sparkles, Upload, X } from "lucide-react";
import clsx from "clsx";
import {
  imageQualityLabels,
  imageQualityOptions,
  imageSizeLabels,
  normalizeImageSizeOption,
  sizeOptions,
} from "@/lib/image-options";
import type { ImageQualityOption, ImageSizeOption } from "@/lib/image-options";
import { modeLabels } from "@/components/client-api";
import type { PublicTemplate, TemplateVariableDefinition } from "@/lib/types";
import { inferSourceImagePurpose } from "@/components/workbench/clipboard";
import type { AttachmentsController } from "@/components/workbench/useAttachments";
import type { ImageDropTarget } from "@/components/workbench/useImageDropTarget";
import { quantityOptions, workbenchModes, type AiImageQuota, type QuantityOption, type WorkbenchMode } from "@/components/workbench/types";
import { isSubmitShortcut } from "@/components/workbench/keyboard";

/** prompt 不再预填默认文案，改成 placeholder；空 prompt 直接禁用生成按钮。 */
export const promptPlaceholderByMode: Record<WorkbenchMode, string> = {
  text_to_image: "例如：一张简约高级的公司产品宣传海报，白色背景，柔和自然光，科技感，留白充足",
  image_to_image: "例如：保留主体特征，生成更高级干净的商业摄影场景，光线自然，质感清晰",
};

export interface ComposerProps {
  mode: WorkbenchMode;
  prompt: string;
  negativePrompt: string;
  size: ImageSizeOption;
  quality: ImageQualityOption;
  quantity: QuantityOption;
  templateId: string;
  templates: PublicTemplate[];
  selectedTemplate: PublicTemplate | null;
  templateVariableValues: Record<string, string>;
  missingTemplateVariables: string[];
  referenceStrength: number;
  styleStrength: number;
  attachments: AttachmentsController;
  dnd: ImageDropTarget<HTMLButtonElement>;
  submitting: boolean;
  promptOptimizing: boolean;
  quota: AiImageQuota | null;
  quotaLoading: boolean;
  quotaExhausted: boolean;
  estimatedQuotaCost: number;
  onModeChange: (mode: WorkbenchMode) => void;
  onPromptChange: (value: string) => void;
  onNegativePromptChange: (value: string) => void;
  onSizeChange: (value: ImageSizeOption) => void;
  onQualityChange: (value: ImageQualityOption) => void;
  onQuantityChange: (value: QuantityOption) => void;
  onTemplateChange: (templateId: string) => void;
  onTemplateVariableChange: (variable: TemplateVariableDefinition, value: string) => void;
  onReferenceStrengthChange: (value: number) => void;
  onStyleStrengthChange: (value: number) => void;
  onOptimizePrompt: () => void;
  onSubmit: () => void;
  onRefreshQuota: () => void;
  onOpenBuyPanel: () => void;
  onOpenActivationPanel: () => void;
}

export function Composer(props: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    mode,
    prompt,
    templates,
    selectedTemplate,
    attachments,
    dnd,
    submitting,
    quota,
    quotaLoading,
    quotaExhausted,
    estimatedQuotaCost,
  } = props;

  const quotaRemainingLabel = quota?.remaining === null ? "不限" : `${quota?.remaining ?? 0} 次`;
  const purposeLabels = attachments.attachments.map((item) => inferSourceImagePurpose(item.name));
  const canSubmit = Boolean(prompt.trim()) && !submitting && !quotaExhausted;

  return (
    <aside className="panel">
      <div className="panel-header">
        <div>
          <h2>参数</h2>
          <p>选择模式、模板和生成参数</p>
        </div>
      </div>
      <div className="panel-body form-stack">
        <div className="ai-credit-card">
          <div>
            <span>AI图片生成次数</span>
            <strong>{quotaLoading ? "刷新中" : quotaRemainingLabel}</strong>
          </div>
          <div className="ai-credit-actions">
            <button className="button subtle mini-button" type="button" onClick={props.onRefreshQuota} disabled={quotaLoading}>
              刷新
            </button>
            <button className="button primary mini-button" type="button" onClick={props.onOpenBuyPanel}>
              购买次数
            </button>
            <button className="button subtle mini-button" type="button" onClick={props.onOpenActivationPanel}>
              激活码兑换
            </button>
          </div>
        </div>

        <div className="mode-tabs" role="tablist" aria-label="生成模式">
          {workbenchModes.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={clsx(mode === item && "active")}
              onClick={() => props.onModeChange(item)}
            >
              {item === "text_to_image" ? <Sparkles size={16} /> : null}
              {item === "image_to_image" ? <ImagePlus size={16} /> : null}
              {modeLabels[item]}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="template">模板</label>
          <select
            id="template"
            className="select"
            value={props.templateId}
            onChange={(event) => props.onTemplateChange(event.target.value)}
          >
            <option value="">不使用模板</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>

        {selectedTemplate ? (
          <div className="template-production-card">
            <div>
              <span className="badge">{selectedTemplate.category === "platform" ? "生产模板" : "模板"}</span>
              <strong>{selectedTemplate.name}</strong>
            </div>
            <p>{selectedTemplate.description || "选择模板后会自动套用比例、负面词和风格参数。"}</p>
            <span>{imageSizeLabels[normalizeImageSizeOption(selectedTemplate.defaultSize)]}</span>
          </div>
        ) : null}

        {selectedTemplate?.templateVariables.length ? (
          <div className="template-variable-panel">
            <div className="template-variable-heading">
              <strong>填写生产参数</strong>
              <span>填表后自动生成最终 Prompt</span>
            </div>
            {selectedTemplate.templateVariables.map((variable) => (
              <div className="field" key={variable.key}>
                <label htmlFor={`template-variable-${variable.key}`}>
                  {variable.label}
                  {variable.required ? <span className="required-mark"> *</span> : null}
                </label>
                {variable.type === "textarea" ? (
                  <textarea
                    id={`template-variable-${variable.key}`}
                    className="textarea compact-textarea"
                    value={props.templateVariableValues[variable.key] ?? ""}
                    placeholder={variable.placeholder ?? undefined}
                    onChange={(event) => props.onTemplateVariableChange(variable, event.target.value)}
                  />
                ) : variable.type === "select" ? (
                  <select
                    id={`template-variable-${variable.key}`}
                    className="select"
                    value={props.templateVariableValues[variable.key] ?? ""}
                    onChange={(event) => props.onTemplateVariableChange(variable, event.target.value)}
                  >
                    <option value="">请选择</option>
                    {variable.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`template-variable-${variable.key}`}
                    className="input"
                    value={props.templateVariableValues[variable.key] ?? ""}
                    placeholder={variable.placeholder ?? undefined}
                    onChange={(event) => props.onTemplateVariableChange(variable, event.target.value)}
                  />
                )}
                {variable.helperText ? <small>{variable.helperText}</small> : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="field">
          <div className="field-label-row">
            <label htmlFor="prompt">{selectedTemplate ? "最终 Prompt" : "Prompt"}</label>
            <button
              className="button subtle mini-button"
              type="button"
              onClick={props.onOptimizePrompt}
              disabled={props.promptOptimizing || !prompt.trim()}
            >
              <Sparkles size={13} aria-hidden="true" />
              {props.promptOptimizing ? "优化中" : "优化提示词"}
            </button>
          </div>
          <textarea
            id="prompt"
            className="textarea"
            value={prompt}
            placeholder={`${promptPlaceholderByMode[mode]}（⌘/Ctrl + Enter 提交）`}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event) && canSubmit) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
          />
        </div>

        {mode !== "text_to_image" ? (
          <div className="field">
            <span className="field-label">参考图</span>
            <button
              className={clsx("upload-target", dnd.dragging && "dragging")}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDrop={dnd.onDrop}
              onDragOver={dnd.onDragOver}
              onDragEnter={dnd.onDragOver}
              onDragLeave={dnd.onDragLeave}
              onPaste={dnd.onPaste}
            >
              {attachments.attachments.length > 0 ? (
                <div className="source-preview-grid">
                  {attachments.attachments.map((attachment, index) => (
                    <div key={attachment.id} className="source-preview-inline">
                      {attachment.previewUrl ? (
                        <img
                          className="upload-preview"
                          src={attachment.previewUrl}
                          alt={`参考图 ${index + 1}`}
                          decoding="async"
                        />
                      ) : (
                        // 模板参考图 / URL 参数带进来的图片只有 id，没有可展示的地址。
                        <span className="upload-preview-placeholder">已选图片</span>
                      )}
                      <button
                        className="icon-button ghost"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          attachments.remove(attachment.id);
                        }}
                        aria-label={`移除参考图 ${index + 1}`}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <Upload size={20} aria-hidden="true" />
                  <span>点击、拖拽或粘贴 PNG / JPG / WEBP（最多 {attachments.limit} 张）</span>
                </>
              )}
            </button>
            <div className="upload-actions">
              <button className="button subtle" type="button" onClick={dnd.onPasteButton}>
                粘贴剪贴板图片
              </button>
              <span>也可以直接把图片拖到上方区域</span>
            </div>
            {purposeLabels.length > 0 ? (
              <div className="source-purpose-row">
                <span>自动识别用途</span>
                {purposeLabels.map((label, index) => (
                  <strong key={`${label}-${index}`}>{label}</strong>
                ))}
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              className="input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(event) => {
                dnd.onFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </div>
        ) : null}

        <div className="field-row">
          <div className="field">
            <label htmlFor="size">尺寸</label>
            <select
              id="size"
              className="select"
              value={props.size}
              onChange={(event) => props.onSizeChange(event.target.value as ImageSizeOption)}
            >
              {sizeOptions.map((item) => (
                <option key={item} value={item}>
                  {imageSizeLabels[item]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="quality">质量</label>
            <select
              id="quality"
              className="select"
              value={props.quality}
              onChange={(event) => props.onQualityChange(event.target.value as ImageQualityOption)}
            >
              {imageQualityOptions.map((item) => (
                <option key={item} value={item}>
                  {imageQualityLabels[item]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">数量</span>
            <div className="segmented">
              {quantityOptions.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={clsx(props.quantity === item && "active")}
                  onClick={() => props.onQuantityChange(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>

        <details className="advanced">
          <summary>高级参数</summary>
          <div className="advanced-fields">
            <div className="field">
              <label htmlFor="negative">负面提示词</label>
              <textarea
                id="negative"
                className="textarea"
                value={props.negativePrompt}
                onChange={(event) => props.onNegativePromptChange(event.target.value)}
              />
              <small>默认按模板类目生成；封面 / 海报类不会禁掉画面文字。</small>
            </div>
            <div className="field">
              <label htmlFor="referenceStrength">参考强度 {props.referenceStrength.toFixed(2)}</label>
              <input
                id="referenceStrength"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={props.referenceStrength}
                onChange={(event) => props.onReferenceStrengthChange(Number(event.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="styleStrength">风格强度 {props.styleStrength.toFixed(2)}</label>
              <input
                id="styleStrength"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={props.styleStrength}
                onChange={(event) => props.onStyleStrengthChange(Number(event.target.value))}
              />
            </div>
          </div>
        </details>

        <button className="button primary sidebar-generate-button" type="button" onClick={props.onSubmit} disabled={!canSubmit}>
          <Send size={16} aria-hidden="true" />
          {submitting ? "提交中" : "生成"}
        </button>

        {quotaExhausted ? (
          <div className="quota-empty-hint">
            <span>剩余额度不足本次生成（需要 {estimatedQuotaCost} 次）。</span>
            <div>
              <button className="button primary mini-button" type="button" onClick={props.onOpenBuyPanel}>
                购买次数
              </button>
              <button className="button subtle mini-button" type="button" onClick={props.onOpenActivationPanel}>
                激活码兑换
              </button>
            </div>
          </div>
        ) : null}

        {props.missingTemplateVariables.length > 0 ? (
          <div className="quota-hint">还需要填写模板变量：{props.missingTemplateVariables.join("、")}</div>
        ) : null}

        <div className="quota-hint">
          本次预计消耗 <strong>{estimatedQuotaCost}</strong> 次额度
          <span> · 剩余 <strong>{quotaRemainingLabel}</strong></span>
          {selectedTemplate ? <span> · {selectedTemplate.name}</span> : null}
        </div>
      </div>
    </aside>
  );
}
