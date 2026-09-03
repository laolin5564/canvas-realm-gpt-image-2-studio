"use client";

/* eslint-disable @next/next/no-img-element */
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  CopyPlus,
  Download,
  Eraser,
  GitBranch,
  ImagePlus,
  ListChecks,
  Loader2,
  LocateFixed,
  MousePointer2,
  Network,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Send,
  Square,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Tldraw,
  createShapeId,
  type Editor,
  type TLAsset,
  type TLAssetId,
  type TLAssetStore,
  type TLEditorSnapshot,
  type TLImageShape,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLStoreSnapshot,
} from "tldraw";
import { AssetRecordType } from "@tldraw/tlschema";
import clsx from "clsx";
import type { ImageSizeOption } from "@/lib/image-options";
import { maxSourceImageUploadBytes } from "@/lib/validation";
import { oversizedFilesMessage } from "@/components/workbench/attachments";
import { imageSizeLabels, ratioForOption, sizeFromDimensions, sizeOptions } from "@/lib/image-options";
import type { PublicCanvasProject, PublicImage, PublicTask } from "@/lib/types";
import { apiJson, copyTextToClipboard, formatDateTime, modeLabels, progressStageLabels, statusLabels } from "@/components/client-api";
import {
  CANVAS_GENERATION_PLACEHOLDER_TYPE,
  CanvasGenerationPlaceholderShapeUtil,
  type CanvasGenerationPlaceholderShape,
} from "./GenerationPlaceholderShape";
import {
  CANVAS_FLOW_CONNECTOR_TYPE,
  CANVAS_WORKFLOW_NODE_TYPE,
  CanvasFlowConnectorShapeUtil,
  CanvasWorkflowNodeShapeUtil,
  type CanvasFlowConnectorShape,
  type CanvasWorkflowNodeShape,
} from "./WorkflowShape";
import {
  areCanvasReferencesEqual,
  canvasReferenceLabel,
  decodeCanvasImageAltText,
  decodeCanvasImageUrl,
  encodeCanvasImageAltText,
  extractCanvasTaskIdFromShape,
  finalizeCanvasReferences,
  type CanvasImageReference,
  type CanvasImageIdentity,
  type SortableCanvasImageReference,
} from "./reference-model";
import {
  canvasFlowConnectorIsLocked,
  connectorAnchor,
  connectorGeometry,
  shouldRefreshConnectorGeometry,
  type CanvasConnectorSide,
} from "./connector-model";

interface CanvasProjectResponse {
  project: PublicCanvasProject;
}

interface ImageListResponse {
  images: PublicImage[];
}

interface SourceImageUploadResponse {
  imageId: string;
  url: string;
}

interface CreateTaskResponse {
  task: PublicTask;
}

interface TaskResponse {
  task: PublicTask;
}

interface ActiveCanvasTask {
  taskId: string;
  prompt: string;
  mode: "text_to_image" | "image_to_image";
  status: PublicTask["status"];
  progressStage: PublicTask["progressStage"];
  placeholderIds: TLShapeId[];
  errorMessage: string | null;
  createdAt: string;
}

interface CanvasGenerationRunInput {
  prompt: string;
  mode: "text_to_image" | "image_to_image";
  size: ImageSizeOption;
  quantity: 1 | 2 | 4;
  references: CanvasImageReference[];
}

interface PlaceholderPlacement {
  id: TLShapeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkflowCluster {
  nodeId: TLShapeId;
  placeholderIds: TLShapeId[];
  connectorIds: TLShapeId[];
}

interface WorkflowRun {
  nodeId: TLShapeId;
  placements: PlaceholderPlacement[];
  connectorIds: TLShapeId[];
}

interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasWorkflowOverview {
  images: number;
  sourceImages: number;
  generatedImages: number;
  workflowNodes: number;
  connectors: number;
  runningNodes: number;
  failedNodes: number;
}

interface CanvasWorkflowSelection {
  nodeId: TLShapeId;
  taskId: string;
  title: string;
  prompt: string;
  status: CanvasWorkflowNodeShape["props"]["status"];
  mode: "text_to_image" | "image_to_image";
  sizeLabel: string;
  sizeOption: ImageSizeOption | null;
  quantity: 1 | 2 | 4;
  incomingReferences: CanvasImageReference[];
  resultReferences: CanvasImageReference[];
  branchDepth: number;
}

type CanvasSnapshot = TLEditorSnapshot | TLStoreSnapshot;
type CanvasFlowConnectorPartial = TLShapePartial<CanvasFlowConnectorShape> & {
  id: TLShapeId;
  type: typeof CANVAS_FLOW_CONNECTOR_TYPE;
};

const shapeUtils = [CanvasGenerationPlaceholderShapeUtil, CanvasWorkflowNodeShapeUtil, CanvasFlowConnectorShapeUtil];
const maxCanvasReferenceCount = 4;
const projectAutosaveMs = 900;
const workflowNodeSize = { width: 360, height: 224 };
const workflowGap = 76;

export function CanvasClient() {
  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const selectionFrameRef = useRef<number | undefined>(undefined);
  const connectorFrameRef = useRef<number | undefined>(undefined);
  const taskPollTimersRef = useRef<Map<string, number>>(new Map());
  const taskPlaceholdersRef = useRef<Map<string, TLShapeId[]>>(new Map());
  const taskWorkflowRef = useRef<Map<string, WorkflowCluster>>(new Map());
  const insertionOffsetRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [projectSnapshot, setProjectSnapshot] = useState<CanvasSnapshot | undefined>();
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"loading" | "saved" | "pending" | "saving" | "error">("loading");
  const [images, setImages] = useState<PublicImage[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [mode, setMode] = useState<"text_to_image" | "image_to_image">("text_to_image");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("低清晰度，模糊，变形，多余文字");
  const [size, setSize] = useState<ImageSizeOption>("auto");
  const [quantity, setQuantity] = useState<1 | 2 | 4>(1);
  const [referenceStrength, setReferenceStrength] = useState(0.65);
  const [styleStrength, setStyleStrength] = useState(0.7);
  const [selectedReferences, setSelectedReferences] = useState<CanvasImageReference[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveCanvasTask[]>([]);
  const [canvasShapeCount, setCanvasShapeCount] = useState(0);
  const [showEmptyGuide, setShowEmptyGuide] = useState(true);
  const [workflowOverview, setWorkflowOverview] = useState<CanvasWorkflowOverview>(() => emptyWorkflowOverview());
  const [selectedWorkflow, setSelectedWorkflow] = useState<CanvasWorkflowSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const canvasAssetStore = useMemo<TLAssetStore>(
    () => ({
      async upload(_asset, file) {
        const uploaded = await uploadCanvasImageFile(file);
        return {
          src: uploaded.url,
          meta: {
            sourceImageId: uploaded.imageId,
            originalName: file.name,
            mimeType: file.type,
          },
        };
      },
      resolve(asset) {
        if (asset.type !== "image") {
          return null;
        }
        return asset.props.src || null;
      },
    }),
    [],
  );

  const refreshImages = useCallback(async () => {
    setLoadingImages(true);
    setError("");
    try {
      const payload = await apiJson<ImageListResponse>("/api/images?pageSize=60");
      setImages(payload.images);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "历史素材加载失败");
    } finally {
      setLoadingImages(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadProject(): Promise<void> {
      setSaveState("loading");
      try {
        const payload = await apiJson<CanvasProjectResponse>("/api/canvas-project", { signal: controller.signal });
        if (controller.signal.aborted) return;
        const snapshot = payload.project.snapshot;
        if (isCanvasSnapshot(snapshot)) {
          setProjectSnapshot(snapshot);
        }
        setSaveState("saved");
      } catch (caught) {
        if (!controller.signal.aborted) {
          setSaveState("error");
          setError(caught instanceof Error ? caught.message : "画布加载失败");
        }
      } finally {
        if (!controller.signal.aborted) {
          setProjectLoaded(true);
        }
      }
    }

    void loadProject();
    void refreshImages();
    return () => controller.abort();
  }, [refreshImages]);

  useEffect(() => {
    const taskPollTimers = taskPollTimersRef.current;
    const taskWorkflows = taskWorkflowRef.current;
    return () => {
      window.clearTimeout(saveTimerRef.current);
      if (selectionFrameRef.current !== undefined) {
        window.cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = undefined;
      }
      if (connectorFrameRef.current !== undefined) {
        window.cancelAnimationFrame(connectorFrameRef.current);
        connectorFrameRef.current = undefined;
      }
      for (const timer of taskPollTimers.values()) {
        window.clearTimeout(timer);
      }
      taskPollTimers.clear();
      taskWorkflows.clear();
    };
  }, []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      if (isEditableEventTarget(event.target)) {
        return;
      }
      const files = imageFilesFromClipboard(event);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void addFilesToCanvas(files);
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // addFilesToCanvas reads editorRef and current state setters; re-binding paste on every render would make clipboard handling noisy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectivePanelMode = selectedReferences.length > 0 ? "image_to_image" : mode;
  const canGenerate =
    Boolean(prompt.trim()) && (effectivePanelMode === "text_to_image" || mode === "image_to_image" || selectedReferences.length > 0);
  const activeTaskCount = activeTasks.filter((task) => task.status === "queued" || task.status === "processing").length;
  const selectedWorkflowReferenceCount = selectedReferences.filter((reference) => reference.origin === "workflow_output").length;

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (!editor.user.getIsSnapMode()) {
      editor.user.updateUserPreferences({ isSnapMode: true });
    }

    const scheduleConnectorRefresh = (): void => {
      if (connectorFrameRef.current !== undefined) {
        return;
      }
      connectorFrameRef.current = window.requestAnimationFrame(() => {
        connectorFrameRef.current = undefined;
        pruneOrphanFlowConnectors(editor);
        updateBoundFlowConnectors(editor);
      });
    };

    const scheduleSelectionRefresh = (): void => {
      if (selectionFrameRef.current !== undefined) {
        return;
      }
      selectionFrameRef.current = window.requestAnimationFrame(() => {
        selectionFrameRef.current = undefined;
        updateSelectedReferences(editor);
        updateCanvasShapeCount(editor);
        updateWorkflowContext(editor);
        scheduleConnectorRefresh();
      });
    };

    const saveProject = async (): Promise<void> => {
      setSaveState("saving");
      try {
        await apiJson<CanvasProjectResponse>("/api/canvas-project", {
          method: "PUT",
          body: JSON.stringify({
            snapshot: stripTransientCanvasRecords(editor.getSnapshot()),
          }),
        });
        setSaveState("saved");
      } catch (caught) {
        setSaveState("error");
        setError(caught instanceof Error ? caught.message : "画布自动保存失败");
      }
    };

    const removeDocumentListener = editor.store.listen(
      () => {
        window.clearTimeout(saveTimerRef.current);
        setSaveState((state) => (state === "saving" ? state : "pending"));
        saveTimerRef.current = window.setTimeout(() => void saveProject(), projectAutosaveMs);
        scheduleConnectorRefresh();
      },
      { source: "user", scope: "document" },
    );
    const removeConnectorListener = editor.store.listen(scheduleConnectorRefresh, { source: "all", scope: "document" });
    const removeSelectionListener = editor.store.listen(scheduleSelectionRefresh, { source: "all", scope: "all" });
    const handleEditorChange = (): void => {
      scheduleSelectionRefresh();
      scheduleConnectorRefresh();
    };
    editor.on("change", handleEditorChange);
    hydrateLooseFlowConnectors(editor);
    scheduleSelectionRefresh();
    scheduleConnectorRefresh();
    updateCanvasShapeCount(editor);
    updateWorkflowContext(editor);

    return () => {
      window.clearTimeout(saveTimerRef.current);
      if (selectionFrameRef.current !== undefined) {
        window.cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = undefined;
      }
      if (connectorFrameRef.current !== undefined) {
        window.cancelAnimationFrame(connectorFrameRef.current);
        connectorFrameRef.current = undefined;
      }
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
      editor.off("change", handleEditorChange);
      removeSelectionListener();
      removeConnectorListener();
      removeDocumentListener();
    };
  }, []);

  function updateSelectedReferences(editor: Editor): void {
    const references = resolveSelectedCanvasReferences(editor);
    setSelectedReferences((current) => (areCanvasReferencesEqual(current, references) ? current : references));
    if (references.length > 0) {
      setMode((currentMode) => (currentMode === "text_to_image" ? "image_to_image" : currentMode));
    }
  }

  function updateCanvasShapeCount(editor: Editor): void {
    const count = editor
      .getCurrentPageShapes()
      .filter((shape) => shape.type !== CANVAS_FLOW_CONNECTOR_TYPE)
      .length;
    setCanvasShapeCount(count);
    if (count > 0) {
      setShowEmptyGuide(false);
    }
  }

  function updateWorkflowContext(editor: Editor): void {
    setWorkflowOverview(resolveWorkflowOverview(editor));
    setSelectedWorkflow(resolveSelectedWorkflow(editor));
  }

  async function addFilesToCanvas(files: File[]): Promise<void> {
    const editor = editorRef.current;
    if (!editor) {
      setError("画布还没有准备好");
      return;
    }
    const allImageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (allImageFiles.length === 0) {
      setError("请上传 PNG、JPG 或 WEBP 图片");
      return;
    }
    // 与工作台一致：超过原始上限的文件不发上传请求，直接提示。
    const imageFiles = allImageFiles.filter((file) => file.size <= maxSourceImageUploadBytes);
    const oversized = allImageFiles.length - imageFiles.length;
    if (imageFiles.length === 0) {
      setError(oversizedFilesMessage(oversized));
      return;
    }
    setBusy(true);
    setError(oversized > 0 ? oversizedFilesMessage(oversized) : "");
    setMessage("");
    try {
      for (const file of imageFiles.slice(0, 8)) {
        const dimensions = await readImageDimensions(file);
        const uploaded = await uploadCanvasImageFile(file);
        addSourceImageToEditor(editor, {
          imageId: uploaded.imageId,
          url: uploaded.url,
          width: dimensions.width,
          height: dimensions.height,
          name: file.name,
          mimeType: file.type,
        }, insertionOffsetRef);
      }
      setShowEmptyGuide(false);
      updateCanvasShapeCount(editor);
      updateWorkflowContext(editor);
      setMessage(`已加入 ${Math.min(imageFiles.length, 8)} 张图片到画布`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片加入画布失败");
    } finally {
      setBusy(false);
    }
  }

  function addHistoryImageToCanvas(image: PublicImage): void {
    const editor = editorRef.current;
    if (!editor) {
      setError("画布还没有准备好");
      return;
    }
    addGeneratedImageToEditor(editor, image, insertionOffsetRef);
    setShowEmptyGuide(false);
    updateCanvasShapeCount(editor);
    updateWorkflowContext(editor);
    setMessage("图片已加入画布。");
  }

  function locateHistoryImage(image: PublicImage): void {
    const editor = editorRef.current;
    if (!editor) return;
    const shapeId = findCanvasShapeByImageId(editor, image.id);
    if (!shapeId) {
      addHistoryImageToCanvas(image);
      return;
    }
    zoomToShape(editor, shapeId);
  }

  function setImageAsReference(image: PublicImage): void {
    const editor = editorRef.current;
    if (!editor) return;
    const shapeId = findCanvasShapeByImageId(editor, image.id) ?? addGeneratedImageToEditor(editor, image, insertionOffsetRef);
    editor.select(shapeId);
    setPrompt(image.prompt);
    setMode("image_to_image");
    setSize(sizeFromDimensions(image.width, image.height));
    zoomToShape(editor, shapeId);
  }

  async function copyPrompt(value: string): Promise<void> {
    try {
      await copyTextToClipboard(value);
      setMessage("Prompt 已复制。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复制失败");
    }
  }

  function downloadImage(image: PublicImage): void {
    const anchor = document.createElement("a");
    anchor.href = image.url;
    anchor.download = `canvas-${image.createdAt.slice(0, 10)}-${image.id}.png`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  async function submitGeneration(): Promise<void> {
    const editor = editorRef.current;
    const trimmedPrompt = prompt.trim();
    if (!editor) {
      setError("画布还没有准备好");
      return;
    }
    if (!trimmedPrompt) {
      setError("请输入 Prompt");
      return;
    }
    const liveReferences = resolveSelectedCanvasReferences(editor).slice(0, maxCanvasReferenceCount);
    await runCanvasGeneration({
      prompt: trimmedPrompt,
      mode,
      size,
      quantity,
      references: liveReferences,
    });
  }

  async function runCanvasGeneration(input: CanvasGenerationRunInput): Promise<void> {
    const editor = editorRef.current;
    const trimmedPrompt = input.prompt.trim();
    if (!editor) {
      setError("画布还没有准备好");
      return;
    }
    if (!trimmedPrompt) {
      setError("请输入 Prompt");
      return;
    }
    const normalizedReferences = input.references.slice(0, maxCanvasReferenceCount);
    const effectiveMode = normalizedReferences.length > 0 ? "image_to_image" : input.mode;
    if (effectiveMode === "image_to_image" && normalizedReferences.length === 0) {
      setError("图生图需要先在画布里选中至少一张图片");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");
    setShowEmptyGuide(false);
    setSelectedReferences((current) => (areCanvasReferencesEqual(current, normalizedReferences) ? current : normalizedReferences));
    if (normalizedReferences.length > 0) {
      setMode("image_to_image");
    }
    const workflow = createWorkflowRun(editor, {
      prompt: trimmedPrompt,
      mode: effectiveMode,
      size: input.size,
      quantity: input.quantity,
      references: effectiveMode === "image_to_image" ? normalizedReferences : [],
    });
    updateCanvasShapeCount(editor);
    updateWorkflowContext(editor);
    try {
      const sourceImageIds = effectiveMode === "image_to_image" ? normalizedReferences.map((reference) => reference.imageId) : [];
      const payload = await apiJson<CreateTaskResponse>("/api/generation-tasks", {
        method: "POST",
        body: JSON.stringify({
          mode: effectiveMode,
          prompt: trimmedPrompt,
          negativePrompt,
          size: input.size,
          quantity: input.quantity,
          templateId: null,
          sourceImageId: sourceImageIds[0] ?? null,
          sourceImageIds: sourceImageIds.length > 1 ? sourceImageIds : undefined,
          referenceStrength,
          styleStrength,
        }),
      });

      bindWorkflowToTask(editor, workflow, payload.task.id);
      taskWorkflowRef.current.set(payload.task.id, {
        nodeId: workflow.nodeId,
        placeholderIds: workflow.placements.map((placement) => placement.id),
        connectorIds: workflow.connectorIds,
      });
      taskPlaceholdersRef.current.set(payload.task.id, workflow.placements.map((placement) => placement.id));
      upsertActiveTask(payload.task, workflow.placements.map((placement) => placement.id));
      setMessage(
        effectiveMode === "image_to_image"
          ? `任务已提交，已基于 ${sourceImageIds.length} 张选中结果继续生成。`
          : "任务已提交，结果会自动落到画布里。",
      );
      updateWorkflowContext(editor);
      scheduleTaskPoll(payload.task.id);
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "任务提交失败";
      markWorkflowFailed(editor, workflow, messageText);
      setError(messageText);
    } finally {
      setBusy(false);
    }
  }

  function scheduleTaskPoll(taskId: string): void {
    const existing = taskPollTimersRef.current.get(taskId);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => void pollTask(taskId), 1400);
    taskPollTimersRef.current.set(taskId, timer);
  }

  async function pollTask(taskId: string): Promise<void> {
    taskPollTimersRef.current.delete(taskId);
    try {
      const payload = await apiJson<TaskResponse>(`/api/generation-tasks/${taskId}`);
      upsertActiveTask(payload.task, taskPlaceholdersRef.current.get(taskId) ?? []);
      if (payload.task.status === "succeeded") {
        finishTaskOnCanvas(payload.task);
        return;
      }
      if (payload.task.status === "failed") {
        markTaskFailedOnCanvas(payload.task);
        return;
      }
      scheduleTaskPoll(taskId);
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "任务状态刷新失败";
      const placeholderIds = taskPlaceholdersRef.current.get(taskId) ?? [];
      const editor = editorRef.current;
      if (editor && placeholderIds.length > 0) {
        markPlaceholdersFailed(editor, placeholderIds, messageText);
      }
      setError(messageText);
    }
  }

  function finishTaskOnCanvas(task: PublicTask): void {
    const editor = editorRef.current;
    const placeholderIds = taskPlaceholdersRef.current.get(task.id) ?? [];
    if (!editor) return;
    const images = task.images ?? [];
    const imageShapeIds = replacePlaceholdersWithImages(editor, placeholderIds, images, task.prompt);
    rebindWorkflowOutputConnectors(editor, taskWorkflowRef.current.get(task.id), imageShapeIds);
    updateWorkflowNodeStatus(editor, taskWorkflowRef.current.get(task.id), "succeeded", "", images.length);
    updateBoundFlowConnectors(editor);
    updateWorkflowContext(editor);
    cleanupTaskPolling(task.id);
    setMessage(`生成完成，共 ${images.length} 张，已放入画布。`);
    void refreshImages();
  }

  function markTaskFailedOnCanvas(task: PublicTask): void {
    const editor = editorRef.current;
    const placeholderIds = taskPlaceholdersRef.current.get(task.id) ?? [];
    if (editor) {
      markPlaceholdersFailed(editor, placeholderIds, task.errorMessage || "生成失败");
      updateWorkflowNodeStatus(editor, taskWorkflowRef.current.get(task.id), "failed", task.errorMessage || "生成失败");
      updateWorkflowContext(editor);
    }
    cleanupTaskPolling(task.id);
    setError(task.errorMessage || "生成失败");
  }

  function cleanupTaskPolling(taskId: string): void {
    const timer = taskPollTimersRef.current.get(taskId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    taskPollTimersRef.current.delete(taskId);
    taskPlaceholdersRef.current.delete(taskId);
    taskWorkflowRef.current.delete(taskId);
    setActiveTasks((tasks) => tasks.filter((task) => task.taskId !== taskId));
  }

  async function cancelTask(taskId: string): Promise<void> {
    const editor = editorRef.current;
    const placeholderIds = taskPlaceholdersRef.current.get(taskId) ?? [];
    try {
      const payload = await apiJson<TaskResponse>(`/api/generation-tasks/${taskId}/cancel`, { method: "POST" });
      if (editor && placeholderIds.length > 0) {
        editor.deleteShapes(placeholderIds);
        removeWorkflowOutputConnectors(editor, taskWorkflowRef.current.get(taskId));
        updateWorkflowNodeStatus(editor, taskWorkflowRef.current.get(taskId), "canceled", payload.task.errorMessage || "用户已停止生成");
        updateWorkflowContext(editor);
      }
      cleanupTaskPolling(taskId);
      setMessage(payload.task.errorMessage || "已停止生成");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "停止任务失败");
    }
  }

  function selectSingleReference(reference: CanvasImageReference): void {
    const editor = editorRef.current;
    if (!editor) return;
    editor.select(reference.shapeId);
    setSelectedReferences([reference]);
    setMode("image_to_image");
    zoomToShape(editor, reference.shapeId);
  }

  function branchFromWorkflowResults(workflow: CanvasWorkflowSelection): void {
    const editor = editorRef.current;
    const resultIds = workflow.resultReferences.map((reference) => reference.shapeId);
    if (!editor || resultIds.length === 0) {
      setError("这个节点还没有可用于分支的结果图");
      return;
    }
    editor.select(...resultIds);
    setSelectedReferences(workflow.resultReferences.slice(0, maxCanvasReferenceCount));
    setMode("image_to_image");
    setPrompt(workflow.prompt);
    if (workflow.sizeOption) setSize(workflow.sizeOption);
    setQuantity(workflow.quantity);
    setMessage("已选中此节点结果。改写 Prompt 后即可生成下一条分支。");
  }

  function reuseWorkflowConfig(workflow: CanvasWorkflowSelection): void {
    const editor = editorRef.current;
    setPrompt(workflow.prompt);
    setMode(workflow.incomingReferences.length > 0 ? "image_to_image" : workflow.mode);
    if (workflow.sizeOption) setSize(workflow.sizeOption);
    setQuantity(workflow.quantity);
    if (editor && workflow.incomingReferences.length > 0) {
      editor.select(...workflow.incomingReferences.map((reference) => reference.shapeId));
      setSelectedReferences(workflow.incomingReferences.slice(0, maxCanvasReferenceCount));
    }
    setMessage("已复用该节点的 Prompt、尺寸、数量和参考图。");
  }

  async function rerunWorkflow(workflow: CanvasWorkflowSelection): Promise<void> {
    await runCanvasGeneration({
      prompt: workflow.prompt,
      mode: workflow.incomingReferences.length > 0 ? "image_to_image" : workflow.mode,
      size: workflow.sizeOption ?? size,
      quantity: workflow.quantity,
      references: workflow.incomingReferences,
    });
  }

  function upsertActiveTask(task: PublicTask, placeholderIds: TLShapeId[]): void {
    setActiveTasks((tasks) => {
      const next: ActiveCanvasTask = {
        taskId: task.id,
        prompt: task.prompt,
        mode: task.mode === "image_to_image" || task.mode === "edit_image" ? "image_to_image" : "text_to_image",
        status: task.status,
        progressStage: task.progressStage,
        placeholderIds,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt,
      };
      const existing = tasks.findIndex((item) => item.taskId === task.id);
      if (existing >= 0) {
        return tasks.map((item, index) => (index === existing ? next : item));
      }
      return [next, ...tasks].slice(0, 8);
    });
  }

  function clearCanvas(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const ids = editor.getCurrentPageShapes().map((shape) => shape.id);
    if (ids.length > 0) {
      // 二次确认放在删除之前：用户取消时不会产生任何 store 变更，也就不会触发自动保存。
      const ok = window.confirm(`确定清空画布上的 ${ids.length} 个元素吗？此操作会同时保存到画布项目。`);
      if (!ok) {
        return;
      }
      unlockAndDeleteShapes(editor, ids);
      setCanvasShapeCount(0);
      setWorkflowOverview(emptyWorkflowOverview());
      setSelectedWorkflow(null);
      setShowEmptyGuide(true);
      setMessage("画布已清空。");
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void addFilesToCanvas(files);
  }

  function insertExampleWorkflow(): void {
    const editor = editorRef.current;
    if (!editor) {
      setError("画布还没有准备好");
      return;
    }
    const workflow = createWorkflowRun(editor, {
      prompt: "示例：上传一张产品图，选中它作为参考，再生成 4 张小红书封面变体。每次生成都会形成一个任务节点，右侧是结果组。",
      mode: "image_to_image",
      size: "xhs_cover_3_4",
      quantity: 4,
      references: [],
      status: "draft",
    });
    editor.select(workflow.nodeId);
    setShowEmptyGuide(false);
    updateCanvasShapeCount(editor);
    updateWorkflowContext(editor);
    setMessage("已插入示例工作流。你可以替换 Prompt 或上传图片后继续生成。");
  }

  return (
    <section className="canvas-workspace" onDropCapture={handleDrop} onDragOver={(event) => event.preventDefault()}>
      <aside className="canvas-asset-panel">
        <div className="canvas-panel-header">
          <div>
            <h1>图片画布</h1>
            <p>无限画布、参考图选择、批量生成和结果整理在同一个空间完成。</p>
          </div>
          <span className={clsx("canvas-save-state", saveState)}>
            {saveState === "saving" || saveState === "loading" ? <Loader2 size={14} aria-hidden="true" /> : null}
            {saveStateLabel(saveState)}
          </span>
        </div>

        <div className="canvas-upload-card">
          <button className="canvas-upload-zone" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} aria-hidden="true" />
            <span>上传 / 拖拽 / 粘贴图片到画布</span>
            <small>可作为图生图参考，最多选中 {maxCanvasReferenceCount} 张</small>
          </button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              void addFilesToCanvas(Array.from(event.target.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        </div>

        <div className="canvas-library-head">
          <strong>历史素材</strong>
          <button className="icon-button" type="button" onClick={refreshImages} disabled={loadingImages} title="刷新素材">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="canvas-history-list">
          {images.map((image) => (
            <article className="canvas-history-item" key={image.id}>
              <button className="canvas-history-thumb" type="button" onClick={() => locateHistoryImage(image)} title="定位或加入画布">
                {/* 素材列表只加载缩略图（?thumb=1，服务端缺图时自动回退原图），不拉原图 */}
                <img src={image.thumbnailUrl ?? image.url} alt={image.prompt} loading="lazy" decoding="async" />
              </button>
              <div className="canvas-history-copy">
                <strong>{image.prompt}</strong>
                <span>
                  {modeLabels[image.mode]} · {formatDateTime(image.createdAt)}
                </span>
              </div>
              <div className="canvas-history-actions">
                <button type="button" title="加入画布" onClick={() => addHistoryImageToCanvas(image)}>
                  <ImagePlus size={14} aria-hidden="true" />
                </button>
                <button type="button" title="作为参考" onClick={() => setImageAsReference(image)}>
                  <MousePointer2 size={14} aria-hidden="true" />
                </button>
                <button type="button" title="复制 Prompt" onClick={() => void copyPrompt(image.prompt)}>
                  <Copy size={14} aria-hidden="true" />
                </button>
                <button type="button" title="下载图片" onClick={() => downloadImage(image)}>
                  <Download size={14} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </aside>

      <div className="canvas-stage-shell">
        <div className="canvas-stage-toolbar">
          <div className="canvas-toolbar-group">
            <span className="canvas-toolbar-pill">
              <Square size={14} aria-hidden="true" />
                {selectedReferences.length > 0
                  ? selectedWorkflowReferenceCount > 0
                    ? `已从节点找到 ${selectedReferences.length} 张结果图`
                    : `已选 ${selectedReferences.length} 张参考图`
                  : "选中图片或任务节点可继续生成"}
            </span>
            {activeTaskCount > 0 ? (
              <span className="canvas-toolbar-pill active">
                <Loader2 size={14} aria-hidden="true" />
                {activeTaskCount} 个任务进行中
              </span>
            ) : null}
          </div>
          <div className="canvas-toolbar-group">
            <button className="button subtle" type="button" onClick={() => editorRef.current?.zoomToFit({ animation: { duration: 220 } })}>
              <LocateFixed size={15} aria-hidden="true" />
              适配画布
            </button>
            <button className="button subtle" type="button" onClick={clearCanvas}>
              <Eraser size={15} aria-hidden="true" />
              清空
            </button>
          </div>
        </div>

        <div className="canvas-stage">
          {projectLoaded ? (
            <>
              <Tldraw
                assets={canvasAssetStore}
                shapeUtils={shapeUtils}
                snapshot={projectSnapshot}
                onMount={handleMount}
              />
              {showEmptyGuide && canvasShapeCount === 0 ? (
                <div className="canvas-empty-overlay">
                  <div className="canvas-empty-guide">
                    <button className="canvas-empty-close" type="button" onClick={() => setShowEmptyGuide(false)} title="关闭引导">
                      <X size={16} aria-hidden="true" />
                    </button>
                    <span>可视化生图流程</span>
                    <h2>把参考图、Prompt、生成结果放在一张流程图里</h2>
                    <p>上传或从历史加入图片，选中图片作为参考，再点击生成。画布会自动创建任务节点、连接线和结果组，方便做系列图和变体对比。</p>
                    <div>
                      <button className="button primary" type="button" onClick={insertExampleWorkflow}>
                        插入示例流程
                      </button>
                      <button className="button subtle" type="button" onClick={() => fileInputRef.current?.click()}>
                        上传参考图
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="canvas-loading">
              <Loader2 size={20} aria-hidden="true" />
              正在加载画布...
            </div>
          )}
        </div>
      </div>

      <aside className="canvas-generate-panel">
        <div className="canvas-generate-card">
          <div className="canvas-panel-title">
            <strong>生成控制</strong>
            <span>{effectivePanelMode === "image_to_image" ? "继续图生图" : "文生图"}</span>
          </div>

          <div className="canvas-workflow-hint">
            <strong>
              {selectedReferences.length > 0
                ? selectedWorkflowReferenceCount > 0
                  ? "下一次生成会基于所选节点的结果"
                  : "下一次生成会继承选中图片"
                : "每次生成都会创建一个流程节点"}
            </strong>
            <p>
              {selectedReferences.length > 0
                ? selectedWorkflowReferenceCount > 0
                  ? `已从选中的任务节点反查到 ${selectedReferences.length} 张结果图，新需求会走“上一轮结果 → 新任务节点 → 新结果组”。`
                  : `已选中 ${selectedReferences.length} 张参考图，提交后会在画布中生成“参考图 → 任务节点 → 结果组”的关系。`
                : "选中上一轮生成图，或直接选中已完成的任务节点，都可以继续基于结果改图。"}
            </p>
          </div>

          <div className="canvas-mode-switch" role="group" aria-label="生成模式">
            <button className={clsx(effectivePanelMode === "text_to_image" && "active")} type="button" onClick={() => setMode("text_to_image")}>
              文生图
            </button>
            <button className={clsx(effectivePanelMode === "image_to_image" && "active")} type="button" onClick={() => setMode("image_to_image")}>
              图生图
            </button>
          </div>

          {effectivePanelMode === "image_to_image" ? (
            <section className="canvas-reference-box">
              <div>
                <strong>参考图</strong>
                <span>{selectedReferences.length}/{maxCanvasReferenceCount}</span>
              </div>
              {selectedReferences.length > 0 ? (
                <div className="canvas-reference-list">
                  {selectedReferences.map((reference) => (
                    <button key={reference.shapeId} type="button" onClick={() => zoomToShape(editorRef.current, reference.shapeId)}>
                      <img src={reference.url} alt={reference.name} loading="lazy" decoding="async" />
                      <span>{canvasReferenceLabel(reference)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p>在画布中选中图片后，会自动作为图生图参考。</p>
              )}
              {selectedReferences.length > 0 ? (
                <p className="canvas-reference-note">
                  {selectedWorkflowReferenceCount > 0
                    ? "当前从任务节点读取结果图；如果只想基于其中一张，单独选中那张图即可。"
                    : "多选图片会一起作为参考输入，系统最多取前 4 张。"}
                </p>
              ) : null}
            </section>
          ) : null}

          <label className="field">
            <span>Prompt</span>
            <textarea
              className="textarea canvas-prompt"
              value={prompt}
              placeholder="描述你想生成或修改的画面..."
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <label className="field">
            <span>尺寸</span>
            <select className="select" value={size} onChange={(event) => setSize(event.target.value as ImageSizeOption)}>
              {sizeOptions.map((item) => (
                <option key={item} value={item}>
                  {imageSizeLabels[item]}
                </option>
              ))}
            </select>
          </label>

          <div className="field-row compact">
            <div className="field">
              <span>数量</span>
              <div className="segmented quantity-segment">
                {[1, 2, 4].map((item) => (
                  <button
                    className={clsx(quantity === item && "active")}
                    key={item}
                    type="button"
                    onClick={() => setQuantity(item as 1 | 2 | 4)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>参考强度</span>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={referenceStrength}
                onChange={(event) => setReferenceStrength(Number(event.target.value))}
              />
            </label>
          </div>

          <details className="canvas-advanced">
            <summary>高级参数</summary>
            <label className="field">
              <span>负向提示词</span>
              <textarea className="textarea" value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} />
            </label>
            <label className="field">
              <span>风格强度</span>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={styleStrength}
                onChange={(event) => setStyleStrength(Number(event.target.value))}
              />
            </label>
          </details>

          <button className="canvas-generate-button" type="button" disabled={!canGenerate || busy} onClick={() => void submitGeneration()}>
            {busy ? <Loader2 size={18} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
            {effectivePanelMode === "image_to_image" ? "基于选中结果继续生成" : "生成到画布"}
          </button>
        </div>

        <div className="canvas-workflow-card">
          <div className="canvas-panel-title">
            <strong>工作流视图</strong>
            <span>{workflowOverview.workflowNodes} 个节点</span>
          </div>

          <div className="canvas-workflow-metrics">
            <span>
              <Network size={14} aria-hidden="true" />
              节点 {workflowOverview.workflowNodes}
            </span>
            <span>
              <ImagePlus size={14} aria-hidden="true" />
              素材 {workflowOverview.sourceImages}
            </span>
            <span>
              <GitBranch size={14} aria-hidden="true" />
              结果 {workflowOverview.generatedImages}
            </span>
            <span>
              <ListChecks size={14} aria-hidden="true" />
              关系 {workflowOverview.connectors}
            </span>
          </div>

          {selectedWorkflow ? (
            <section className="canvas-node-inspector">
              <div className="canvas-node-inspector-head">
                <span className={clsx("canvas-task-status", selectedWorkflow.status)}>
                  {selectedWorkflow.status === "running" ? <Loader2 size={13} aria-hidden="true" /> : null}
                  {selectedWorkflow.status === "failed" ? <AlertTriangle size={13} aria-hidden="true" /> : null}
                  {selectedWorkflow.status === "succeeded" ? <CheckCircle2 size={13} aria-hidden="true" /> : null}
                  {canvasWorkflowStatusLabel(selectedWorkflow.status)}
                </span>
                <small>{selectedWorkflow.mode === "image_to_image" ? "图生图节点" : "文生图节点"}</small>
              </div>
              <h3>{selectedWorkflow.title}</h3>
              <p>{selectedWorkflow.prompt}</p>
              <div className="canvas-node-facts">
                <span>{selectedWorkflow.sizeLabel}</span>
                <span>{selectedWorkflow.quantity} 张</span>
                <span>输入 {selectedWorkflow.incomingReferences.length}</span>
                <span>输出 {selectedWorkflow.resultReferences.length}</span>
                <span>层级 {selectedWorkflow.branchDepth}</span>
              </div>
              <div className="canvas-node-actions">
                <button className="button subtle" type="button" onClick={() => reuseWorkflowConfig(selectedWorkflow)}>
                  <CopyPlus size={15} aria-hidden="true" />
                  复用配置
                </button>
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => branchFromWorkflowResults(selectedWorkflow)}
                  disabled={selectedWorkflow.resultReferences.length === 0}
                >
                  <GitBranch size={15} aria-hidden="true" />
                  基于结果分支
                </button>
                <button className="button subtle" type="button" onClick={() => void rerunWorkflow(selectedWorkflow)}>
                  <Repeat2 size={15} aria-hidden="true" />
                  重新生成
                </button>
              </div>

              <WorkflowReferenceList
                title="本节点引用"
                empty="这个节点没有引用外部图片。"
                references={selectedWorkflow.incomingReferences}
                onSelect={selectSingleReference}
              />
              <WorkflowReferenceList
                title="节点结果"
                empty="结果生成后会在这里形成可继续分支的素材。"
                references={selectedWorkflow.resultReferences}
                onSelect={selectSingleReference}
              />
            </section>
          ) : (
            <div className="canvas-workflow-empty">
              <Network size={18} aria-hidden="true" />
              <strong>选中任务节点或生成图</strong>
              <p>这里会显示它用了哪些参考图、生成了哪些结果，以及下一步能否重试、分支或复用。</p>
            </div>
          )}

          {selectedReferences.length > 1 ? (
            <section className="canvas-compare-panel">
              <div className="canvas-panel-title">
                <strong>对比选择</strong>
                <span>{selectedReferences.length} 张</span>
              </div>
              <p>多张结果会一起作为图生图参考；如果只想沿其中一张继续，点“只用这张”。</p>
              <div className="canvas-compare-grid">
                {selectedReferences.map((reference, index) => (
                  <button key={reference.shapeId} type="button" onClick={() => selectSingleReference(reference)}>
                    <img src={reference.url} alt={reference.name} loading="lazy" decoding="async" />
                    <span>只用第 {index + 1} 张</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="canvas-task-card">
          <div className="canvas-panel-title">
            <strong>画布任务</strong>
            <span>{activeTasks.length} 个</span>
          </div>
          {activeTasks.length === 0 ? (
            <p className="canvas-empty-copy">任务提交后会在这里显示排队、请求、生成、保存状态。</p>
          ) : (
            <div className="canvas-task-list">
              {activeTasks.map((task) => (
                <article className="canvas-task-item" key={task.taskId}>
                  <div>
                    <span className={clsx("canvas-task-status", task.status)}>
                      {task.status === "succeeded" ? <CheckCircle2 size={13} aria-hidden="true" /> : null}
                      {task.status === "failed" ? <AlertTriangle size={13} aria-hidden="true" /> : null}
                      {task.status === "queued" || task.status === "processing" ? <Loader2 size={13} aria-hidden="true" /> : null}
                      {task.progressStage ? progressStageLabels[task.progressStage] : statusLabels[task.status]}
                    </span>
                    <strong>{task.prompt}</strong>
                    {task.errorMessage ? <small>{task.errorMessage}</small> : null}
                  </div>
                  {task.status === "queued" || task.status === "processing" ? (
                    <button type="button" onClick={() => void cancelTask(task.taskId)} title="停止">
                      <XCircle size={15} aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" onClick={() => scheduleTaskPoll(task.taskId)} title="刷新">
                      <RotateCcw size={15} aria-hidden="true" />
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className={error ? "toast-line canvas-toast error" : "toast-line canvas-toast"} role="status" aria-live="polite">
        {error || message}
      </div>
    </section>
  );
}

function WorkflowReferenceList({
  title,
  empty,
  references,
  onSelect,
}: {
  title: string;
  empty: string;
  references: CanvasImageReference[];
  onSelect: (reference: CanvasImageReference) => void;
}) {
  return (
    <div className="canvas-node-reference-section">
      <div>
        <strong>{title}</strong>
        <span>{references.length} 张</span>
      </div>
      {references.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <div className="canvas-node-reference-grid">
          {references.map((reference, index) => (
            <button key={`${title}-${reference.shapeId}`} type="button" onClick={() => onSelect(reference)}>
              <img src={reference.url} alt={reference.name} loading="lazy" decoding="async" />
              <span>{index + 1}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

async function uploadCanvasImageFile(file: File): Promise<SourceImageUploadResponse> {
  // tldraw 自带的粘贴 / 拖放也会走这里（canvasAssetStore.upload），同样先拦超限文件。
  if (file.size > maxSourceImageUploadBytes) {
    throw new Error(oversizedFilesMessage(1));
  }
  const formData = new FormData();
  formData.append("image", file);
  return apiJson<SourceImageUploadResponse>("/api/source-images", {
    method: "POST",
    body: formData,
  });
}

function imageFilesFromClipboard(event: ClipboardEvent): File[] {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
  const itemFiles = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && file.type.startsWith("image/")));
  const seen = new Set<string>();
  return [...files, ...itemFiles].filter((file) => {
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 1024, height: 1024 });
    };
    image.src = url;
  });
}

function isCanvasSnapshot(value: unknown): value is CanvasSnapshot {
  return Boolean(value && typeof value === "object");
}

function saveStateLabel(state: "loading" | "saved" | "pending" | "saving" | "error"): string {
  switch (state) {
    case "loading":
      return "加载中";
    case "pending":
      return "待保存";
    case "saving":
      return "保存中";
    case "error":
      return "保存失败";
    case "saved":
    default:
      return "已保存";
  }
}

function displaySize(width: number, height: number): { width: number; height: number } {
  const safeWidth = width > 0 ? width : 1024;
  const safeHeight = height > 0 ? height : 1024;
  const scale = Math.min(1, 340 / safeWidth, 300 / safeHeight);
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
}

function targetDisplaySize(size: ImageSizeOption): { width: number; height: number; label: string } {
  const ratio = ratioForOption(size);
  if (size === "auto" || ratio.width <= 0 || ratio.height <= 0) {
    return { width: 280, height: 280, label: imageSizeLabels.auto };
  }
  const base = displaySize(ratio.width * 420, ratio.height * 420);
  return {
    ...base,
    label: imageSizeLabels[size],
  };
}

function createGeneratedAsset(image: PublicImage): TLAsset {
  return {
    id: AssetRecordType.createId(`generated-${image.id}`),
    typeName: "asset",
    type: "image",
    props: {
      src: image.url,
      w: image.width || 1024,
      h: image.height || 1024,
      name: image.id,
      mimeType: "image/png",
      isAnimated: false,
    },
    meta: {
      generatedImageId: image.id,
      taskId: image.taskId,
      prompt: image.prompt,
    },
  };
}

function createSourceAsset(input: {
  imageId: string;
  url: string;
  width: number;
  height: number;
  name: string;
  mimeType: string;
}): TLAsset {
  return {
    id: AssetRecordType.createId(`source-${input.imageId}`),
    typeName: "asset",
    type: "image",
    props: {
      src: input.url,
      w: input.width || 1024,
      h: input.height || 1024,
      name: input.name,
      mimeType: input.mimeType || "image/png",
      isAnimated: false,
    },
    meta: {
      sourceImageId: input.imageId,
      originalName: input.name,
    },
  };
}

function createImageShape(input: {
  assetId: TLAssetId;
  url: string;
  width: number;
  height: number;
  x: number;
  y: number;
  altText: string;
  identity?: CanvasImageIdentity;
}): Partial<TLImageShape> & { id: TLShapeId; type: "image" } {
  const altText = input.identity
    ? encodeCanvasImageAltText(input.altText, input.identity)
    : input.altText;
  return {
    id: createShapeId(),
    type: "image",
    x: input.x,
    y: input.y,
    props: {
      assetId: input.assetId,
      w: input.width,
      h: input.height,
      url: input.url,
      playing: true,
      crop: null,
      flipX: false,
      flipY: false,
      altText,
    },
  };
}

function nextCanvasPoint(editor: Editor, width: number, height: number, offsetRef: { current: number }): { x: number; y: number } {
  const viewport = editor.getViewportPageBounds();
  const offset = offsetRef.current;
  offsetRef.current += 1;
  return {
    x: viewport.center.x - width / 2 + (offset % 4) * 28,
    y: viewport.center.y - height / 2 + Math.floor(offset / 4) * 28,
  };
}

function addGeneratedImageToEditor(editor: Editor, image: PublicImage, offsetRef?: { current: number }): TLShapeId {
  const asset = createGeneratedAsset(image);
  const size = displaySize(image.width, image.height);
  const point = nextCanvasPoint(editor, size.width, size.height, offsetRef ?? { current: editor.getCurrentPageShapes().length % 8 });
  const shape = createImageShape({
    assetId: asset.id,
    url: image.url,
    width: size.width,
    height: size.height,
    x: point.x,
    y: point.y,
    altText: image.prompt,
    identity: {
      imageId: image.id,
      kind: "generated",
      taskId: image.taskId,
      prompt: image.prompt,
    },
  });
  editor.run(() => {
    if (!editor.getAsset(asset.id)) {
      editor.createAssets([asset]);
    }
    editor.createShapes([shape]);
    editor.select(shape.id);
  });
  return shape.id;
}

function addSourceImageToEditor(
  editor: Editor,
  input: { imageId: string; url: string; width: number; height: number; name: string; mimeType: string },
  offsetRef?: { current: number },
): TLShapeId {
  const asset = createSourceAsset(input);
  const size = displaySize(input.width, input.height);
  const point = nextCanvasPoint(editor, size.width, size.height, offsetRef ?? { current: editor.getCurrentPageShapes().length % 8 });
  const shape = createImageShape({
    assetId: asset.id,
    url: input.url,
    width: size.width,
    height: size.height,
    x: point.x,
    y: point.y,
    altText: input.name,
    identity: {
      imageId: input.imageId,
      kind: "source",
      taskId: null,
      prompt: input.name,
    },
  });
  editor.run(() => {
    if (!editor.getAsset(asset.id)) {
      editor.createAssets([asset]);
    }
    editor.createShapes([shape]);
    editor.select(shape.id);
  });
  return shape.id;
}

function resolveSelectedCanvasReferences(editor: Editor): CanvasImageReference[] {
  const selectedShapes = editor.getSelectedShapes();
  const directImageReferences = selectedShapes
    .flatMap((shape) => (shape.type === "image" ? [referenceFromImageShape(editor, shape as TLImageShape, "selected_image")] : []))
    .filter((reference): reference is SortableCanvasImageReference => Boolean(reference));

  if (directImageReferences.length > 0) {
    return finalizeCanvasReferences(directImageReferences, maxCanvasReferenceCount);
  }

  const selectedTaskIds = selectedShapes
    .map((shape) =>
      extractCanvasTaskIdFromShape(shape, [CANVAS_WORKFLOW_NODE_TYPE, CANVAS_GENERATION_PLACEHOLDER_TYPE]),
    )
    .filter((taskId): taskId is string => Boolean(taskId));

  const taskIdSet = new Set(selectedTaskIds);
  const workflowOutputReferences =
    taskIdSet.size === 0
      ? []
      : editor
          .getCurrentPageShapes()
          .flatMap((shape) => {
            if (shape.type !== "image") {
              return [];
            }
            const reference = referenceFromImageShape(editor, shape as TLImageShape, "workflow_output");
            if (!reference || !reference.taskId || !taskIdSet.has(reference.taskId)) {
              return [];
            }
            return [reference];
          })
          .filter((reference): reference is SortableCanvasImageReference => Boolean(reference));

  if (workflowOutputReferences.length > 0) {
    return finalizeCanvasReferences(workflowOutputReferences, maxCanvasReferenceCount);
  }

  const selectionBounds = getSelectionBounds(editor);
  if (!selectionBounds) {
    return [];
  }

  const boxedImageReferences = editor
    .getCurrentPageShapes()
    .flatMap((shape) => {
      if (shape.type !== "image") {
        return [];
      }
      const bounds = getShapeBounds(editor, shape.id);
      if (!bounds || !boundsOverlap(selectionBounds, bounds)) {
        return [];
      }
      return [referenceFromImageShape(editor, shape as TLImageShape, "selected_image")];
    })
    .filter((reference): reference is SortableCanvasImageReference => Boolean(reference));

  return finalizeCanvasReferences(boxedImageReferences, maxCanvasReferenceCount);
}

function referenceFromImageShape(
  editor: Editor,
  imageShape: TLImageShape,
  origin: CanvasImageReference["origin"],
): SortableCanvasImageReference | null {
  const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
  const meta = (asset?.meta ?? {}) as Record<string, unknown>;
  const embeddedIdentity = decodeCanvasImageAltText(imageShape.props.altText);
  const urlIdentity = decodeCanvasImageUrl(imageShape.props.url);
  const generatedImageId = typeof meta.generatedImageId === "string" ? meta.generatedImageId : null;
  const sourceImageId = typeof meta.sourceImageId === "string" ? meta.sourceImageId : null;
  const imageId = generatedImageId ?? sourceImageId ?? embeddedIdentity?.imageId ?? urlIdentity?.imageId;
  const kind =
    generatedImageId || embeddedIdentity?.kind === "generated" || urlIdentity?.kind === "generated"
      ? "generated"
      : "source";
  const url = asset?.type === "image" ? asset.props.src : imageShape.props.url;
  if (!imageId || !url) {
    return null;
  }
  const bounds = editor.getShapePageBounds(imageShape);
  const taskId = typeof meta.taskId === "string" ? meta.taskId : embeddedIdentity?.taskId ?? urlIdentity?.taskId ?? null;
  return {
    shapeId: imageShape.id,
    imageId,
    kind,
    origin,
    taskId,
    name: asset?.type === "image" ? asset.props.name || embeddedIdentity?.prompt || imageId : embeddedIdentity?.prompt || imageId,
    url,
    width: asset?.type === "image" ? asset.props.w : imageShape.props.w,
    height: asset?.type === "image" ? asset.props.h : imageShape.props.h,
    sortX: bounds?.x ?? 0,
    sortY: bounds?.y ?? 0,
  };
}

function emptyWorkflowOverview(): CanvasWorkflowOverview {
  return {
    images: 0,
    sourceImages: 0,
    generatedImages: 0,
    workflowNodes: 0,
    connectors: 0,
    runningNodes: 0,
    failedNodes: 0,
  };
}

function resolveWorkflowOverview(editor: Editor): CanvasWorkflowOverview {
  return editor.getCurrentPageShapes().reduce<CanvasWorkflowOverview>((overview, shape) => {
    if (shape.type === "image") {
      const reference = referenceFromImageShape(editor, shape as TLImageShape, "selected_image");
      return {
        ...overview,
        images: overview.images + 1,
        sourceImages: overview.sourceImages + (reference?.kind === "source" ? 1 : 0),
        generatedImages: overview.generatedImages + (reference?.kind === "generated" ? 1 : 0),
      };
    }
    if (shape.type === CANVAS_WORKFLOW_NODE_TYPE) {
      const node = shape as CanvasWorkflowNodeShape;
      return {
        ...overview,
        workflowNodes: overview.workflowNodes + 1,
        runningNodes: overview.runningNodes + (node.props.status === "running" ? 1 : 0),
        failedNodes: overview.failedNodes + (node.props.status === "failed" ? 1 : 0),
      };
    }
    if (shape.type === CANVAS_FLOW_CONNECTOR_TYPE) {
      return { ...overview, connectors: overview.connectors + 1 };
    }
    return overview;
  }, emptyWorkflowOverview());
}

function resolveSelectedWorkflow(editor: Editor): CanvasWorkflowSelection | null {
  const selectedShapes = editor.getSelectedShapes();
  const directNode = selectedShapes.find(isWorkflowNodeShape);
  if (directNode) {
    return workflowSelectionFromNode(editor, directNode);
  }

  const selectedImageTaskId = selectedShapes
    .flatMap((shape) => (shape.type === "image" ? [referenceFromImageShape(editor, shape as TLImageShape, "workflow_output")] : []))
    .find((reference): reference is SortableCanvasImageReference => Boolean(reference?.taskId))
    ?.taskId;
  if (!selectedImageTaskId) {
    return null;
  }
  const linkedNode = editor
    .getCurrentPageShapes()
    .find((shape): shape is CanvasWorkflowNodeShape => isWorkflowNodeShape(shape) && shape.props.taskId === selectedImageTaskId);
  return linkedNode ? workflowSelectionFromNode(editor, linkedNode) : null;
}

function workflowSelectionFromNode(editor: Editor, node: CanvasWorkflowNodeShape): CanvasWorkflowSelection {
  const incomingReferences = incomingReferencesForNode(editor, node.id);
  const resultReferences = resultReferencesForNode(editor, node);
  const sizeOption = isImageSizeOption(node.props.sizeOption) ? node.props.sizeOption : null;
  const inferredMode = incomingReferences.length > 0 ? "image_to_image" : node.props.mode ?? "text_to_image";
  return {
    nodeId: node.id,
    taskId: node.props.taskId,
    title: node.props.title,
    prompt: node.props.prompt,
    status: node.props.status,
    mode: inferredMode,
    sizeLabel: node.props.sizeLabel,
    sizeOption,
    quantity: normalizeCanvasQuantity(node.props.quantity ?? node.props.outputCount),
    incomingReferences,
    resultReferences,
    branchDepth: workflowBranchDepth(editor, node, new Set()),
  };
}

function incomingReferencesForNode(editor: Editor, nodeId: TLShapeId): CanvasImageReference[] {
  const sortable = editor
    .getCurrentPageShapes()
    .flatMap((shape) => {
      if (!isFlowConnectorShape(shape) || shape.props.toShapeId !== nodeId || shape.props.tone !== "reference") {
        return [];
      }
      const fromShapeId = shape.props.fromShapeId as TLShapeId | undefined;
      const fromShape = fromShapeId ? editor.getShape(fromShapeId) : undefined;
      if (!fromShape || fromShape.type !== "image") {
        return [];
      }
      return [referenceFromImageShape(editor, fromShape as TLImageShape, "selected_image")];
    })
    .filter((reference): reference is SortableCanvasImageReference => Boolean(reference));
  return finalizeCanvasReferences(sortable, maxCanvasReferenceCount);
}

function resultReferencesForNode(editor: Editor, node: CanvasWorkflowNodeShape): CanvasImageReference[] {
  const connectorTargets = new Set(
    editor
      .getCurrentPageShapes()
      .flatMap((shape) => {
        if (!isFlowConnectorShape(shape) || shape.props.fromShapeId !== node.id || shape.props.tone === "reference") {
          return [];
        }
        return shape.props.toShapeId ? [shape.props.toShapeId] : [];
      }),
  );
  const sortable = editor
    .getCurrentPageShapes()
    .flatMap((shape) => {
      if (shape.type !== "image") {
        return [];
      }
      const reference = referenceFromImageShape(editor, shape as TLImageShape, "workflow_output");
      if (!reference) {
        return [];
      }
      const matchesConnector = connectorTargets.has(shape.id);
      const matchesTask = Boolean(node.props.taskId && node.props.taskId !== "pending" && reference.taskId === node.props.taskId);
      return matchesConnector || matchesTask ? [reference] : [];
    })
    .filter((reference): reference is SortableCanvasImageReference => Boolean(reference));
  return finalizeCanvasReferences(sortable, 16);
}

function workflowBranchDepth(editor: Editor, node: CanvasWorkflowNodeShape, visited: Set<string>): number {
  if (visited.has(node.id)) {
    return 1;
  }
  visited.add(node.id);
  const parentTaskIds = incomingReferencesForNode(editor, node.id)
    .map((reference) => reference.taskId)
    .filter((taskId): taskId is string => Boolean(taskId));
  if (parentTaskIds.length === 0) {
    return 1;
  }
  const parentDepths = parentTaskIds.flatMap((taskId) => {
    const parentNode = editor
      .getCurrentPageShapes()
      .find((shape): shape is CanvasWorkflowNodeShape => isWorkflowNodeShape(shape) && shape.props.taskId === taskId);
    return parentNode ? [workflowBranchDepth(editor, parentNode, visited)] : [1];
  });
  return 1 + Math.max(...parentDepths);
}

function createWorkflowRun(
  editor: Editor,
  input: {
    prompt: string;
    mode: "text_to_image" | "image_to_image";
    size: ImageSizeOption;
    quantity: 1 | 2 | 4;
    references: CanvasImageReference[];
    status?: "draft" | "running";
  },
): WorkflowRun {
  const layout = workflowLayout(editor, input.references, input.quantity, input.size);
  const nodeId = createShapeId();
  const placements = createPlaceholderPlacements(input.quantity, input.size, layout.outputOrigin.x, layout.outputOrigin.y);
  const workflowStatus = input.status ?? "running";
  const connectorIds: TLShapeId[] = [];

  editor.run(() => {
    editor.createShapes<CanvasWorkflowNodeShape>([
      {
        id: nodeId,
        type: CANVAS_WORKFLOW_NODE_TYPE,
        x: layout.nodeOrigin.x,
        y: layout.nodeOrigin.y,
        props: {
          w: workflowNodeSize.width,
          h: workflowNodeSize.height,
          title: workflowStatus === "draft" ? "示例：参考图生成系列变体" : workflowTitle(input.prompt),
          modeLabel: input.mode === "image_to_image" ? "图生图工作流" : "文生图工作流",
          sizeLabel: imageSizeLabels[input.size],
          prompt: input.prompt,
          referenceCount: input.references.length,
          outputCount: input.quantity,
          status: workflowStatus,
          taskId: "pending",
          error: "",
          mode: input.mode,
          sizeOption: input.size,
          quantity: input.quantity,
          parentTaskIds: input.references
            .map((reference) => reference.taskId)
            .filter((taskId): taskId is string => Boolean(taskId)),
        },
      },
    ]);
    createGenerationPlaceholdersAt(editor, placements, input.size, "pending", workflowStatus === "draft" ? "draft" : "loading");

    const connectorShapes: CanvasFlowConnectorPartial[] = [
      ...input.references.flatMap((reference, index) =>
        createBoundFlowConnectorShape(editor, {
          fromShapeId: reference.shapeId,
          toShapeId: nodeId,
          fromSide: "right",
          toSide: "left",
          fromBias: 0.5,
          toBias: 0.36 + index * 0.1,
          label: index === 0 ? "参考输入" : "",
          tone: "reference",
        }),
      ),
      ...placements.flatMap((placement, index) =>
        createBoundFlowConnectorShape(editor, {
          fromShapeId: nodeId,
          toShapeId: placement.id,
          fromSide: "right",
          toSide: "left",
          fromBias: 0.5 + (index - (placements.length - 1) / 2) * 0.08,
          toBias: 0.5,
          label: index === 0 ? "生成结果" : "",
          tone: workflowStatus === "draft" ? "draft" : "output",
        }),
      ),
    ];

    if (connectorShapes.length > 0) {
      editor.createShapes<CanvasFlowConnectorShape>(connectorShapes);
      connectorIds.push(...connectorShapes.map((shape) => shape.id));
    }
    updateBoundFlowConnectors(editor);
    editor.select(nodeId, ...placements.map((placement) => placement.id));
    editor.zoomToBounds(
      {
        x: layout.viewBounds.x,
        y: layout.viewBounds.y,
        w: layout.viewBounds.width,
        h: layout.viewBounds.height,
      },
      { animation: { duration: 240 }, inset: 80 },
    );
  });

  return {
    nodeId,
    placements,
    connectorIds,
  };
}

function workflowLayout(
  editor: Editor,
  references: CanvasImageReference[],
  count: 1 | 2 | 4,
  size: ImageSizeOption,
): {
  nodeOrigin: { x: number; y: number };
  outputOrigin: { x: number; y: number };
  outputHeight: number;
  viewBounds: CanvasBounds;
} {
  const target = targetDisplaySize(size);
  const columns = count === 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const outputWidth = columns * target.width + (columns - 1) * 38;
  const outputHeight = rows * target.height + (rows - 1) * 38;
  const referenceBounds = unionReferenceBounds(editor, references);
  const viewport = editor.getViewportPageBounds();

  if (referenceBounds) {
    const nodeX = referenceBounds.x + referenceBounds.width + workflowGap;
    const nodeY = referenceBounds.y + referenceBounds.height / 2 - workflowNodeSize.height / 2;
    const outputX = nodeX + workflowNodeSize.width + workflowGap;
    const outputY = nodeY + workflowNodeSize.height / 2 - outputHeight / 2;
    return {
      nodeOrigin: { x: nodeX, y: nodeY },
      outputOrigin: { x: outputX, y: outputY },
      outputHeight,
      viewBounds: boundsFromPoints([
        { x: referenceBounds.x, y: referenceBounds.y },
        { x: outputX + outputWidth, y: Math.max(referenceBounds.y + referenceBounds.height, outputY + outputHeight) },
        { x: outputX + outputWidth, y: Math.min(referenceBounds.y, outputY) },
      ]),
    };
  }

  const totalWidth = workflowNodeSize.width + workflowGap + outputWidth;
  const totalHeight = Math.max(workflowNodeSize.height, outputHeight);
  const originX = viewport.center.x - totalWidth / 2;
  const originY = viewport.center.y - totalHeight / 2;
  return {
    nodeOrigin: {
      x: originX,
      y: originY + totalHeight / 2 - workflowNodeSize.height / 2,
    },
    outputOrigin: {
      x: originX + workflowNodeSize.width + workflowGap,
      y: originY + totalHeight / 2 - outputHeight / 2,
    },
    outputHeight,
    viewBounds: {
      x: originX,
      y: originY,
      width: totalWidth,
      height: totalHeight,
    },
  };
}

function createPlaceholderPlacements(
  count: 1 | 2 | 4,
  size: ImageSizeOption,
  originX: number,
  originY: number,
): PlaceholderPlacement[] {
  const target = targetDisplaySize(size);
  const columns = count === 1 ? 1 : 2;
  const gap = 38;
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      id: createShapeId(),
      x: originX + column * (target.width + gap),
      y: originY + row * (target.height + gap),
      width: target.width,
      height: target.height,
    };
  });
}

function createGenerationPlaceholdersAt(
  editor: Editor,
  placements: PlaceholderPlacement[],
  size: ImageSizeOption,
  taskId: string,
  status: "loading" | "draft",
): void {
  const target = targetDisplaySize(size);
  editor.createShapes<CanvasGenerationPlaceholderShape>(
    placements.map((placement, index) => ({
      id: placement.id,
      type: CANVAS_GENERATION_PLACEHOLDER_TYPE,
      x: placement.x,
      y: placement.y,
      props: {
        w: placement.width,
        h: placement.height,
        targetLabel: target.label,
        status,
        error: "",
        taskId,
        outputIndex: index,
      },
    })),
  );
}

function bindWorkflowToTask(editor: Editor, workflow: WorkflowRun, taskId: string): void {
  editor.updateShapes<CanvasWorkflowNodeShape>([
    {
      id: workflow.nodeId,
      type: CANVAS_WORKFLOW_NODE_TYPE,
      props: {
        taskId,
        status: "running",
      },
    },
  ]);
  editor.updateShapes<CanvasGenerationPlaceholderShape>(
    workflow.placements.map((placement, index) => ({
      id: placement.id,
      type: CANVAS_GENERATION_PLACEHOLDER_TYPE,
      props: {
        taskId,
        outputIndex: index,
      },
    })),
  );
}

function markWorkflowFailed(editor: Editor, workflow: WorkflowRun, error: string): void {
  markPlaceholdersFailed(editor, workflow.placements.map((placement) => placement.id), error);
  editor.updateShapes<CanvasWorkflowNodeShape>([
    {
      id: workflow.nodeId,
      type: CANVAS_WORKFLOW_NODE_TYPE,
      props: {
        status: "failed",
        error,
      },
    },
  ]);
}

function updateWorkflowNodeStatus(
  editor: Editor,
  workflow: WorkflowCluster | undefined,
  status: "succeeded" | "failed" | "canceled",
  error = "",
  outputCount?: number,
): void {
  if (!workflow) return;
  const shape = editor.getShape(workflow.nodeId);
  if (!shape || shape.type !== CANVAS_WORKFLOW_NODE_TYPE) return;
  editor.updateShapes<CanvasWorkflowNodeShape>([
    {
      id: workflow.nodeId,
      type: CANVAS_WORKFLOW_NODE_TYPE,
      props: {
        status,
        error,
        ...(outputCount === undefined ? {} : { outputCount }),
      },
    },
  ]);
}

function workflowTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\n+/)[0] ?? "生成任务";
  return firstLine.length > 28 ? `${firstLine.slice(0, 28)}...` : firstLine || "生成任务";
}

function getShapeBounds(editor: Editor, shapeId: TLShapeId): CanvasBounds | null {
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) return null;
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.w,
    height: bounds.h,
  };
}

function getSelectionBounds(editor: Editor): CanvasBounds | null {
  const bounds = editor.getSelectionPageBounds();
  if (!bounds) {
    return null;
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.w,
    height: bounds.h,
  };
}

function boundsOverlap(left: CanvasBounds, right: CanvasBounds): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function unionReferenceBounds(editor: Editor, references: CanvasImageReference[]): CanvasBounds | null {
  const bounds = references
    .map((reference) => getShapeBounds(editor, reference.shapeId))
    .filter((item): item is CanvasBounds => Boolean(item));
  if (bounds.length === 0) {
    return null;
  }
  const minX = Math.min(...bounds.map((item) => item.x));
  const minY = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function boundsFromPoints(points: Array<{ x: number; y: number }>): CanvasBounds {
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function createBoundFlowConnectorShape(
  editor: Editor,
  input: {
    fromShapeId: TLShapeId;
    toShapeId: TLShapeId;
    fromSide: CanvasConnectorSide;
    toSide: CanvasConnectorSide;
    fromBias: number;
    toBias: number;
    label: string;
    tone: "reference" | "output" | "draft";
  },
): CanvasFlowConnectorPartial[] {
  const fromBounds = getShapeBounds(editor, input.fromShapeId);
  const toBounds = getShapeBounds(editor, input.toShapeId);
  if (!fromBounds || !toBounds) {
    return [];
  }
  const geometry = connectorGeometry(
    connectorAnchor(fromBounds, input.fromSide, input.fromBias),
    connectorAnchor(toBounds, input.toSide, input.toBias),
  );
  return [
    {
      id: createShapeId(),
      type: CANVAS_FLOW_CONNECTOR_TYPE,
      x: geometry.x,
      y: geometry.y,
      isLocked: canvasFlowConnectorIsLocked,
      props: {
        w: geometry.width,
        h: geometry.height,
        x1: geometry.x1,
        y1: geometry.y1,
        x2: geometry.x2,
        y2: geometry.y2,
        label: input.label,
        tone: input.tone,
        fromShapeId: input.fromShapeId,
        toShapeId: input.toShapeId,
        fromSide: input.fromSide,
        toSide: input.toSide,
        fromBias: input.fromBias,
        toBias: input.toBias,
      },
    },
  ];
}

function updateBoundFlowConnectors(editor: Editor): void {
  const updates = editor.getCurrentPageShapes().flatMap((shape) => {
    if (!isFlowConnectorShape(shape)) {
      return [];
    }
    const fromShapeId = shape.props.fromShapeId;
    const toShapeId = shape.props.toShapeId;
    if (!fromShapeId || !toShapeId) {
      return [];
    }
    const fromBounds = getShapeBounds(editor, fromShapeId as TLShapeId);
    const toBounds = getShapeBounds(editor, toShapeId as TLShapeId);
    if (!fromBounds || !toBounds) {
      return [];
    }
    const geometry = connectorGeometry(
      connectorAnchor(fromBounds, shape.props.fromSide ?? "right", shape.props.fromBias ?? 0.5),
      connectorAnchor(toBounds, shape.props.toSide ?? "left", shape.props.toBias ?? 0.5),
    );
    const currentGeometry = {
      x: shape.x,
      y: shape.y,
      width: shape.props.w,
      height: shape.props.h,
      x1: shape.props.x1,
      y1: shape.props.y1,
      x2: shape.props.x2,
      y2: shape.props.y2,
    };
    if (!shouldRefreshConnectorGeometry(currentGeometry, geometry)) {
      return [];
    }
    return [
      {
        id: shape.id,
        type: CANVAS_FLOW_CONNECTOR_TYPE,
        x: geometry.x,
        y: geometry.y,
        isLocked: canvasFlowConnectorIsLocked,
        props: {
          w: geometry.width,
          h: geometry.height,
          x1: geometry.x1,
          y1: geometry.y1,
          x2: geometry.x2,
          y2: geometry.y2,
        },
      } satisfies TLShapePartial<CanvasFlowConnectorShape>,
    ];
  });

  updateFlowConnectorShapes(editor, updates);
}

function updateFlowConnectorShapes(editor: Editor, updates: Array<TLShapePartial<CanvasFlowConnectorShape>>): void {
  if (updates.length === 0) {
    return;
  }
  editor.run(() => {
    editor.updateShapes<CanvasFlowConnectorShape>(updates);
  }, { history: "ignore", ignoreShapeLock: true });
}

function pruneOrphanFlowConnectors(editor: Editor): void {
  const orphanIds = editor.getCurrentPageShapes().flatMap((shape) => {
    if (!isFlowConnectorShape(shape)) {
      return [];
    }
    const fromShapeId = shape.props.fromShapeId as TLShapeId | undefined;
    const toShapeId = shape.props.toShapeId as TLShapeId | undefined;
    if ((fromShapeId && !editor.getShape(fromShapeId)) || (toShapeId && !editor.getShape(toShapeId))) {
      return [shape.id];
    }
    return [];
  });
  unlockAndDeleteShapes(editor, orphanIds);
}

function hydrateLooseFlowConnectors(editor: Editor): void {
  const candidates = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type !== CANVAS_FLOW_CONNECTOR_TYPE)
    .map((shape) => ({ shapeId: shape.id, bounds: getShapeBounds(editor, shape.id) }))
    .filter((item): item is { shapeId: TLShapeId; bounds: CanvasBounds } => Boolean(item.bounds));
  if (candidates.length < 2) {
    return;
  }

  const updates = editor.getCurrentPageShapes().flatMap((shape) => {
    if (!isFlowConnectorShape(shape) || (shape.props.fromShapeId && shape.props.toShapeId)) {
      return [];
    }
    const start = { x: shape.x + shape.props.x1, y: shape.y + shape.props.y1 };
    const end = { x: shape.x + shape.props.x2, y: shape.y + shape.props.y2 };
    const from = nearestConnectorBinding(candidates, start);
    const to = nearestConnectorBinding(candidates, end, from?.shapeId);
    if (!from || !to || from.distance > 120 || to.distance > 120) {
      return [];
    }
    const geometry = connectorGeometry(
      connectorAnchor(from.bounds, from.side, from.bias),
      connectorAnchor(to.bounds, to.side, to.bias),
    );
    return [
      {
        id: shape.id,
        type: CANVAS_FLOW_CONNECTOR_TYPE,
        x: geometry.x,
        y: geometry.y,
        isLocked: canvasFlowConnectorIsLocked,
        props: {
          w: geometry.width,
          h: geometry.height,
          x1: geometry.x1,
          y1: geometry.y1,
          x2: geometry.x2,
          y2: geometry.y2,
          fromShapeId: from.shapeId,
          toShapeId: to.shapeId,
          fromSide: from.side,
          toSide: to.side,
          fromBias: from.bias,
          toBias: to.bias,
        },
      } satisfies TLShapePartial<CanvasFlowConnectorShape>,
    ];
  });

  updateFlowConnectorShapes(editor, updates);
}

function nearestConnectorBinding(
  candidates: Array<{ shapeId: TLShapeId; bounds: CanvasBounds }>,
  point: { x: number; y: number },
  excludedShapeId?: TLShapeId,
): { shapeId: TLShapeId; bounds: CanvasBounds; side: CanvasConnectorSide; bias: number; distance: number } | null {
  let best: { shapeId: TLShapeId; bounds: CanvasBounds; side: CanvasConnectorSide; bias: number; distance: number } | null = null;
  const sides: CanvasConnectorSide[] = ["left", "right", "top", "bottom"];

  for (const candidate of candidates) {
    if (candidate.shapeId === excludedShapeId) {
      continue;
    }
    for (const side of sides) {
      const bias = connectorBiasForPoint(candidate.bounds, side, point);
      const anchor = connectorAnchor(candidate.bounds, side, bias);
      const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y);
      if (!best || distance < best.distance) {
        best = { ...candidate, side, bias, distance };
      }
    }
  }

  return best;
}

function connectorBiasForPoint(bounds: CanvasBounds, side: CanvasConnectorSide, point: { x: number; y: number }): number {
  if (side === "left" || side === "right") {
    return clamp((point.y - bounds.y) / Math.max(1, bounds.height), 0.08, 0.92);
  }
  if (side === "top" || side === "bottom") {
    return clamp((point.x - bounds.x) / Math.max(1, bounds.width), 0.08, 0.92);
  }
  return 0.5;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(max, Math.max(min, value));
}

function rebindWorkflowOutputConnectors(
  editor: Editor,
  workflow: WorkflowCluster | undefined,
  imageShapeIds: TLShapeId[],
): void {
  if (!workflow || imageShapeIds.length === 0) {
    return;
  }
  const updates = workflow.connectorIds.flatMap((id, index) => {
    const shape = editor.getShape(id);
    if (!isFlowConnectorShape(shape) || shape.props.tone === "reference") {
      return [];
    }
    const nextTargetId = imageShapeIds[index] ?? imageShapeIds[0];
    if (!nextTargetId) {
      return [];
    }
    return [
      {
        id: shape.id,
        type: CANVAS_FLOW_CONNECTOR_TYPE,
        isLocked: canvasFlowConnectorIsLocked,
        props: {
          toShapeId: nextTargetId,
          tone: "output",
        },
      } satisfies TLShapePartial<CanvasFlowConnectorShape>,
    ];
  });

  updateFlowConnectorShapes(editor, updates);
}

function removeWorkflowOutputConnectors(editor: Editor, workflow: WorkflowCluster | undefined): void {
  if (!workflow) {
    return;
  }
  const connectorIds = workflow.connectorIds.filter((id) => {
    const shape = editor.getShape(id);
    return isFlowConnectorShape(shape) && shape.props.tone !== "reference";
  });
  if (connectorIds.length > 0) {
    unlockAndDeleteShapes(editor, connectorIds);
  }
}

function unlockAndDeleteShapes(editor: Editor, ids: TLShapeId[]): void {
  if (ids.length === 0) {
    return;
  }
  const updates = ids.flatMap((id) => {
    const shape = editor.getShape(id);
    if (!shape?.isLocked) {
      return [];
    }
    return [
      {
        id: shape.id,
        type: shape.type,
        isLocked: false,
      } satisfies TLShapePartial<TLShape>,
    ];
  });
  editor.run(() => {
    if (updates.length > 0) {
      editor.updateShapes(updates);
    }
    editor.deleteShapes(ids);
  });
}

function isFlowConnectorShape(shape: unknown): shape is CanvasFlowConnectorShape {
  return Boolean(shape && typeof shape === "object" && (shape as { type?: unknown }).type === CANVAS_FLOW_CONNECTOR_TYPE);
}

function isWorkflowNodeShape(shape: unknown): shape is CanvasWorkflowNodeShape {
  return Boolean(shape && typeof shape === "object" && (shape as { type?: unknown }).type === CANVAS_WORKFLOW_NODE_TYPE);
}

function isImageSizeOption(value: unknown): value is ImageSizeOption {
  return typeof value === "string" && (sizeOptions as readonly string[]).includes(value);
}

function normalizeCanvasQuantity(value: unknown): 1 | 2 | 4 {
  return value === 2 || value === 4 ? value : 1;
}

function canvasWorkflowStatusLabel(status: CanvasWorkflowNodeShape["props"]["status"]): string {
  switch (status) {
    case "draft":
      return "示例";
    case "running":
      return "生成中";
    case "succeeded":
      return "完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已停止";
    default:
      return "未知";
  }
}

function isPlaceholderShape(shape: unknown): shape is CanvasGenerationPlaceholderShape {
  return Boolean(shape && typeof shape === "object" && (shape as { type?: unknown }).type === CANVAS_GENERATION_PLACEHOLDER_TYPE);
}

function livePlaceholderPlacement(editor: Editor, id: TLShapeId): PlaceholderPlacement | null {
  const shape = editor.getShape(id);
  if (!isPlaceholderShape(shape)) {
    return null;
  }
  return {
    id,
    x: shape.x,
    y: shape.y,
    width: shape.props.w,
    height: shape.props.h,
  };
}

function markPlaceholdersFailed(editor: Editor, placeholderIds: TLShapeId[], error: string): void {
  const updates = placeholderIds.flatMap((id) => {
    const shape = editor.getShape(id);
    if (!isPlaceholderShape(shape)) {
      return [];
    }
    return [
      {
        id,
        type: CANVAS_GENERATION_PLACEHOLDER_TYPE,
        props: { status: "failed", error },
      } satisfies TLShapePartial<CanvasGenerationPlaceholderShape>,
    ];
  });
  if (updates.length > 0) {
    editor.updateShapes<CanvasGenerationPlaceholderShape>(updates);
  }
}

function replacePlaceholdersWithImages(editor: Editor, placeholderIds: TLShapeId[], images: PublicImage[], prompt: string): TLShapeId[] {
  const shapes: Array<Partial<TLImageShape> & { id: TLShapeId; type: "image" }> = [];
  const assets: TLAsset[] = [];
  const deletedIds: TLShapeId[] = [];

  images.forEach((image, index) => {
    const placement = livePlaceholderPlacement(editor, placeholderIds[index] ?? placeholderIds[0]);
    const asset = createGeneratedAsset(image);
    const fallbackSize = displaySize(image.width, image.height);
    assets.push(asset);
    shapes.push(
      createImageShape({
        assetId: asset.id,
        url: image.url,
        width: placement?.width ?? fallbackSize.width,
        height: placement?.height ?? fallbackSize.height,
        x: placement?.x ?? editor.getViewportPageBounds().center.x,
        y: placement?.y ?? editor.getViewportPageBounds().center.y,
        altText: prompt,
        identity: {
          imageId: image.id,
          kind: "generated",
          taskId: image.taskId,
          prompt,
        },
      }),
    );
    if (placement) {
      deletedIds.push(placement.id);
    }
  });

  editor.run(() => {
    if (deletedIds.length > 0) {
      editor.deleteShapes(deletedIds);
    }
    const newAssets = assets.filter((asset) => !editor.getAsset(asset.id));
    if (newAssets.length > 0) {
      editor.createAssets(newAssets);
    }
    if (shapes.length > 0) {
      editor.createShapes(shapes);
      editor.select(...shapes.map((shape) => shape.id));
    }
  });
  return shapes.map((shape) => shape.id);
}

function findCanvasShapeByImageId(editor: Editor, imageId: string): TLShapeId | null {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "image") {
      continue;
    }
    const imageShape = shape as TLImageShape;
    const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
    const meta = (asset?.meta ?? {}) as Record<string, unknown>;
    const embeddedIdentity = decodeCanvasImageAltText(imageShape.props.altText);
    const urlIdentity = decodeCanvasImageUrl(imageShape.props.url);
    if (
      meta.generatedImageId === imageId ||
      meta.sourceImageId === imageId ||
      embeddedIdentity?.imageId === imageId ||
      urlIdentity?.imageId === imageId
    ) {
      return imageShape.id;
    }
  }
  return null;
}

function zoomToShape(editor: Editor | null, shapeId: TLShapeId): void {
  if (!editor) return;
  const bounds = editor.getShapePageBounds(shapeId);
  editor.select(shapeId);
  if (bounds) {
    editor.zoomToBounds(bounds, { animation: { duration: 220 }, inset: 96 });
  } else {
    editor.zoomToSelection({ animation: { duration: 220 } });
  }
}

function stripTransientCanvasRecords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTransientCanvasRecords).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.type === CANVAS_GENERATION_PLACEHOLDER_TYPE) {
    const props = record.props && typeof record.props === "object" ? (record.props as Record<string, unknown>) : {};
    return props.status === "draft" || props.status === "failed" ? record : undefined;
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const stripped = stripTransientCanvasRecords(child);
    if (stripped !== undefined) {
      next[key] = stripped;
    }
  }
  return next;
}
