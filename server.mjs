import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(appDir, "dist");
const port = Number(process.env.PORT || 3000);
const dataDir = resolve(process.env.DATA_DIR || join(appDir, ".data"));
const publicDataDir = join(dataDir, "public");
const artifactsDir = join(publicDataDir, "artifacts");
const coversDir = join(publicDataDir, "covers");
const inputsDir = join(publicDataDir, "inputs");
const tasksFile = join(dataDir, "tasks.json");
const characterDesignsFile = join(dataDir, "character-designs.json");
const publicTasksFile = join(publicDataDir, "tasks.json");
const arkApiKey = process.env.ARK_API_KEY || "";
const arkBaseUrl = (process.env.ARK_API_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
const arkParamStyle = process.env.ARK_PARAM_STYLE || "inline";
const configuredArkTitleModel = process.env.ARK_TITLE_MODEL || "";
const arkTitleModels = uniqueTitleModels([
  process.env.ARK_VLM_TITLE_MODEL,
  configuredArkTitleModel && configuredArkTitleModel !== "ep-20260512155127-ngn88" ? configuredArkTitleModel : "",
  "doubao-seed-2-0-pro-260215",
  "doubao-seed-1-6-vision-250815",
]);
const arkImageModel = process.env.ARK_IMAGE_MODEL || process.env.ARK_IMAGE_GEN_MODEL || "ep-20260309164315-zbvxd";
const arkImageSize = process.env.ARK_IMAGE_SIZE || "2K";
const arkImageTimeoutMs = Number(process.env.ARK_IMAGE_TIMEOUT_MS || 120_000);
const arkImageGridTimeoutMs = Number(process.env.ARK_IMAGE_GRID_TIMEOUT_MS || 300_000);
const arkImageGridMaxImages = clampInt(process.env.ARK_IMAGE_GRID_MAX_IMAGES, 1, 15, 12);
const arkSheetSize = process.env.ARK_IMAGE_SHEET_SIZE || "2048x2048";
const designClaimTtlMs = Number(process.env.DESIGN_CLAIM_TTL_MS || 30 * 60 * 1000);
const designInboxTtlMs = Number(process.env.DESIGN_INBOX_TTL_MS || 60 * 60 * 1000);
const arkImagePromptModels = uniqueTitleModels([
  process.env.ARK_IMAGE_PROMPT_MODEL,
  process.env.ARK_VLM_TITLE_MODEL,
  "doubao-seed-2-0-pro-260215",
  "doubao-seed-1-6-vision-250815",
]);
const arkTitleTimeoutMs = Number(process.env.ARK_TITLE_TIMEOUT_MS || 20000);
const arkTitleImageFetchTimeoutMs = Number(process.env.ARK_TITLE_IMAGE_FETCH_TIMEOUT_MS || 8000);
const arkTitleMaxImageBytes = Number(process.env.ARK_TITLE_MAX_IMAGE_BYTES || 5 * 1024 * 1024);
const monitorMode = process.env.TASK_MONITOR_MODE === "webhook" ? "webhook" : "poll";
const callbackBaseUrl = (process.env.ARK_CALLBACK_BASE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.ARK_CALLBACK_BASE_URL || "").replace(/\/+$/, "");
const webhookToken = process.env.ARK_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || process.env.MCP_TOKEN || "";
const webAccessToken = process.env.WEB_ACCESS_TOKEN || process.env.STUDIO_ACCESS_TOKEN || process.env.MCP_TOKEN || "";
const maxImageBytes = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);
const maxAudioBytes = Number(process.env.MAX_AUDIO_BYTES || 15 * 1024 * 1024);
const maxJsonBodyBytes = Number(process.env.MAX_JSON_BODY_BYTES || Math.ceil(Math.max(maxImageBytes, maxAudioBytes) * 1.5) + 1024 * 1024);
const maxArtifactBytes = Number(process.env.MAX_ARTIFACT_BYTES || 500 * 1024 * 1024);
const imageRepoBaseUrl = (
  process.env.CLOUD_REPO_BASE_URL ||
  process.env.IMAGE_REPO_BASE_URL ||
  process.env.IMAGEREPO_BASE_URL ||
  "https://cloud.zaynjarvis.com"
).replace(/\/+$/, "");
const imageRepoUploadKey = process.env.CLOUD_REPO_UPLOAD_KEY || process.env.IMAGE_REPO_UPLOAD_KEY || process.env.IMAGEREPO_UPLOAD_KEY || process.env.MCP_TOKEN || "";
const imageRepoTag = (process.env.IMAGE_REPO_TAG || process.env.IMAGEREPO_TAG || "studio").trim();
const shutdownGraceMs = clampInt(process.env.SHUTDOWN_GRACE_MS, 1_000, 60_000, 20_000);

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "expired"]);
const referenceOnlyImageRoles = new Set([
  "character_reference",
  "character_sheet",
  "infographic",
  "info_graph",
  "model_sheet",
  "reference",
  "reference_only",
  "turnaround",
]);
const sceneFrameImageRoles = new Set([
  "first_frame",
  "image_to_video",
  "i2v",
  "scene_first_frame",
  "scene_frame",
  "source_frame",
]);
const pollTimers = new Map();
const backgroundTimers = new Set();
const backgroundJobs = new Set();
const shutdownControllers = new Set();
const activeSockets = new Set();
const pollInflight = new Set();
const submissionInflight = new Set();
const artifactInflight = new Set();
const coverInflight = new Set();
let isShuttingDown = false;

mkdirSync(dataDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(coversDir, { recursive: true });
mkdirSync(inputsDir, { recursive: true });

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".aac": "audio/aac",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".webm": "video/webm",
};

let tasks = loadTasks();
let characterDesigns = loadCharacterDesigns();

for (const task of tasks.values()) {
  const normalizedTitle = limitTitle(task.title || titleFromPrompt(task.prompt));
  if (normalizedTitle !== task.title) {
    task.title = normalizedTitle;
    task.updatedAt = Date.now();
  }
  if (!task.arkTaskId && !terminalStatuses.has(task.status)) {
    scheduleArkSubmit(task.id, 1500);
  } else if (monitorMode === "poll" && !terminalStatuses.has(task.status)) {
    schedulePoll(task.id, 1500);
  }
  if (task.status === "succeeded" && (task.sourceVideoUrl || task.videoUrl) && !task.artifactUrl) {
    scheduleArtifactCache(task.id, "startup");
  }
  if (task.status === "succeeded" && task.artifactPath && !task.coverUrl) {
    scheduleCoverGeneration(task.id, "startup");
  }
  if (shouldRefreshGeneratedTitle(task)) {
    scheduleBackgroundTimer(() => {
      trackBackgroundJob(updateTaskTitle(task.id, inputFromTask(task)).catch((error) => {
        console.warn(`startup title refresh failed ${task.id}`, publicError(error));
      }));
    }, 3000);
  }
}
saveTasks();

function loadTasks() {
  try {
    if (!existsSync(tasksFile)) return new Map();
    const raw = JSON.parse(readFileSync(tasksFile, "utf8"));
    return new Map(Object.entries(raw.tasks || {}));
  } catch (error) {
    console.error("failed to load tasks", error);
    return new Map();
  }
}

function saveTasks() {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    tasks: Object.fromEntries(tasks),
  };
  const tmp = `${tasksFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, tasksFile);

  const publicPayload = {
    version: 1,
    updated_at: Date.now(),
    tasks: [...tasks.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicTask),
  };
  const publicTmp = `${publicTasksFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(publicTmp, JSON.stringify(publicPayload, null, 2));
  renameSync(publicTmp, publicTasksFile);
}

function cleanCharacterDesigns(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    key && item && typeof item === "object" && !Array.isArray(item)
  ));
}

function loadCharacterDesigns() {
  try {
    if (!existsSync(characterDesignsFile)) return {};
    const raw = JSON.parse(readFileSync(characterDesignsFile, "utf8"));
    return cleanCharacterDesigns(raw.characterDesigns || {});
  } catch (error) {
    console.error("failed to load character designs", error);
    return {};
  }
}

function saveCharacterDesigns() {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    characterDesigns: cleanCharacterDesigns(characterDesigns),
  };
  const tmp = `${characterDesignsFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, characterDesignsFile);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeResolution(value) {
  const raw = String(value || "1080p");
  if (raw.toLowerCase() === "2k") return "2K";
  return raw;
}

function normalizeStatus(status) {
  const raw = String(status || "queued").toLowerCase();
  if (["created", "pending", "submitted", "scheduled", "waiting", "not_started", "in_queue"].includes(raw)) return "queued";
  if (["processing", "rendering", "in_progress", "executing", "started"].includes(raw)) return "running";
  if (raw === "completed" || raw === "complete") return "succeeded";
  if (raw === "error") return "failed";
  return raw;
}

function normalizeImageRole(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!raw) return null;
  if (referenceOnlyImageRoles.has(raw)) return "character_reference";
  if (sceneFrameImageRoles.has(raw)) return "scene_first_frame";
  return raw;
}

function normalizeUrlList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const urls = [];
  for (const item of values) {
    const url = String(item || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function normalizeMediaUrlList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const urls = [];
  for (const item of values) {
    const candidate = typeof item === "object" && item !== null
      ? item.url || item.src || item.media_url || item.mediaUrl || item.media_path || item.mediaPath || item.audio_url || item.audioUrl
      : item;
    const url = String(candidate || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function boolFromInput(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function uniqueTitleModels(values) {
  const seen = new Set();
  const models = [];
  for (const value of values) {
    const model = String(value || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function promptMentionsReferenceAsset(prompt) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();
  return [
    /\bcharacter\s+(reference|sheet|design sheet|model sheet|turnaround|infographic)\b/,
    /\b(reference|model|turnaround|design)\s+(image|sheet|board|plate)\b/,
    /\binfo\s*graph(?:ic)?\b/,
    /\bstyle\s+sheet\b/,
    /角色.{0,8}(参考|设定|表|图|三视|转面|信息图)/,
    /(参考图|设定图|角色表|三视图|转面图|信息图|信息图表)/,
  ].some((pattern) => pattern.test(lower) || pattern.test(text));
}

function promptTreatsImageAsOpeningFrame(prompt) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();
  return [
    /\b(first|opening|initial|starting)\s+(frame|image|shot)\b/,
    /\b(start|starts|begin|begins|open|opens)\s+(with|from)\b/,
    /\banimat(?:e|es|ed|ing)\s+(?:from|the)?\s*(?:reference|character|sheet|infographic|image)/,
    /(首帧|第一帧|开场|开头|起始帧|起始画面)/,
    /(从|以).{0,12}(参考图|设定图|角色表|信息图|首帧|第一帧).{0,12}(开始|开场|生成|动起来)/,
  ].some((pattern) => pattern.test(lower) || pattern.test(text));
}

function referenceWorkflowMessage() {
  return [
    "Character sheets, infographics, turnarounds, and reference boards are identity references, not Seedance first frames.",
    "Pass them as reference_image_url, or use imagegen with thinking to create the actual storyboard/scene frame first and pass that frame as image_url with image_role=\"scene_first_frame\".",
  ].join(" ");
}

function rejectReferenceAsFirstFrame(message) {
  throw httpError(400, "reference_requires_scene_frame", message || referenceWorkflowMessage());
}

function assertVideoPromptDoesNotUseReferenceAsFirstFrame(prompt) {
  if (promptMentionsReferenceAsset(prompt) && promptTreatsImageAsOpeningFrame(prompt)) {
    rejectReferenceAsFirstFrame("The prompt appears to describe a character sheet/infographic/reference board as the opening or first frame. Rewrite the video prompt around the real scene action, and generate the scene frame with imagegen before creating the video task.");
  }
}

function resolveModel() {
  return process.env.ARK_MODEL_PRO || "doubao-seedance-2-0-260128";
}

function callbackUrlForTask(id) {
  if (monitorMode !== "webhook") return null;
  if (!callbackBaseUrl) {
    throw httpError(500, "callback_base_url_missing", "ARK_CALLBACK_BASE_URL or PUBLIC_BASE_URL is required in webhook mode.");
  }

  const url = new URL("/api/ark/webhook", callbackBaseUrl);
  url.searchParams.set("task_id", id);
  if (webhookToken) {
    url.searchParams.set("token", webhookToken);
  }
  return url.toString();
}

function limitTitle(title, fallback = "Untitled take") {
  let clean = String(title || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  clean = clean
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[#*\-\s]+/, "")
    .replace(/^(title|标题)\s*[:：]\s*/i, "")
    .replace(/[.。!！?？:：;；]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return fallback;

  if (/[\u3400-\u9fff]/.test(clean)) {
    return clean.replace(/\s+/g, "").slice(0, 10) || fallback;
  }

  const words = clean.split(" ").filter(Boolean).slice(0, 5).join(" ");
  return words.slice(0, 60).trim() || fallback;
}

function titleFromPrompt(prompt) {
  const raw = String(prompt || "");
  return limitTitle((raw.split(/[.,;\n，。；]/)[0] || "Untitled take").trim());
}

function shouldRefreshGeneratedTitle(task) {
  const title = String(task?.title || "").trim().toLowerCase();
  if (title !== "untitled take") return false;

  const hasImages = Boolean(task.inputImageUrl || task.lastFrameImageUrl)
    || normalizeUrlList(task.referenceImageUrls || task.referenceImageUrl).length > 0;
  if (!hasImages) return false;

  const createdAt = Number(task.createdAt || 0);
  return !createdAt || Date.now() - createdAt < 7 * 24 * 60 * 60 * 1000;
}

function cleanGeneratedTitle(text) {
  return limitTitle(text, "");
}

function titlePromptText(input, hasImages) {
  return [
    "Create a short production title for this video generation task.",
    hasImages
      ? "Use the attached image(s) as the primary source; base the title on visible subject, setting, action, or mood."
      : "No image is attached, so infer a concise visual title from the prompt without copying it.",
    "Return only the title, no quotes, no prefix, and do not copy or truncate the prompt.",
    "If the prompt is Chinese, use Chinese and keep it 4 to 10 characters. Otherwise use English and keep it 2 to 5 words.",
    `Video prompt: ${input.prompt}`,
  ].join("\n");
}

function titleImageUrls(input) {
  return normalizeUrlList([
    input.imageUrl,
    input.lastFrameImageUrl,
    ...normalizeUrlList(input.referenceImageUrls),
  ]).slice(0, 4);
}

function mimeFromImageUrl(url) {
  const ext = extname(new URL(url, "https://local.invalid").pathname).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

async function titleImageDataUrl(imageUrl, signal = undefined) {
  const raw = String(imageUrl || "").trim();
  if (!raw || raw.startsWith("data:")) return raw;
  if (!/^https?:\/\//i.test(raw)) return raw;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), arkTitleImageFetchTimeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(raw, { signal: controller.signal });
    if (!response.ok) return raw;

    const contentType = String(response.headers.get("content-type") || mimeFromImageUrl(raw)).split(";")[0].trim() || "image/jpeg";
    if (!contentType.startsWith("image/")) return raw;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > arkTitleMaxImageBytes) return raw;
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.warn("title image fetch failed", publicError(error));
    return raw;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function extractResponseText(raw) {
  if (typeof raw?.output_text === "string") return raw.output_text;

  const texts = [];
  const collectContent = (content) => {
    if (typeof content === "string") {
      texts.push(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (typeof item?.text === "string") texts.push(item.text);
      if (typeof item?.output_text === "string") texts.push(item.output_text);
    }
  };

  if (Array.isArray(raw?.output)) {
    for (const item of raw.output) {
      if (typeof item?.text === "string") texts.push(item.text);
      collectContent(item?.content);
    }
  }

  if (Array.isArray(raw?.choices)) {
    for (const choice of raw.choices) {
      collectContent(choice?.message?.content);
      if (typeof choice?.message?.content === "string") texts.push(choice.message.content);
      if (typeof choice?.text === "string") texts.push(choice.text);
    }
  }

  return texts.join("\n").trim();
}

async function generateTaskTitle(input, signal = undefined) {
  const fallback = titleFromPrompt(input.prompt);
  if (!arkTitleModels.length) return fallback;

  const controller = new AbortController();
  const abortTitle = () => controller.abort();
  signal?.addEventListener("abort", abortTitle, { once: true });
  const timeout = setTimeout(() => controller.abort(), arkTitleTimeoutMs);
  timeout.unref?.();

  const createTitleWithChat = async (model, imageUrls) => {
    const content = [{
      type: "text",
      text: titlePromptText(input, imageUrls.length > 0),
    }];

    for (const imageUrl of imageUrls) {
      content.push({ type: "image_url", image_url: { url: imageUrl } });
    }

    const raw = await arkFetch("/chat/completions", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 64,
        temperature: 0.2,
      }),
    });
    return cleanGeneratedTitle(extractResponseText(raw));
  };

  const createTitleWithResponses = async (model, imageUrls) => {
    const content = [{
      type: "input_text",
      text: titlePromptText(input, imageUrls.length > 0),
    }];

    for (const imageUrl of imageUrls) {
      content.push({ type: "input_image", image_url: imageUrl });
    }

    const raw = await arkFetch("/responses", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [{ role: "user", content }],
        max_output_tokens: 64,
        temperature: 0.2,
      }),
    });
    return cleanGeneratedTitle(extractResponseText(raw));
  };

  const createTitle = async (model, imageUrls) => {
    try {
      const title = await createTitleWithChat(model, imageUrls);
      if (title) return title;
      console.warn(`vlm title generation returned no title from chat completions with ${model}`);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      console.warn(`chat title generation failed with ${model}`, publicError(error));
    }

    return createTitleWithResponses(model, imageUrls);
  };

  try {
    const imageUrls = await Promise.all(titleImageUrls(input).map((url) => titleImageDataUrl(url, controller.signal)));

    for (const model of arkTitleModels) {
      try {
        if (imageUrls.length) {
          const title = await createTitle(model, imageUrls);
          if (title) return title;
          console.warn(`vlm title generation returned no title with ${model}; retrying text-only`);
        }

        const title = await createTitle(model, []);
        if (title) return title;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.warn(`title generation failed with ${model}`, publicError(error));
      }
    }

    return fallback;
  } catch (error) {
    console.warn("title generation failed", publicError(error));
    return fallback;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortTitle);
  }
}

function estimateProgress(task) {
  if (task.status === "succeeded") return 100;
  if (terminalStatuses.has(task.status)) return task.progress || 0;

  const elapsed = Math.max(0, Date.now() - (task.createdAt || Date.now()));
  const expectedMs = Math.max(45_000, Number(task.duration || 5) * 12_000);
  const estimate = Math.min(94, Math.round((elapsed / expectedMs) * 88) + 6);

  if (task.status === "queued") return Math.min(estimate, 28);
  return Math.max(30, estimate);
}

function versionedLocalMediaUrl(path, version) {
  const raw = String(path || "");
  if (!raw) return null;
  if (!raw.startsWith("/media/")) return raw;
  if (!version) return raw;
  return `${raw}${raw.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
}

function publicVideoUrl(task) {
  if (task.artifactUrl) {
    return versionedLocalMediaUrl(task.artifactUrl, task.artifactCachedAt || task.updatedAt || task.finishedAt);
  }
  return task.videoUrl || null;
}

function publicThumbUrl(value) {
  const raw = String(value || "");
  if (!raw || raw.startsWith("data:")) return null;
  if (raw.length > 2048) return null;
  return raw;
}

function publicTaskThumbUrl(task) {
  if (task.coverUrl) {
    return publicThumbUrl(versionedLocalMediaUrl(task.coverUrl, task.coverGeneratedAt || task.updatedAt || task.finishedAt));
  }

  const raw = String(task.thumb || "");
  if (!raw) return null;
  if (task.inputImageUrl && raw === String(task.inputImageUrl)) return null;
  if (task.lastFrameImageUrl && raw === String(task.lastFrameImageUrl)) return null;
  if (task.referenceImageUrl && raw === String(task.referenceImageUrl)) return null;
  if (normalizeUrlList(task.referenceImageUrls).includes(raw)) return null;
  return publicThumbUrl(raw);
}

function publicMediaUrl(path, baseUrl = publicBaseUrl) {
  if (!path) return null;
  if (String(path).startsWith("http://") || String(path).startsWith("https://")) return path;
  if (!baseUrl) return path;
  return new URL(path, baseUrl).toString();
}

function absolutePublicUrl(value, baseUrl = publicBaseUrl) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || /^https?:\/\//i.test(raw)) return raw || null;
  return publicMediaUrl(raw, baseUrl);
}

function requestPublicBaseUrl(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers.host || "").split(",")[0].trim();
  if (!host) return "";

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) ? "http" : "https");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return "";
  }
}

function publicText(value, max = 4000) {
  const raw = String(value || "");
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function publicTask(task) {
  const taskMonitorMode = task.monitorMode || monitorMode;
  const activeWebhookTask = taskMonitorMode === "webhook" && !terminalStatuses.has(task.status);

  return {
    id: task.id,
    task_id: task.arkTaskId,
    status: task.status,
    progress: activeWebhookTask ? null : estimateProgress(task),
    video_url: publicVideoUrl(task),
    artifact_url: task.artifactUrl
      ? versionedLocalMediaUrl(task.artifactUrl, task.artifactCachedAt || task.updatedAt || task.finishedAt)
      : null,
    artifact_status: task.artifactStatus || (task.artifactUrl ? "ready" : null),
    artifact_bytes: task.artifactBytes || null,
    artifact_error: task.artifactError || null,
    cover_url: task.coverUrl
      ? versionedLocalMediaUrl(task.coverUrl, task.coverGeneratedAt || task.updatedAt || task.finishedAt)
      : null,
    cover_status: task.coverStatus || (task.coverUrl ? "ready" : null),
    cover_bytes: task.coverBytes || null,
    cover_error: task.coverError || null,
    error: task.error || null,
    title: publicText(task.title, 120),
    prompt: publicText(task.prompt, 4000),
    model: task.uiModel,
    ark_model: task.arkModel,
    mode: task.mode,
    resolution: task.resolution,
    aspect: task.aspect,
    duration: task.duration,
    camera: task.camera,
    seed: task.seed,
    image_role: task.imageRole || (task.inputImageUrl ? "scene_first_frame" : task.referenceImageUrl ? "character_reference" : "none"),
    image_id: task.imageId || null,
    source_frame_url: publicMediaUrl(task.inputImageUrl) || null,
    last_frame_url: publicMediaUrl(task.lastFrameImageUrl) || null,
    reference_image_url: publicMediaUrl(task.inputImageUrl) || null,
    character_reference_url: publicMediaUrl(task.referenceImageUrl) || null,
    character_reference_urls: normalizeUrlList(task.referenceImageUrls || task.referenceImageUrl).map((url) => publicMediaUrl(url)),
    character_reference_bytes: task.referenceImageBytes || null,
    reference_audio_url: publicMediaUrl(task.referenceAudioUrl) || null,
    reference_audio_urls: normalizeUrlList(task.referenceAudioUrls || task.referenceAudioUrl).map((url) => publicMediaUrl(url)),
    reference_audio_bytes: task.referenceAudioBytes || null,
    generate_audio: task.generateAudio !== false,
    reference_image_bytes: task.inputImageBytes || null,
    last_frame_bytes: task.lastFrameImageBytes || null,
    thumb: publicTaskThumbUrl(task),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    finished_at: task.finishedAt || null,
    last_poll_error: task.lastPollError || null,
    monitor_mode: taskMonitorMode,
  };
}

function sanitizeFilePart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || randomUUID();
}

function decodeDataImageUrl(value, label = "Image") {
  const match = String(value || "").match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) return null;

  const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const base64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length) {
    throw httpError(400, "image_invalid", `${label} data is empty.`);
  }
  if (buffer.length > maxImageBytes) {
    throw httpError(413, "image_too_large", `${label} is larger than MAX_IMAGE_BYTES.`);
  }

  return { buffer, mime, ext };
}

function decodeDataAudioUrl(value, label = "Audio") {
  const match = String(value || "").match(/^data:(audio\/(?:aac|m4a|mpeg|mp3|mp4|ogg|wav|wave|webm|x-wav));base64,([a-zA-Z0-9+/=\s]+)$/i);
  if (!match) return null;

  const rawMime = match[1].toLowerCase();
  const mime = rawMime === "audio/mp3"
    ? "audio/mpeg"
    : rawMime === "audio/x-wav" || rawMime === "audio/wave"
      ? "audio/wav"
      : rawMime === "audio/m4a"
        ? "audio/mp4"
        : rawMime;
  const ext = mime === "audio/aac"
    ? ".aac"
    : mime === "audio/mp4"
      ? ".m4a"
      : mime === "audio/ogg"
        ? ".ogg"
        : mime === "audio/wav"
          ? ".wav"
          : mime === "audio/webm"
            ? ".webm"
            : ".mp3";
  const base64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length) {
    throw httpError(400, "audio_invalid", `${label} data is empty.`);
  }
  if (buffer.length > maxAudioBytes) {
    throw httpError(413, "audio_too_large", `${label} is larger than MAX_AUDIO_BYTES.`);
  }

  return { buffer, mime, ext };
}

function persistInputImage(imageUrl, baseUrl = publicBaseUrl, label = "Reference image") {
  if (!imageUrl || !String(imageUrl).startsWith("data:")) return null;
  const decoded = decodeDataImageUrl(imageUrl, label);
  if (!decoded) {
    throw httpError(400, "image_invalid", `${label} is not a supported image data URL.`);
  }

  const mediaBaseUrl = baseUrl || publicBaseUrl;
  if (!mediaBaseUrl) {
    throw httpError(500, "public_base_url_missing", "PUBLIC_BASE_URL or a public request host is required to upload inline images.");
  }

  const filename = `${randomUUID()}${decoded.ext}`;
  const finalPath = join(inputsDir, filename);
  writeFileSync(finalPath, decoded.buffer);

  const mediaPath = `/media/inputs/${filename}`;
  return {
    url: publicMediaUrl(mediaPath, mediaBaseUrl),
    mediaPath,
    path: `inputs/${filename}`,
    bytes: decoded.buffer.length,
    mime: decoded.mime,
  };
}

function persistInputAudio(audioUrl, baseUrl = publicBaseUrl, label = "Reference audio") {
  if (!audioUrl || !String(audioUrl).startsWith("data:")) return null;
  const decoded = decodeDataAudioUrl(audioUrl, label);
  if (!decoded) {
    throw httpError(400, "audio_invalid", `${label} must be an AAC, MP3, MP4/M4A, OGG, WAV, or WEBM audio data URL.`);
  }

  const mediaBaseUrl = baseUrl || publicBaseUrl;
  if (!mediaBaseUrl) {
    throw httpError(500, "public_base_url_missing", "PUBLIC_BASE_URL or a public request host is required to upload inline audio.");
  }

  const filename = `${randomUUID()}${decoded.ext}`;
  const finalPath = join(inputsDir, filename);
  writeFileSync(finalPath, decoded.buffer);

  const mediaPath = `/media/inputs/${filename}`;
  return {
    url: publicMediaUrl(mediaPath, mediaBaseUrl),
    mediaPath,
    path: `inputs/${filename}`,
    bytes: decoded.buffer.length,
    mime: decoded.mime,
  };
}

function assertImageRepoConfigured() {
  if (!imageRepoBaseUrl) {
    throw httpError(500, "image_repo_missing", "CLOUD_REPO_BASE_URL or IMAGE_REPO_BASE_URL is required for image uploads.");
  }
  if (!imageRepoUploadKey) {
    throw httpError(500, "image_repo_key_missing", "CLOUD_REPO_UPLOAD_KEY or IMAGE_REPO_UPLOAD_KEY is required for image uploads.");
  }
}

async function uploadImageToRepo(imageUrl, name, label = "Image", tagOverride) {
  if (!imageUrl || !String(imageUrl).startsWith("data:")) return null;
  const decoded = decodeDataImageUrl(imageUrl, label);
  if (!decoded) {
    throw httpError(400, "image_invalid", `${label} is not a supported image data URL.`);
  }

  assertImageRepoConfigured();

  const uploadTag = (tagOverride || imageRepoTag);
  const filename = cleanImageUploadName(name, decoded.ext);
  const form = new FormData();
  form.append("file", new Blob([decoded.buffer], { type: decoded.mime }), filename);
  if (uploadTag) form.append("tag", uploadTag);

  const response = await fetch(`${imageRepoBaseUrl}/api/upload`, {
    method: "POST",
    headers: {
      "x-upload-key": imageRepoUploadKey,
    },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw httpError(
      response.status || 502,
      payload?.error?.code || "image_repo_upload_failed",
      payload?.error?.message || payload?.error || `Cloud upload failed with HTTP ${response.status}.`,
      payload
    );
  }
  if (!payload?.url) {
    throw httpError(502, "image_repo_bad_response", "Cloud did not return a URL.", payload);
  }

  return {
    url: payload.url,
    mediaPath: payload.url,
    path: null,
    key: payload.key || null,
    bytes: payload.size ?? decoded.buffer.length,
    mime: payload.contentType || decoded.mime,
    mediaType: payload.mediaType || "image",
    tag: payload.tag || uploadTag || "",
    duplicate: Boolean(payload.duplicate),
    provider: "cloud",
  };
}

function encodeCloudKeyPath(key) {
  return String(key || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

async function deleteImageFromRepo(key) {
  const cleanKey = String(key || "").trim();
  if (!cleanKey) {
    throw httpError(400, "image_key_required", "Image key is required.");
  }

  assertImageRepoConfigured();

  const response = await fetch(`${imageRepoBaseUrl}/api/images/${encodeCloudKeyPath(cleanKey)}`, {
    method: "DELETE",
    headers: {
      "x-upload-key": imageRepoUploadKey,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw httpError(
      response.status || 502,
      payload?.error?.code || "image_repo_delete_failed",
      payload?.error?.message || payload?.error || `Cloud delete failed with HTTP ${response.status}.`,
      payload
    );
  }

  return payload;
}

function cleanImageUploadName(name, fallbackExt) {
  const clean = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (clean) return clean;
  return `image${fallbackExt || ".jpg"}`;
}

function uploadedImagePayload(persisted, name) {
  const file = basename(persisted.path || persisted.key || "");
  return {
    id: `i_${file.replace(/\.[^.]+$/, "")}`,
    name: cleanImageUploadName(name, extname(file) || ".jpg"),
    src: persisted.url,
    url: persisted.url,
    media_path: persisted.mediaPath,
    path: persisted.path,
    key: persisted.key || null,
    tag: persisted.tag || null,
    provider: persisted.provider || "local",
    duplicate: Boolean(persisted.duplicate),
    bytes: persisted.bytes,
    mime: persisted.mime,
    mediaType: persisted.mediaType || "image",
    added_at: Date.now(),
  };
}

function normalizeTextList(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeImageSize(value) {
  const raw = String(value || arkImageSize || "").trim();
  if (/^\d{3,5}x\d{3,5}$/i.test(raw)) return raw.toLowerCase();
  if (/^[1-4]k$/i.test(raw)) return raw.toUpperCase();
  return "2K";
}

function cleanModelText(value, max = 1600) {
  return String(value || "")
    .replace(/^```(?:\w+)?/i, "")
    .replace(/```$/i, "")
    .trim()
    .slice(0, max);
}

function absoluteRequestUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("data:") || /^https?:\/\//i.test(raw)) return raw;
  if (!baseUrl) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function characterZoneContext(input = {}, mediaBaseUrl = publicBaseUrl) {
  const zone = input.zone && typeof input.zone === "object" ? input.zone : {};
  const characterName = String(input.character_name || input.characterName || input.name || "Character").trim();
  const characterCode = String(input.character_code || input.characterCode || input.code || "").trim();
  const zoneId = String(input.zone_id || input.zoneId || zone.id || "zone").trim();
  const zoneLabel = String(input.zone_label || input.zoneLabel || zone.label || zoneId).trim();
  const zoneRole = String(input.zone_role || input.zoneRole || zone.role || "").trim();
  const instruction = String(input.instruction || zone.instruction || zone.improvement || "").trim();
  const crop = Array.isArray(input.crop) ? input.crop : Array.isArray(zone.crop) ? zone.crop : [];
  const identityContract = normalizeTextList(input.identity_contract || input.identityContract);
  const negativePrompt = String(input.negative_prompt || input.negativePrompt || "").trim();
  const referenceUrls = normalizeUrlList([
    input.source_image_url || input.sourceImageUrl,
    input.reference_image_url || input.referenceImageUrl,
    input.current_image_url || input.currentImageUrl,
    ...(normalizeUrlList(input.reference_image_urls || input.referenceImageUrls)),
  ]).map((url) => absoluteRequestUrl(url, mediaBaseUrl));

  if (!instruction) {
    throw httpError(400, "instruction_required", "A zone improvement instruction is required.");
  }

  return {
    characterName,
    characterCode,
    zoneId,
    zoneLabel,
    zoneRole,
    instruction,
    crop,
    aspect: String(input.aspect || zone.aspect || "1:1").trim(),
    identityContract,
    negativePrompt,
    referenceUrls,
    size: normalizeImageSize(input.size || input.output_size || input.outputSize),
    seed: clampInt(input.seed, -1, 4_294_967_295, Math.floor(Math.random() * 99_999)),
    tag: String(input.tag || input.cloud_tag || "design").trim(),
  };
}

function buildCharacterZonePrompt(context, referencePrompt = "") {
  const contract = context.identityContract.length
    ? context.identityContract.join(" ")
    : "Preserve the exact same character identity, proportions, material texture, lighting, and expression from the source reference.";
  const cropText = context.crop.length ? `Crop coordinates from the source sheet: [${context.crop.join(", ")}].` : "";

  return [
    "Generate exactly ONE photorealistic Studio character identity-dossier image of a single subject.",
    `Character: ${context.characterName}${context.characterCode ? ` (${context.characterCode})` : ""}.`,
    `Zone: ${context.zoneId} / ${context.zoneLabel}.`,
    context.zoneRole ? `Zone role: ${context.zoneRole}.` : "",
    `Requested improvement: ${context.instruction}`,
    referencePrompt ? `Reference-derived visual brief: ${referencePrompt}` : "",
    `Mandatory reference use: the attached/source image(s) are the visual authority. Use them as real image references, not just as text inspiration; do not invent a different face, age, body type, hairstyle, outfit, palette, or signature details.`,
    `Identity lock: ${contract} Keep the same single subject identity, proportions, colors, and signature details as the source.`,
    cropText,
    `Output composition: one clean single-subject image, ${context.aspect} aspect intent, subject centered and fully in frame, plain soft light-gray seamless studio background, even neutral studio lighting.`,
    `Strictly NO contact-sheet grid, no collage, no side-by-side panels, no split frames, no text, no labels, no captions, no numbers, no annotations, no borders with text, no UI, and no watermark.`,
    context.negativePrompt ? `Negative prompt: ${context.negativePrompt}` : "",
  ].filter(Boolean).join("\n");
}

async function buildReferenceAwarePrompt(context, signal = undefined) {
  const urls = context.referenceUrls.slice(0, 3);
  if (!arkImagePromptModels.length || !urls.length) return "";

  const images = [];
  for (const url of urls) {
    const image = await titleImageDataUrl(url, signal);
    if (image) images.push(image);
  }
  if (!images.length) return "";

  const promptText = [
    "You are writing a reference-aware prompt for an image generation model.",
    "Use the attached character/reference images to describe the visible identity cues that must be preserved.",
    "Return one compact English prompt paragraph only. No markdown, no bullets, no preface.",
    `Target zone: ${context.zoneId} / ${context.zoneLabel}.`,
    context.zoneRole ? `Zone role: ${context.zoneRole}.` : "",
    `Requested change: ${context.instruction}`,
    context.identityContract.length ? `Identity rules: ${context.identityContract.join(" ")}` : "",
    context.negativePrompt ? `Avoid: ${context.negativePrompt}` : "",
  ].filter(Boolean).join("\n");

  for (const model of arkImagePromptModels) {
    try {
      const chatContent = [{ type: "text", text: promptText }];
      for (const image of images) {
        chatContent.push({ type: "image_url", image_url: { url: image } });
      }
      const chatRaw = await arkFetch("/chat/completions", {
        method: "POST",
        signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: chatContent }],
          max_tokens: 420,
          temperature: 0.2,
        }),
      });
      const chatText = cleanModelText(extractResponseText(chatRaw));
      if (chatText) return chatText;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`character reference chat prompt failed with ${model}`, publicError(error));
    }

    try {
      const responseContent = [{ type: "input_text", text: promptText }];
      for (const image of images) {
        responseContent.push({ type: "input_image", image_url: image });
      }
      const raw = await arkFetch("/responses", {
        method: "POST",
        signal,
        body: JSON.stringify({
          model,
          input: [{ role: "user", content: responseContent }],
          max_output_tokens: 420,
          temperature: 0.2,
        }),
      });
      const text = cleanModelText(extractResponseText(raw));
      if (text) return text;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`character reference responses prompt failed with ${model}`, publicError(error));
    }
  }

  return "";
}

function extractGeneratedImage(raw = {}) {
  const items = [
    ...(Array.isArray(raw.data) ? raw.data : []),
    ...(Array.isArray(raw.images) ? raw.images : []),
    raw.image,
    raw.result,
  ].filter(Boolean);

  for (const item of items) {
    if (typeof item === "string") {
      if (item.startsWith("data:")) return { dataUrl: item };
      if (/^https?:\/\//i.test(item)) return { url: item };
    }
    const url = item?.url || item?.image_url || item?.imageUrl || item?.output_url || item?.outputUrl;
    if (typeof url === "string" && url) return { url };
    const b64 = item?.b64_json || item?.b64Json || item?.base64 || item?.image_base64 || item?.imageBase64;
    if (typeof b64 === "string" && b64) {
      const mime = item?.mime || item?.content_type || item?.contentType || "image/jpeg";
      return { dataUrl: `data:${mime};base64,${b64.replace(/^data:[^,]+,/, "")}` };
    }
  }

  const url = raw.url || raw.image_url || raw.imageUrl || raw.output_url || raw.outputUrl || normalizeUrlList(raw.output_urls || raw.outputUrls)[0];
  if (typeof url === "string" && url) return { url };

  throw httpError(502, "image_generation_empty", "Ark image generation returned no image.");
}

async function imageUrlToDataUrl(imageUrl, label = "Image", signal = undefined) {
  const raw = String(imageUrl || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw;
  if (!/^https?:\/\//i.test(raw)) return null;

  const response = await fetch(raw, { signal });
  if (!response.ok) {
    throw httpError(response.status || 502, "generated_image_fetch_failed", `Could not fetch ${label.toLowerCase()} for storage.`);
  }

  const contentType = String(response.headers.get("content-type") || mimeFromImageUrl(raw)).split(";")[0].trim() || "image/jpeg";
  if (!contentType.startsWith("image/")) {
    throw httpError(502, "generated_image_not_image", `${label} response was not an image.`);
  }

  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxImageBytes) {
    throw httpError(413, "generated_image_too_large", `${label} is larger than MAX_IMAGE_BYTES.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw httpError(502, "generated_image_empty", `${label} response was empty.`);
  }
  if (buffer.length > maxImageBytes) {
    throw httpError(413, "generated_image_too_large", `${label} is larger than MAX_IMAGE_BYTES.`);
  }

  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function persistGeneratedImage(generated, name, tag, signal) {
  let dataUrl = generated.dataUrl || null;
  let persisted = null;
  let persistError = null;
  if (!dataUrl && imageRepoUploadKey) {
    try {
      dataUrl = await imageUrlToDataUrl(generated.url, "Generated image", signal);
    } catch (error) {
      persistError = publicError(error);
      console.warn("character generated image fetch failed", persistError);
    }
  }
  if (dataUrl && imageRepoUploadKey) {
    try {
      persisted = await uploadImageToRepo(dataUrl, name, "Generated character image", tag);
    } catch (error) {
      persistError = publicError(error);
      console.warn("character image cloud persistence failed", persistError);
    }
  }

  const fallbackImage = {
    id: `i_${randomUUID()}`,
    name,
    src: persisted?.url || generated.url || dataUrl,
    url: persisted?.url || generated.url || dataUrl,
    media_path: persisted?.mediaPath || generated.url || null,
    path: persisted?.path || null,
    key: persisted?.key || null,
    tag: persisted?.tag || imageRepoTag || null,
    provider: persisted ? "cloud" : "ark",
    bytes: persisted?.bytes || null,
    mime: persisted?.mime || null,
    media_type: "image",
    cloud: Boolean(persisted),
    temporary: !persisted,
  };

  return {
    image: persisted ? uploadedImagePayload(persisted, name) : fallbackImage,
    persisted: Boolean(persisted),
    temporary: !persisted,
    persistError,
  };
}

async function generateCharacterZoneImage(rawInput, mediaBaseUrl = publicBaseUrl) {
  const context = characterZoneContext(rawInput, mediaBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), arkImageTimeoutMs);
  timeout.unref?.();

  try {
    const referencePrompt = await buildReferenceAwarePrompt(context, controller.signal);
    const prompt = buildCharacterZonePrompt(context, referencePrompt);
    const requestBody = {
      model: arkImageModel,
      prompt,
      size: context.size,
      n: 1,
      response_format: "url",
    };
    if (context.referenceUrls.length) {
      requestBody.image = context.referenceUrls.slice(0, 4);
      requestBody.sequential_image_generation = "disabled";
    }
    if (context.seed >= 0) requestBody.seed = context.seed;

    const raw = await arkFetch("/images/generations", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const generated = extractGeneratedImage(raw);
    const name = cleanImageUploadName(
      `${context.characterName || "character"}-${context.zoneId}-${Date.now()}.jpg`,
      ".jpg"
    );

    const result = await persistGeneratedImage(generated, name, context.tag, controller.signal);

    return {
      ok: true,
      zone_id: context.zoneId,
      model: arkImageModel,
      size: context.size,
      seed: context.seed,
      prompt,
      reference_prompt: referencePrompt,
      persisted: result.persisted,
      temporary: result.temporary,
      persist_error: result.persistError,
      image: result.image,
    };
  } catch (error) {
    if (controller.signal.aborted && !error.status) {
      throw httpError(504, "image_generation_timeout", "Character image generation timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function characterSheetContext(input, mediaBaseUrl) {
  const characterName = String(input.character_name || input.characterName || input.name || "Character").trim();
  const identityContract = normalizeTextList(input.identity_contract || input.identityContract);
  const negativePrompt = String(input.negative_prompt || input.negativePrompt || "").trim();
  const sourceUrls = normalizeUrlList([
    input.source_image_url || input.sourceImageUrl,
    ...(normalizeUrlList(input.source_image_urls || input.sourceImageUrls)),
    ...(normalizeUrlList(input.reference_image_urls || input.referenceImageUrls)),
  ]).map((u) => absoluteRequestUrl(u, mediaBaseUrl));
  if (!sourceUrls.length) {
    throw httpError(400, "source_required", "A source image is required to generate the identity grid.");
  }
  const zones = (Array.isArray(input.zones) ? input.zones : [])
    .map((z) => ({
      id: String(z.id || z.zone_id || "").trim(),
      label: String(z.label || z.id || "").trim(),
      role: String(z.role || "").trim(),
      prompt: String(z.prompt || z.instruction || z.role || z.label || "").trim(),
    }))
    .filter((z) => z.id && z.prompt)
    .slice(0, 9);
  if (!zones.length) {
    throw httpError(400, "zones_required", "At least one zone is required.");
  }
  return {
    characterName,
    identityContract,
    negativePrompt,
    sourceUrls,
    zones,
    output: (
      input.output === "zones" || input.mode === "zones" || input.return_zones === true || input.returnZones === true
        ? "zones"
        : "sheet"
    ),
    size: normalizeImageSize(input.size || input.output_size || arkSheetSize),
    seed: clampInt(input.seed, -1, 4_294_967_295, -1),
    tag: String(input.tag || input.cloud_tag || "design").trim(),
  };
}

function buildCharacterSheetPrompt(ctx, grid) {
  const { rows, cols } = grid;
  const contract = ctx.identityContract.length
    ? ctx.identityContract.join(" ")
    : "Keep the exact same single subject identity from the reference: same face, hair, body proportions, skin tone, outfit, colors, and signature details.";
  return [
    `Generate ONE single square photorealistic character contact sheet of the SAME single subject shown in the reference image(s).`,
    `Layout: a strict, uniform ${rows} by ${cols} grid (${rows} rows, ${cols} columns) that fills the entire square canvas edge-to-edge. Every cell is an equal rectangle of identical size, arranged on a perfectly aligned grid, separated only by thin even neutral gutters. No empty cells, no offset rows, no overlap, no collage scatter.`,
    `Across every cell the subject's identity is IDENTICAL — only the camera view / framing changes per cell. Identity lock: ${contract}`,
    `Fill the cells left-to-right, top-to-bottom, in this exact order:`,
    ...ctx.zones.map((z, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      return `Cell ${i + 1} (row ${r + 1}, col ${c + 1}): ${z.label} — ${z.prompt}`;
    }),
    `Each cell: a single subject only, centered within its cell, plain soft light-gray seamless studio background, even neutral studio lighting, the described framing fully in frame and not cropped at the cell edges.`,
    `Absolutely NO text, no labels, no captions, no titles, no numbers, no annotations, no arrows, no rulers, no UI, no watermark, no logos, and no drawn borders or frames with text. Only the photographic subject and clean neutral gutters between cells.`,
    ctx.negativePrompt ? `Avoid: ${ctx.negativePrompt}` : "",
  ].filter(Boolean).join("\n");
}

async function generateCharacterSheetZones(ctx, mediaBaseUrl) {
  const zoneResults = [];
  const anchorRefs = [];
  const firstSource = ctx.sourceUrls[0];

  for (let index = 0; index < ctx.zones.length; index += 1) {
    const zone = ctx.zones[index];
    const refs = normalizeUrlList([
      ...ctx.sourceUrls,
      ...anchorRefs,
    ]).slice(0, 4);
    const zoneSeed = ctx.seed >= 0 ? ctx.seed + index : undefined;
    const result = await generateCharacterZoneImage({
      character_name: ctx.characterName,
      zone_id: zone.id,
      zone_label: zone.label,
      zone_role: zone.role,
      instruction: zone.prompt,
      identity_contract: ctx.identityContract,
      negative_prompt: ctx.negativePrompt,
      source_image_url: firstSource,
      reference_image_urls: refs,
      size: ctx.size,
      seed: zoneSeed,
      tag: ctx.tag,
    }, mediaBaseUrl);
    const imageUrl = result.image?.url || result.image?.src || "";
    if (imageUrl && (index === 0 || zone.id === "full_front")) {
      anchorRefs.splice(0, anchorRefs.length, imageUrl);
    }
    zoneResults.push({
      zone_id: zone.id,
      label: zone.label,
      index,
      row: Math.floor(index / 3),
      col: index % 3,
      image: result.image,
      persisted: result.persisted,
      temporary: result.temporary,
      persist_error: result.persist_error,
      prompt: result.prompt,
      reference_prompt: result.reference_prompt,
    });
  }

  return zoneResults;
}

async function generateCharacterSheet(rawInput, mediaBaseUrl = publicBaseUrl) {
  const ctx = characterSheetContext(rawInput, mediaBaseUrl);
  const cols = 3;
  const rows = Math.ceil(ctx.zones.length / cols);
  const grid = { rows, cols };
  if (ctx.output === "zones") {
    const zones = await generateCharacterSheetZones(ctx, mediaBaseUrl);
    return {
      ok: true,
      model: arkImageModel,
      size: ctx.size,
      seed: ctx.seed,
      output: "zones",
      grid,
      zones,
      zone_images: zones,
      prompt: "Generated as per-zone reference-image outputs; see each zone prompt.",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), arkImageGridTimeoutMs);
  timeout.unref?.();
  try {
    const prompt = buildCharacterSheetPrompt(ctx, grid);
    const requestBody = {
      model: arkImageModel,
      prompt,
      image: ctx.sourceUrls.slice(0, 8),
      sequential_image_generation: "disabled",
      response_format: "url",
      size: ctx.size,
      watermark: false,
    };
    if (ctx.seed >= 0) requestBody.seed = ctx.seed;
    const raw = await arkFetch("/images/generations", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const generated = extractGeneratedImage(raw);
    const name = cleanImageUploadName(`${ctx.characterName || "character"}-sheet-${Date.now()}.jpg`, ".jpg");
    const persistResult = await persistGeneratedImage(generated, name, ctx.tag, controller.signal);

    const sheetUrl = persistResult.image?.url || generated.url || null;
    let dataUrl = generated.dataUrl || null;
    if (!dataUrl) {
      try {
        dataUrl = await imageUrlToDataUrl(generated.url || sheetUrl, "Character sheet", controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.warn("character sheet data url failed", publicError(error));
        dataUrl = null;
      }
    }

    return {
      ok: true,
      model: arkImageModel,
      size: ctx.size,
      seed: ctx.seed,
      grid,
      sheet: {
        url: sheetUrl,
        data_url: dataUrl,
        persisted: persistResult.persisted,
      },
      cells: ctx.zones.map((z, i) => ({
        zone_id: z.id,
        label: z.label,
        index: i,
        row: Math.floor(i / cols),
        col: i % cols,
      })),
      prompt,
    };
  } catch (error) {
    if (controller.signal.aborted && !error.status) {
      throw httpError(504, "image_grid_timeout", "Identity grid generation timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function imageTimestamp(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : Date.now();
}

function repoImagePayload(image) {
  const key = String(image?.key || "");
  const url = String(image?.url || "");
  const tag = String(image?.tag || imageRepoTag || "");
  const file = basename(key || new URL(url || "https://local.invalid/image").pathname);
  const safeId = [tag, file || url]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || randomUUID();
  const addedAt = imageTimestamp(image?.lastModified || image?.last_modified || image?.createdAt || image?.created_at);

  return {
    id: `i_repo_${safeId}`,
    name: image?.name || image?.filename || `${tag || "image"}-${(file || safeId).slice(0, 10)}`,
    src: url,
    url,
    media_path: url,
    path: null,
    key: key || null,
    tag: tag || null,
    provider: "cloud",
    cloud: true,
    bytes: image?.size ?? image?.bytes ?? null,
    mime: image?.contentType || image?.content_type || null,
    added_at: addedAt,
    addedAt,
  };
}

async function listImagesFromRepo({ limit = 100, cursor = "", tag = imageRepoTag } = {}) {
  assertImageRepoConfigured();

  const endpoint = new URL(`${imageRepoBaseUrl}/api/images`);
  endpoint.searchParams.set("limit", String(limit));
  endpoint.searchParams.set("type", "image");
  if (cursor) endpoint.searchParams.set("cursor", cursor);
  if (tag) endpoint.searchParams.set("tag", tag);

  const response = await fetch(endpoint, {
    headers: {
      "x-upload-key": imageRepoUploadKey,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw httpError(
      response.status || 502,
      payload?.error?.code || "image_repo_list_failed",
      payload?.error?.message || payload?.error || `Cloud list failed with HTTP ${response.status}.`,
      payload
    );
  }

  return {
    images: Array.isArray(payload.images) ? payload.images.map(repoImagePayload) : [],
    nextCursor: payload.nextCursor || null,
    total: payload.total ?? null,
    tag,
    provider: "cloud",
  };
}

function artifactExtension(sourceUrl, contentType) {
  try {
    const ext = extname(new URL(sourceUrl).pathname).toLowerCase();
    if ([".mp4", ".webm", ".mov"].includes(ext)) return ext;
  } catch {
    // Fall back to content-type below.
  }

  if (String(contentType || "").includes("webm")) return ".webm";
  if (String(contentType || "").includes("quicktime")) return ".mov";
  return ".mp4";
}

function scheduleArtifactCache(id, reason = "task") {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || task.status !== "succeeded" || task.artifactUrl || artifactInflight.has(id)) return;
  if (!(task.sourceVideoUrl || task.videoUrl)) return;

  scheduleBackgroundTimer(() => {
    trackBackgroundJob(cacheTaskArtifact(id, reason).catch((error) => {
      console.error(`artifact cache failed ${id}`, publicError(error));
    }));
  }, 0);
}

function scheduleCoverGeneration(id, reason = "task") {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || task.status !== "succeeded" || task.coverUrl || coverInflight.has(id)) return;
  if (!task.artifactPath) return;

  scheduleBackgroundTimer(() => {
    trackBackgroundJob(generateTaskCover(id, reason).catch((error) => {
      console.error(`cover generation failed ${id}`, publicError(error));
    }));
  }, 0);
}

async function cacheTaskArtifact(id, reason = "task") {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || task.status !== "succeeded" || task.artifactUrl || artifactInflight.has(id)) return;

  const sourceUrl = task.sourceVideoUrl || task.videoUrl;
  if (!sourceUrl || sourceUrl.startsWith("/media/")) return;

  artifactInflight.add(id);
  const { controller, release } = createShutdownController();
  let tmpPath = null;

  try {
    task.artifactStatus = "caching";
    task.artifactError = null;
    task.updatedAt = Date.now();
    saveTasks();

    const res = await fetch(sourceUrl, { signal: controller.signal });
    if (!res.ok || !res.body) {
      throw httpError(res.status || 502, "artifact_fetch_failed", `Could not fetch generated video for storage.`);
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > maxArtifactBytes) {
      throw httpError(413, "artifact_too_large", "Generated video is larger than MAX_ARTIFACT_BYTES.");
    }

    const ext = artifactExtension(sourceUrl, res.headers.get("content-type"));
    const filename = `${sanitizeFilePart(task.id)}${ext}`;
    const finalPath = join(artifactsDir, filename);
    tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    let bytes = 0;

    const counter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxArtifactBytes) {
          callback(httpError(413, "artifact_too_large", "Generated video is larger than MAX_ARTIFACT_BYTES."));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmpPath), { signal: controller.signal });
    renameSync(tmpPath, finalPath);
    tmpPath = null;

    task.sourceVideoUrl = sourceUrl;
    task.artifactUrl = `/media/artifacts/${filename}`;
    task.artifactPath = `artifacts/${filename}`;
    task.artifactBytes = bytes;
    task.artifactCachedAt = Date.now();
    task.artifactStatus = "ready";
    task.updatedAt = Date.now();
    saveTasks();
    console.log(`artifact cache ${reason}: ${id} -> ${task.artifactUrl} (${bytes} bytes)`);
    scheduleCoverGeneration(id, reason);
  } catch (error) {
    if (tmpPath) {
      try { rmSync(tmpPath, { force: true }); } catch {}
    }
    if (isShutdownAbort(error)) {
      task.artifactStatus = null;
      task.artifactError = null;
      task.updatedAt = Date.now();
      saveTasks();
      return;
    }
    task.artifactStatus = "failed";
    task.artifactError = publicError(error);
    task.updatedAt = Date.now();
    saveTasks();
    throw error;
  } finally {
    release();
    artifactInflight.delete(id);
  }
}

async function generateTaskCover(id, reason = "task") {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || task.status !== "succeeded" || task.coverUrl || coverInflight.has(id)) return;

  const artifactPath = task.artifactPath ? resolve(publicDataDir, task.artifactPath) : null;
  if (!artifactPath || !artifactPath.startsWith(publicDataDir) || !existsSync(artifactPath)) return;

  coverInflight.add(id);
  const { controller, release } = createShutdownController();
  let tmpPath = null;

  try {
    const filename = `${sanitizeFilePart(task.id)}.jpg`;
    const finalPath = join(coversDir, filename);
    const coverUrl = `/media/covers/${filename}`;

    task.coverStatus = "generating";
    task.coverError = null;
    task.updatedAt = Date.now();
    saveTasks();

    if (!existsSync(finalPath)) {
      tmpPath = join(coversDir, `${sanitizeFilePart(task.id)}.${process.pid}.${Date.now()}.jpg`);
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "0",
        "-i",
        artifactPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=1280:-2:force_original_aspect_ratio=decrease",
        "-q:v",
        "3",
        "-f",
        "image2",
        tmpPath,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024, signal: controller.signal });
      renameSync(tmpPath, finalPath);
      tmpPath = null;
    }

    const bytes = statSync(finalPath).size;
    task.coverUrl = coverUrl;
    task.coverPath = `covers/${filename}`;
    task.coverBytes = bytes;
    task.coverGeneratedAt = Date.now();
    task.coverStatus = "ready";
    task.coverError = null;
    task.thumb = coverUrl;
    task.updatedAt = Date.now();
    saveTasks();
    console.log(`cover generation ${reason}: ${id} -> ${task.coverUrl} (${bytes} bytes)`);
  } catch (error) {
    if (tmpPath) {
      try { rmSync(tmpPath, { force: true }); } catch {}
    }
    if (isShutdownAbort(error)) {
      task.coverStatus = null;
      task.coverError = null;
      task.updatedAt = Date.now();
      saveTasks();
      return;
    }
    task.coverStatus = "failed";
    task.coverError = publicError(error);
    task.updatedAt = Date.now();
    saveTasks();
    throw error;
  } finally {
    release();
    coverInflight.delete(id);
  }
}

async function normalizeGenerateInput(input, mediaBaseUrl = publicBaseUrl) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) {
    throw httpError(400, "prompt_required", "Prompt is required.");
  }
  assertVideoPromptDoesNotUseReferenceAsFirstFrame(prompt);

  let rawImageUrl = input.image_url || input.imageUrl || input.image?.src || null;
  let rawLastFrameImageUrl = input.last_frame_image_url
    || input.lastFrameImageUrl
    || input.last_image_url
    || input.lastImageUrl
    || null;
  let rawReferenceImageUrls = normalizeUrlList([
    ...normalizeUrlList(input.reference_image_url || input.referenceImageUrl || input.character_reference_url || input.characterReferenceUrl),
    ...normalizeUrlList(input.reference_image_urls || input.referenceImageUrls || input.character_reference_urls || input.characterReferenceUrls),
  ]);
  const rawReferenceAudioUrls = normalizeMediaUrlList([
    ...normalizeMediaUrlList(input.audio || input.audio_url || input.audioUrl),
    ...normalizeMediaUrlList(input.audio_urls || input.audioUrls),
    ...normalizeMediaUrlList(input.reference_audio || input.referenceAudio),
    ...normalizeMediaUrlList(input.reference_audio_url || input.referenceAudioUrl),
    ...normalizeMediaUrlList(input.reference_audio_urls || input.referenceAudioUrls),
    ...normalizeMediaUrlList(input.reference_audios || input.referenceAudios),
    ...normalizeMediaUrlList(input.reference_media_url || input.referenceMediaUrl),
    ...normalizeMediaUrlList(input.reference_media_urls || input.referenceMediaUrls),
  ]);
  if (rawReferenceAudioUrls.length > 3) {
    throw httpError(400, "too_many_reference_audios", "Seedance 2.0 supports at most 3 reference audio clips per task.");
  }

  const requestedImageRole = normalizeImageRole(input.image_role || input.imageRole || input.image?.role);
  if (requestedImageRole && requestedImageRole !== "scene_first_frame" && requestedImageRole !== "character_reference") {
    throw httpError(400, "image_role_invalid", "image_role must be scene_first_frame or character_reference.");
  }
  const inferredReferenceRole = !requestedImageRole && rawImageUrl && rawReferenceImageUrls.length === 0 && promptMentionsReferenceAsset(prompt);
  if (rawImageUrl && (requestedImageRole === "character_reference" || inferredReferenceRole)) {
    rawReferenceImageUrls = normalizeUrlList([...rawReferenceImageUrls, rawImageUrl]);
    rawImageUrl = null;
  }
  rawImageUrl = absolutePublicUrl(rawImageUrl, mediaBaseUrl);
  rawLastFrameImageUrl = absolutePublicUrl(rawLastFrameImageUrl, mediaBaseUrl);
  rawReferenceImageUrls = rawReferenceImageUrls.map((url) => absolutePublicUrl(url, mediaBaseUrl)).filter(Boolean);
  if (rawLastFrameImageUrl && !rawImageUrl) {
    throw httpError(400, "last_frame_requires_first_frame", "last_frame_image_url requires image_url as the first frame.");
  }
  if ((rawImageUrl || rawLastFrameImageUrl) && rawReferenceImageUrls.length > 0) {
    throw httpError(400, "mixed_frame_and_reference_not_supported", [
      "Ark video generation does not allow first/last frame content to be mixed with reference media content.",
      "For controlled character video, first use imagegen with thinking to create a scene frame from the character reference, then call create_video_task with only that scene frame as image_url.",
      "For Ark reference-guided generation, pass only reference_image_url and no image_url.",
    ].join(" "));
  }
  if ((rawImageUrl || rawLastFrameImageUrl) && rawReferenceAudioUrls.length > 0) {
    throw httpError(400, "reference_audio_requires_reference_mode", [
      "Seedance audio references are multimodal reference inputs and cannot be mixed with first/last-frame inputs.",
      "Use reference_image_url(s) with reference_audio_url(s), then ask the prompt to use the reference image as the opening frame if needed.",
    ].join(" "));
  }
  const persistedImage = await uploadImageToRepo(rawImageUrl, input.image?.name || input.image_name || input.imageName || "first-frame.jpg", "First frame image");
  const persistedLastFrameImage = await uploadImageToRepo(rawLastFrameImageUrl, input.last_frame_name || input.lastFrameName || "last-frame.jpg", "Last frame image");
  const persistedReferenceImages = await Promise.all(rawReferenceImageUrls.map((url, index) => (
    uploadImageToRepo(url, input.reference_image_names?.[index] || input.referenceImageNames?.[index] || `reference-${index + 1}.jpg`, "Reference image")
  )));
  const persistedReferenceAudios = rawReferenceAudioUrls.map((url, index) => (
    persistInputAudio(url, mediaBaseUrl, `Reference audio ${index + 1}`)
  ));
  const imageUrl = persistedImage?.url || rawImageUrl;
  const lastFrameImageUrl = persistedLastFrameImage?.url || rawLastFrameImageUrl;
  const referenceImageUrls = rawReferenceImageUrls.map((url, index) => persistedReferenceImages[index]?.url || url);
  const storedReferenceImageUrls = rawReferenceImageUrls.map((url, index) => persistedReferenceImages[index]?.mediaPath || referenceImageUrls[index]);
  const referenceAudioUrls = rawReferenceAudioUrls.map((url, index) => persistedReferenceAudios[index]?.url || url);
  const storedReferenceAudioUrls = rawReferenceAudioUrls.map((url, index) => persistedReferenceAudios[index]?.mediaPath || referenceAudioUrls[index]);
  const rawThumb = input.thumb || null;
  const safeThumb = String(rawThumb || "").startsWith("data:") ? null : rawThumb;
  const thumb = safeThumb
    && safeThumb !== rawImageUrl
    && safeThumb !== imageUrl
    && safeThumb !== rawLastFrameImageUrl
    && safeThumb !== lastFrameImageUrl
    && !rawReferenceImageUrls.includes(safeThumb)
    && !referenceImageUrls.includes(safeThumb)
    ? safeThumb
    : null;

  const mode = imageUrl ? "i2v" : referenceImageUrls.length ? "ref2v" : "t2v";
  const duration = clampInt(input.duration_seconds ?? input.duration, 5, 15, 5);
  const seed = clampInt(input.seed, -1, 4_294_967_295, Math.floor(Math.random() * 99_999));
  const resolution = normalizeResolution(input.resolution || "1080p");
  const aspect = String(input.aspect_ratio || input.aspect || "16:9");
  const camera = input.camera_fixed === true || input.camera === "fixed" ? "fixed" : "dynamic";
  const generateAudio = input.generate_audio == null && input.generateAudio == null
    ? true
    : boolFromInput(input.generate_audio ?? input.generateAudio);
  const uiModel = "seedance-pro";
  const arkModel = resolveModel();

  return {
    prompt,
    imageUrl,
    inputImagePath: persistedImage?.path || null,
    inputImageUrl: persistedImage?.mediaPath || imageUrl || null,
    inputImageBytes: persistedImage?.bytes || null,
    inputImageMime: persistedImage?.mime || null,
    lastFrameImagePath: persistedLastFrameImage?.path || null,
    lastFrameImageUrl: persistedLastFrameImage?.mediaPath || lastFrameImageUrl || null,
    lastFrameImageBytes: persistedLastFrameImage?.bytes || null,
    lastFrameImageMime: persistedLastFrameImage?.mime || null,
    referenceImagePath: persistedReferenceImages[0]?.path || null,
    referenceImagePaths: persistedReferenceImages.map((item) => item?.path || null).filter(Boolean),
    referenceImageUrl: storedReferenceImageUrls[0] || null,
    referenceImageUrls: storedReferenceImageUrls,
    referenceImageBytes: persistedReferenceImages[0]?.bytes || null,
    referenceImageMimes: persistedReferenceImages.map((item) => item?.mime || null),
    referenceAudioPath: persistedReferenceAudios[0]?.path || null,
    referenceAudioPaths: persistedReferenceAudios.map((item) => item?.path || null).filter(Boolean),
    referenceAudioUrl: storedReferenceAudioUrls[0] || null,
    referenceAudioUrls: storedReferenceAudioUrls,
    referenceAudioBytes: persistedReferenceAudios[0]?.bytes || null,
    referenceAudioMimes: persistedReferenceAudios.map((item) => item?.mime || null),
    generateAudio,
    imageRole: imageUrl ? "scene_first_frame" : referenceImageUrls.length ? "character_reference" : "none",
    imageId: input.image_id || input.imageId || null,
    thumb,
    mode,
    duration,
    seed,
    resolution,
    aspect,
    camera,
    uiModel,
    arkModel,
    title: "Untitled take",
  };
}

function toArkBody(input, localTaskId) {
  const flags = [
    `--rs ${input.resolution}`,
    `--rt ${input.aspect}`,
    `--dur ${input.duration}`,
    `--cf ${input.camera === "fixed"}`,
    `--seed ${input.seed}`,
  ].join(" ");

  const useInline = arkParamStyle === "inline" || arkParamStyle === "both";
  const useFields = arkParamStyle === "fields" || arkParamStyle === "both";
  const text = useInline ? `${input.prompt}  ${flags}` : input.prompt;
  const content = [{ type: "text", text }];

  if (input.imageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: input.imageUrl },
      role: "first_frame",
    });
  }
  if (input.lastFrameImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: input.lastFrameImageUrl },
      role: "last_frame",
    });
  }
  for (const referenceImageUrl of input.referenceImageUrls || []) {
    content.push({
      type: "image_url",
      image_url: { url: referenceImageUrl },
      role: "reference_image",
    });
  }
  for (const referenceAudioUrl of input.referenceAudioUrls || []) {
    content.push({
      type: "audio_url",
      audio_url: { url: referenceAudioUrl },
      role: "reference_audio",
    });
  }

  const body = {
    model: input.arkModel,
    content,
  };
  body.generate_audio = input.generateAudio !== false;

  const callbackUrl = callbackUrlForTask(localTaskId);
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }

  if (useFields) {
    body.resolution = input.resolution;
    body.ratio = input.aspect;
    body.duration = input.duration;
    body.seed = input.seed;
    body.watermark = false;
    if (!input.imageUrl) {
      body.camera_fixed = input.camera === "fixed";
    }
  }

  return body;
}

async function createArkTask(input, localTaskId = randomUUID(), signal = undefined) {
  const body = toArkBody(input, localTaskId);
  const result = await arkFetch("/contents/generations/tasks", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });

  if (!result.id) {
    throw httpError(502, "upstream_bad_response", "Ark did not return a task id.");
  }

  return { localTaskId, arkTaskId: result.id };
}

async function getArkTask(taskId, signal = undefined) {
  return arkFetch(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, { signal });
}

async function arkFetch(path, options = {}) {
  if (!arkApiKey) {
    throw httpError(503, "ark_key_missing", "ARK_API_KEY is not configured on the server.");
  }

  const res = await fetch(`${arkBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${arkApiKey}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }

  if (!res.ok) {
    const message = body?.error?.message || body?.message || `Ark request failed with HTTP ${res.status}.`;
    throw httpError(res.status, body?.error?.code || "ark_request_failed", message, body);
  }

  return body || {};
}

function extractVideoUrl(raw) {
  const content = raw?.content;
  if (!content) return null;
  if (typeof content.video_url === "string") return content.video_url;
  if (typeof content.file_url === "string") return content.file_url;
  if (Array.isArray(content)) {
    const item = content.find((entry) => entry?.url || entry?.video_url || entry?.file_url);
    return item?.url || item?.video_url || item?.file_url || null;
  }
  if (typeof content.url === "string") return content.url;
  return null;
}

function normalizeArkResult(raw) {
  const status = normalizeStatus(raw.status);
  return {
    status,
    videoUrl: extractVideoUrl(raw),
    error: raw.error
      ? {
          code: raw.error.code || "ark_error",
          message: raw.error.message || "Ark task failed.",
        }
      : null,
    updatedAt: raw.updated_at ? raw.updated_at * 1000 : Date.now(),
    rawMeta: {
      usage: raw.usage || null,
      seed: raw.seed,
      resolution: raw.resolution,
      ratio: raw.ratio,
      duration: raw.duration,
    },
  };
}

function applyArkResult(task, raw) {
  const next = normalizeArkResult(raw);
  task.status = next.status;
  if (next.videoUrl) {
    task.sourceVideoUrl = next.videoUrl;
  }
  task.videoUrl = task.artifactUrl || next.videoUrl || task.videoUrl || null;
  task.error = next.error;
  task.updatedAt = Date.now();
  task.progress = task.monitorMode === "webhook" && !terminalStatuses.has(task.status)
    ? null
    : estimateProgress(task);
  task.rawMeta = next.rawMeta;

  if (terminalStatuses.has(task.status)) {
    task.finishedAt = Date.now();
    task.progress = task.status === "succeeded" ? 100 : task.progress;
  }

  return task;
}

async function pollTask(id, reason = "timer") {
  if (monitorMode !== "poll") return;
  if (isShuttingDown) return;
  const task = tasks.get(id);
  if (!task || terminalStatuses.has(task.status) || pollInflight.has(id)) return;

  pollInflight.add(id);
  const { controller, release } = createShutdownController();
  try {
    const raw = await getArkTask(task.arkTaskId, controller.signal);
    applyArkResult(task, raw);
    task.lastPolledAt = Date.now();
    task.lastPollError = null;
    task.pollCount = (task.pollCount || 0) + 1;

    saveTasks();
    if (task.status === "succeeded") {
      scheduleArtifactCache(id, reason);
    }
    if (!terminalStatuses.has(task.status)) {
      schedulePoll(id, pollDelay(task));
    }
  } catch (error) {
    if (isShutdownAbort(error)) return;

    task.updatedAt = Date.now();
    task.lastPolledAt = Date.now();
    task.lastPollError = publicError(error);
    task.pollErrorCount = (task.pollErrorCount || 0) + 1;

    if (error.status === 401 || error.status === 403) {
      task.status = "failed";
      task.error = { code: "auth_error", message: "Ark rejected the configured API key." };
      task.finishedAt = Date.now();
    }

    saveTasks();
    if (!terminalStatuses.has(task.status)) {
      schedulePoll(id, Math.min(60_000, 5_000 * task.pollErrorCount));
    }
  } finally {
    release();
    pollInflight.delete(id);
    console.log(`task poll ${reason}: ${id} -> ${tasks.get(id)?.status || "missing"}`);
  }
}

function pollDelay(task) {
  const count = task.pollCount || 0;
  if (count < 20) return 5_000;
  if (count < 80) return 15_000;
  return 60_000;
}

function schedulePoll(id, delayMs) {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || terminalStatuses.has(task.status) || pollTimers.has(id)) return;
  const timer = setTimeout(() => {
    pollTimers.delete(id);
    if (isShuttingDown) return;
    trackBackgroundJob(pollTask(id).catch((error) => {
      console.error(`task poll failed ${id}`, publicError(error));
    }));
  }, delayMs);
  timer.unref?.();
  pollTimers.set(id, timer);
}

async function handleGenerate(req, res) {
  const task = await createVideoTask(await readJson(req), publicBaseUrl || requestPublicBaseUrl(req));
  sendJson(res, 202, publicTask(task));
}

async function handleUploadImage(req, res) {
  const input = await readJson(req);
  const image = input.image || input.image_url || input.data_url || input.src;
  if (!image) {
    throw httpError(400, "image_required", "Image data URL is required.");
  }

  const tag = String(input.tag || input.cloud_tag || "").trim();
  const persisted = await uploadImageToRepo(image, input.name || input.filename || "image.jpg", "Image", tag || undefined);
  if (!persisted) {
    throw httpError(400, "image_invalid", "Unsupported image data URL.");
  }

  sendJson(res, 201, { image: uploadedImagePayload(persisted, input.name || input.filename) });
}

async function handleCharacterZoneImage(req, res) {
  const payload = await generateCharacterZoneImage(await readJson(req), publicBaseUrl || requestPublicBaseUrl(req));
  sendJson(res, 201, payload);
}

async function handleCharacterSheet(req, res) {
  const payload = await generateCharacterSheet(await readJson(req), publicBaseUrl || requestPublicBaseUrl(req));
  sendJson(res, 201, payload);
}

async function handleCharacterDesignClaim(req, res) {
  const input = await readJson(req);
  const characterId = String(input.character_id || input.characterId || "").trim();
  const zoneId = String(input.zone_id || input.zoneId || "").trim();
  const label = String(input.label || input.zone_label || input.zoneLabel || "").trim();
  const kind = input.kind === "sheet" ? "sheet" : "zone";
  const zones = Array.isArray(input.zones) ? input.zones : [];
  const grid = input.grid && typeof input.grid === "object" ? input.grid : { rows: 3, cols: 3 };
  const sourceImageUrl = String(input.source_image_url || input.sourceImageUrl || "").trim();
  const characterName = String(input.character_name || input.characterName || label || "").trim();
  const identityContract = normalizeTextList(input.identity_contract || input.identityContract);
  const negativePrompt = String(input.negative_prompt || input.negativePrompt || "").trim();
  if (kind === "sheet") {
    if (!characterId || !zones.length) {
      throw httpError(400, "claim_target_required", "character_id and a non-empty zones array are required to mint a sheet claim.");
    }
  } else if (!characterId || !zoneId) {
    throw httpError(400, "claim_target_required", "character_id and zone_id are required to mint a claim.");
  }
  const claim = mintDesignClaim(characterId, zoneId, label, {
    kind,
    zones,
    grid,
    sourceImageUrl,
    characterName,
    identityContract,
    negativePrompt,
  });
  const mcpUrl = (publicBaseUrl || requestPublicBaseUrl(req)) + "/mcp";
  sendJson(res, 201, {
    token: claim.token,
    mcp_url: mcpUrl,
    tools: [...SCOPED_MCP_TOOLS],
    tool: "deliver_character_zone",
    kind,
    expires_in: Math.floor(designClaimTtlMs / 1000),
  });
}

function handleCharacterDesignInbox(req, res, url) {
  pruneDesignState();
  const since = clampInt(url.searchParams.get("since"), 0, Number.MAX_SAFE_INTEGER, 0);
  const deliveries = designDeliveries
    .filter((d) => d.deliveredAt > since)
    .map((d) => ({
      id: d.id,
      character_id: d.characterId,
      kind: d.kind || "zone",
      zone_id: d.zoneId,
      image: d.image,
      sheet: d.sheet,
      note: d.note,
      delivered_at: d.deliveredAt,
    }));
  sendJson(res, 200, { deliveries, now: Date.now() });
}

async function handleCharacterDesignSheetProxy(req, res, url) {
  const target = String(url.searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw httpError(400, "url_required", "A valid http(s) url query parameter is required.");
  }
  let targetHost = "";
  try { targetHost = new URL(target).hostname.toLowerCase(); } catch { targetHost = ""; }
  let repoHost = "";
  try { repoHost = new URL(imageRepoBaseUrl).hostname.toLowerCase(); } catch { repoHost = ""; }
  const hostAllowed = Boolean(targetHost) && (
    targetHost === repoHost ||
    targetHost.endsWith(".volces.com")
  );
  if (!hostAllowed) {
    throw httpError(400, "url_not_allowed", "Sheet proxy only fetches Studio image hosts.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), arkTitleImageFetchTimeoutMs);
  timeout.unref?.();
  try {
    const upstream = await fetch(target, { signal: controller.signal });
    if (!upstream.ok) {
      throw httpError(upstream.status || 502, "sheet_proxy_failed", `Could not fetch the sheet image (HTTP ${upstream.status}).`);
    }
    const contentType = String(upstream.headers.get("content-type") || mimeFromImageUrl(target)).split(";")[0].trim() || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      throw httpError(502, "sheet_proxy_not_image", "Proxied response was not an image.");
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > maxImageBytes) {
      throw httpError(413, "sheet_proxy_too_large", "Sheet image is larger than MAX_IMAGE_BYTES.");
    }
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": buffer.length,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(buffer);
  } catch (error) {
    if (controller.signal.aborted && !error.status) {
      throw httpError(504, "sheet_proxy_timeout", "Sheet image proxy timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleGetCharacterDesignState(req, res) {
  sendJson(res, 200, {
    characterDesigns: cleanCharacterDesigns(characterDesigns),
    updated_at: existsSync(characterDesignsFile) ? statSync(characterDesignsFile).mtimeMs : null,
  });
}

async function handlePutCharacterDesignState(req, res) {
  const input = await readJson(req);
  characterDesigns = cleanCharacterDesigns(input.characterDesigns || input.character_designs || {});
  saveCharacterDesigns();
  sendJson(res, 200, {
    ok: true,
    characterDesigns,
  });
}

async function handleListImages(req, res, url) {
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const cursor = url.searchParams.get("cursor") || "";
  const tag = url.searchParams.has("tag") ? String(url.searchParams.get("tag") || "").trim() : imageRepoTag;
  sendJson(res, 200, await listImagesFromRepo({ limit, cursor, tag }));
}

async function handleDeleteImage(req, res, key) {
  const payload = await deleteImageFromRepo(key);
  sendJson(res, 200, { deleted: true, ...payload });
}

async function createVideoTask(rawInput, mediaBaseUrl = publicBaseUrl) {
  if (isShuttingDown) {
    throw httpError(503, "server_shutting_down", "Server is shutting down. Retry on the next deployment.");
  }

  const input = await normalizeGenerateInput(rawInput, mediaBaseUrl);
  const localTaskId = randomUUID();
  const now = Date.now();
  const id = localTaskId;
  const task = {
    id,
    arkTaskId: null,
    status: "queued",
    progress: monitorMode === "poll" ? 1 : null,
    title: input.title,
    prompt: input.prompt,
    uiModel: input.uiModel,
    arkModel: input.arkModel,
    mode: input.mode,
    resolution: input.resolution,
    aspect: input.aspect,
    duration: input.duration,
    camera: input.camera,
    seed: input.seed,
    imageId: input.imageId,
    inputImagePath: input.inputImagePath,
    inputImageUrl: input.inputImageUrl,
    inputImageBytes: input.inputImageBytes,
    inputImageMime: input.inputImageMime,
    lastFrameImagePath: input.lastFrameImagePath,
    lastFrameImageUrl: input.lastFrameImageUrl,
    lastFrameImageBytes: input.lastFrameImageBytes,
    lastFrameImageMime: input.lastFrameImageMime,
    referenceImagePath: input.referenceImagePath,
    referenceImagePaths: input.referenceImagePaths,
    referenceImageUrl: input.referenceImageUrl,
    referenceImageUrls: input.referenceImageUrls,
    referenceImageBytes: input.referenceImageBytes,
    referenceImageMimes: input.referenceImageMimes,
    referenceAudioPath: input.referenceAudioPath,
    referenceAudioPaths: input.referenceAudioPaths,
    referenceAudioUrl: input.referenceAudioUrl,
    referenceAudioUrls: input.referenceAudioUrls,
    referenceAudioBytes: input.referenceAudioBytes,
    referenceAudioMimes: input.referenceAudioMimes,
    generateAudio: input.generateAudio,
    imageRole: input.imageRole,
    thumb: input.thumb,
    videoUrl: null,
    sourceVideoUrl: null,
    artifactUrl: null,
    artifactPath: null,
    artifactStatus: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    pollCount: 0,
    monitorMode,
    callbackUrl: monitorMode === "webhook" ? callbackUrlForTask(localTaskId) : null,
    submissionStatus: "pending",
  };

  tasks.set(id, task);
  saveTasks();
  scheduleArkSubmit(id, 0);
  return task;
}

function inputFromTask(task) {
  return {
    prompt: task.prompt,
    imageUrl: publicMediaUrl(task.inputImageUrl) || null,
    lastFrameImageUrl: publicMediaUrl(task.lastFrameImageUrl) || null,
    referenceImageUrls: normalizeUrlList(task.referenceImageUrls || task.referenceImageUrl).map((url) => publicMediaUrl(url)),
    referenceAudioUrls: normalizeUrlList(task.referenceAudioUrls || task.referenceAudioUrl).map((url) => publicMediaUrl(url)),
    generateAudio: task.generateAudio !== false,
    resolution: task.resolution,
    aspect: task.aspect,
    duration: task.duration,
    camera: task.camera,
    seed: task.seed,
    arkModel: task.arkModel || resolveModel(),
  };
}

function scheduleArkSubmit(id, delayMs = 0) {
  const task = tasks.get(id);
  if (isShuttingDown) return;
  if (!task || task.arkTaskId || terminalStatuses.has(task.status) || submissionInflight.has(id)) return;

  scheduleBackgroundTimer(() => {
    trackBackgroundJob(submitArkTask(id).catch((error) => {
      console.error(`task submit failed ${id}`, publicError(error));
    }));
  }, delayMs);
}

async function updateTaskTitle(id, input, signal = undefined) {
  const title = await generateTaskTitle(input, signal);
  const task = tasks.get(id);
  if (!task || task.title === title) return;

  task.title = title;
  task.updatedAt = Date.now();
  saveTasks();
}

async function submitArkTask(id) {
  if (isShuttingDown) return;
  const task = tasks.get(id);
  if (!task || task.arkTaskId || terminalStatuses.has(task.status) || submissionInflight.has(id)) return;

  submissionInflight.add(id);
  const { controller, release } = createShutdownController();
  try {
    task.submissionStatus = "submitting";
    task.lastSubmitError = null;
    task.updatedAt = Date.now();
    saveTasks();

    const input = inputFromTask(task);
    updateTaskTitle(id, input, controller.signal).catch((error) => {
      console.warn(`title update failed ${id}`, publicError(error));
    });

    const { arkTaskId } = await createArkTask(input, id, controller.signal);
    const latest = tasks.get(id);
    if (!latest) return;

    latest.arkTaskId = arkTaskId;
    latest.status = normalizeStatus(latest.status || "queued");
    latest.submissionStatus = "submitted";
    latest.updatedAt = Date.now();
    latest.pollCount = latest.pollCount || 0;
    tasks.set(id, latest);
    saveTasks();

    if (monitorMode === "poll") {
      schedulePoll(id, 1500);
    }
    console.log(`task submit: ${id} -> ${arkTaskId}`);
  } catch (error) {
    const failed = tasks.get(id);
    if (isShutdownAbort(error)) {
      if (failed) {
        failed.submissionStatus = "pending";
        failed.lastSubmitError = null;
        failed.updatedAt = Date.now();
        tasks.set(id, failed);
        saveTasks();
      }
      return;
    }

    if (failed) {
      failed.status = "failed";
      failed.error = publicError(error);
      failed.finishedAt = Date.now();
      failed.updatedAt = Date.now();
      failed.submissionStatus = "failed";
      failed.lastSubmitError = publicError(error);
      tasks.set(id, failed);
      saveTasks();
    }
    throw error;
  } finally {
    release();
    submissionInflight.delete(id);
  }
}

async function handleGetTask(req, res, id) {
  const task = tasks.get(id);
  if (!task) {
    sendJson(res, 404, { error: { code: "task_not_found", message: "Task not found." } });
    return;
  }

  if (!task.arkTaskId && !terminalStatuses.has(task.status)) {
    scheduleArkSubmit(id, 0);
  } else if (monitorMode === "poll" && !terminalStatuses.has(task.status) && Date.now() - (task.lastPolledAt || 0) > 4_000) {
    schedulePoll(id, 0);
  }

  sendJson(res, 200, publicTask(task));
}

async function handleDeleteTask(req, res, id) {
  const task = tasks.get(id);
  if (!task) {
    sendJson(res, 404, { error: { code: "task_not_found", message: "Task not found." } });
    return;
  }

  if (task.artifactPath) {
    const artifactPath = resolve(publicDataDir, task.artifactPath);
    if (artifactPath.startsWith(publicDataDir)) {
      try { rmSync(artifactPath, { force: true }); } catch {}
    }
  }
  if (task.coverPath) {
    const coverPath = resolve(publicDataDir, task.coverPath);
    if (coverPath.startsWith(publicDataDir)) {
      try { rmSync(coverPath, { force: true }); } catch {}
    }
  }
  if (task.inputImagePath) {
    const inputImagePath = resolve(publicDataDir, task.inputImagePath);
    if (inputImagePath.startsWith(publicDataDir)) {
      try { rmSync(inputImagePath, { force: true }); } catch {}
    }
  }
  if (task.lastFrameImagePath) {
    const lastFrameImagePath = resolve(publicDataDir, task.lastFrameImagePath);
    if (lastFrameImagePath.startsWith(publicDataDir)) {
      try { rmSync(lastFrameImagePath, { force: true }); } catch {}
    }
  }
  for (const rawPath of normalizeUrlList(task.referenceImagePaths || task.referenceImagePath)) {
    const referenceImagePath = resolve(publicDataDir, rawPath);
    if (referenceImagePath.startsWith(publicDataDir)) {
      try { rmSync(referenceImagePath, { force: true }); } catch {}
    }
  }

  tasks.delete(id);
  saveTasks();
  sendJson(res, 200, { ok: true, deleted: id });
}

async function handleArkWebhook(req, res, url) {
  if (webhookToken) {
    const provided = url.searchParams.get("token") || req.headers["x-studio-webhook-token"] || req.headers["x-videogen-webhook-token"] || "";
    if (provided !== webhookToken) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Invalid webhook token." } });
      return;
    }
  }

  const body = await readJson(req);
  const id = url.searchParams.get("task_id") || body.id || body.task_id;
  const arkTaskId = body.id || body.task_id;
  let task = id ? tasks.get(id) : null;

  if (!task && arkTaskId) {
    task = [...tasks.values()].find((item) => item.arkTaskId === arkTaskId) || null;
  }

  if (!task) {
    sendJson(res, 404, { error: { code: "task_not_found", message: "Task not found for webhook." } });
    return;
  }

  if (arkTaskId && !task.arkTaskId) {
    task.arkTaskId = arkTaskId;
  }
  applyArkResult(task, body);
  task.lastWebhookAt = Date.now();
  task.lastPollError = null;
  tasks.set(task.id, task);
  saveTasks();
  if (task.status === "succeeded") {
    scheduleArtifactCache(task.id, "webhook");
  }
  sendJson(res, 200, { ok: true, task: publicTask(task) });
}

async function handleListTasks(req, res) {
  const items = [...tasks.values()]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 100)
    .map(publicTask);
  sendJson(res, 200, { tasks: items });
}

const designClaims = new Map();
const designDeliveries = [];

function pruneDesignState(now = Date.now()) {
  for (const [token, claim] of designClaims) {
    if (claim.expiresAt <= now) designClaims.delete(token);
  }
  if (designDeliveries.length) {
    const cutoff = now - designInboxTtlMs;
    let drop = 0;
    while (drop < designDeliveries.length && designDeliveries[drop].deliveredAt <= cutoff) drop++;
    if (drop > 0) designDeliveries.splice(0, drop);
  }
}

function mintDesignClaim(characterId, zoneId, label, opts = {}) {
  const now = Date.now();
  const kind = opts.kind === "sheet" ? "sheet" : "zone";
  const zones = Array.isArray(opts.zones) ? opts.zones : [];
  const grid = opts.grid && typeof opts.grid === "object" ? opts.grid : { rows: 3, cols: 3 };
  const claim = {
    token: "clm_" + randomUUID().replace(/-/g, "").slice(0, 24),
    characterId: String(characterId || "").trim(),
    zoneId: String(zoneId || "").trim(),
    label: String(label || zoneId || "").trim(),
    kind,
    zones,
    grid,
    sourceImageUrl: String(opts.sourceImageUrl || opts.source_image_url || "").trim(),
    characterName: String(opts.characterName || opts.character_name || label || "").trim(),
    identityContract: normalizeTextList(opts.identityContract || opts.identity_contract),
    negativePrompt: String(opts.negativePrompt || opts.negative_prompt || "").trim(),
    createdAt: now,
    expiresAt: now + designClaimTtlMs,
    used: false,
  };
  if (kind === "sheet") claim.zonesDone = {};
  designClaims.set(claim.token, claim);
  return claim;
}

function resolveDesignClaim(token) {
  const key = String(token || "").trim();
  if (!key) return null;
  pruneDesignState();
  const claim = designClaims.get(key);
  if (!claim) return null;
  if (claim.expiresAt <= Date.now()) {
    designClaims.delete(key);
    return null;
  }
  if (claim.kind === "sheet") {
    const zones = Array.isArray(claim.zones) ? claim.zones : [];
    const done = claim.zonesDone || {};
    if (claim.used) return null;
    if (zones.length > 0 && zones.every((zone) => done[String(zone.id || "")])) return null;
    return claim;
  }
  if (claim.used) return null;
  return claim;
}

// Recognizes a claim-token bearer that exists and has not timed out, even if it
// is exhausted (all zones done / used). Lets a scoped deliver call reach the
// tool handler so it can return the authoritative error (e.g. 400
// zone_not_in_claim) instead of the generic preflight 401.
function lookupKnownClaim(token) {
  const key = String(token || "").trim();
  if (!key) return null;
  pruneDesignState();
  const claim = designClaims.get(key);
  if (!claim) return null;
  if (claim.expiresAt <= Date.now()) {
    designClaims.delete(key);
    return null;
  }
  return claim;
}

function claimKnown(token) {
  return Boolean(lookupKnownClaim(token));
}

function designArgsWithClaimDefaults(args = {}) {
  const claim = lookupKnownClaim(args.claim_token || args.claimToken);
  if (!claim) return args;
  const next = { ...args };
  if (!next.character_id && !next.characterId) next.character_id = claim.characterId;
  if (!next.character_name && !next.characterName && claim.characterName) next.character_name = claim.characterName;
  if (!next.source_image_url && !next.sourceImageUrl && claim.sourceImageUrl) next.source_image_url = claim.sourceImageUrl;
  if (!next.identity_contract && !next.identityContract && claim.identityContract?.length) next.identity_contract = claim.identityContract;
  if (!next.negative_prompt && !next.negativePrompt && claim.negativePrompt) next.negative_prompt = claim.negativePrompt;
  if (claim.kind === "sheet") {
    if (!Array.isArray(next.zones) && claim.zones?.length) next.zones = claim.zones;
    if (!next.grid && claim.grid) next.grid = claim.grid;
  } else {
    if (!next.zone_id && !next.zoneId && claim.zoneId) next.zone_id = claim.zoneId;
    if (!next.zone_label && !next.zoneLabel && claim.label) next.zone_label = claim.label;
  }
  return next;
}

function mcpAuthorized(req, url) {
  if (!process.env.MCP_TOKEN) return true;
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const queryToken = url.searchParams.get("access_token") || "";
  return bearer === process.env.MCP_TOKEN || queryToken === process.env.MCP_TOKEN;
}

function webAuthorized(req, url) {
  if (!webAccessToken) return true;
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const queryToken = url.searchParams.get("access_token") || "";
  return bearer === webAccessToken || queryToken === webAccessToken;
}

function mcpTools() {
  return [
    {
      name: "upload_image",
      description: "Upload an image data URL to Studio's image library and return the public Cloud URL. Use this for agent-generated imagegen outputs before delivering them back to a character-design claim.",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "Image data URL to upload." },
          data_url: { type: "string", description: "Alias for image." },
          name: { type: "string", description: "Optional filename for the uploaded image." },
          tag: { type: "string", description: "Cloud tag for the saved image; use design for character-design images.", default: "studio" },
        },
        additionalProperties: true,
      },
    },
    {
      name: "create_video_task",
      description: "Create a Studio/Seedance 2.0 Pro video task from text, actual first/last scene frames, Ark reference image(s), or reference audio. Do not mix first/last-frame inputs with reference-image inputs in one task. Character sheets, info graphs, turnarounds, and reference boards must be passed as reference_image_url(s), never as image_url. For best shot control, use imagegen with thinking to make the real storyboard/scene frame first, then pass that scene frame as image_url.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Video prompt for the real scene action. Do not describe a character sheet/info graph/reference board as the opening frame or first frame." },
          image_url: { type: "string", description: "Optional actual scene first-frame image URL for image-to-video. Sent to Ark with role=first_frame. Never pass a character sheet, info graph, turnaround, or reference board here. Do not combine with reference_image_url(s); Ark rejects mixed first/last-frame and reference-media inputs." },
          last_frame_image_url: { type: "string", description: "Optional actual final scene frame image URL. Sent to Ark with role=last_frame. Requires image_url and cannot be combined with reference_image_url(s)." },
          image_role: { type: "string", enum: ["scene_first_frame", "character_reference"], description: "Role of image_url. Use scene_first_frame for an actual opening scene frame; use character_reference only when intentionally passing a character sheet/info graph as reference input." },
          reference_image_url: { type: "string", description: "Optional character reference image URL. Sent to Ark as an image_url content item with role=reference_image, not as the first frame. Do not combine with image_url/last_frame_image_url; use imagegen to bake the character into a scene frame when first-frame control is needed." },
          reference_image_urls: { type: "array", items: { type: "string" }, description: "Optional multiple character reference image URLs. Each is sent with role=reference_image. Do not combine with first/last frame images." },
          audio_url: { type: "string", description: "Optional reference audio URL or audio data URL. Sent to Ark as an audio_url content item with role=reference_audio." },
          audio_urls: { type: "array", items: { type: "string" }, description: "Optional multiple reference audio URLs. Alias for reference_audio_urls." },
          reference_audio: { anyOf: [{ type: "string" }, { type: "array" }, { type: "object" }], description: "Optional reference audio URL, object with url/src/media_url, or array of those. Sent to Ark with role=reference_audio." },
          reference_audio_url: { type: "string", description: "Optional reference audio URL or audio data URL. Alias for audio_url." },
          reference_audio_urls: { type: "array", items: { type: "string" }, description: "Optional multiple reference audio URLs. Each is sent with role=reference_audio." },
          generate_audio: { type: "boolean", default: true, description: "When true, request Ark/Seedance generated audio for the video." },
          generateAudio: { type: "boolean", default: true, description: "Alias for generate_audio." },
          image_id: { type: "string", description: "Optional reference image id." },
          thumb: { type: "string", description: "Optional preview thumbnail URL. Do not pass the character reference image as the thumbnail." },
          resolution: { type: "string", enum: ["720p", "1080p", "2K"], default: "1080p" },
          aspect: { type: "string", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
          duration: { type: "integer", minimum: 5, maximum: 15, default: 5 },
          camera: { type: "string", enum: ["fixed", "dynamic"], default: "dynamic" },
          seed: { type: "integer", default: -1 },
        },
        required: ["prompt"],
        additionalProperties: true,
      },
    },
    {
      name: "get_video_task",
      description: "Fetch a persisted video task by local task id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Local task id returned by create_video_task." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_video_tasks",
      description: "List persisted video tasks from the shared server queue.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional status filter." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "design_iterate",
      description: "Iterate a single character-design zone/aspect with ARK seedream and persist the result to Cloud (default tag=design). Mirrors the Studio character-design zone endpoint so a bot can drive per-aspect refinement. Pass source_image_url for the actual reference image; it is sent to ARK as image reference input, not only described in text.",
      inputSchema: {
        type: "object",
        properties: {
          character_name: { type: "string", description: "Character display name." },
          character_code: { type: "string", description: "Character code identifier." },
          zone_id: { type: "string", description: "The zone/aspect id being iterated." },
          zone_label: { type: "string", description: "Human-readable label for the zone." },
          zone_role: { type: "string", description: "Role/purpose of the zone." },
          instruction: { type: "string", description: "Instruction describing the requested change for this zone." },
          identity_contract: { type: "array", items: { type: "string" }, description: "Identity contract constraints to preserve." },
          negative_prompt: { type: "string", description: "Negative prompt describing what to avoid." },
          aspect: { type: "string", description: "Optional aspect ratio intent, e.g. 1:1." },
          size: { type: "string", description: "Optional explicit output size, e.g. 1920x1920." },
          seed: { type: "integer", description: "Optional seed for reproducibility." },
          claim_token: { type: "string", description: "Optional Studio claim token; scoped callers can use it to fill claim-bound character/source defaults." },
          source_image_url: { type: "string", description: "Optional current/source image URL to refine." },
          reference_image_urls: { type: "array", items: { type: "string" }, description: "Optional reference image URLs for identity." },
          tag: { type: "string", description: "Cloud tag for the saved image (default design).", default: "design" },
        },
        required: ["zone_id", "instruction"],
        additionalProperties: true,
      },
    },
    {
      name: "design_upload",
      description: "Precisely upload a single design image data URL to Cloud tagged for design (default tag=design). Returns the public image URL.",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "Image data URL to upload." },
          data_url: { type: "string", description: "Alias for image." },
          name: { type: "string", description: "Optional filename for the uploaded image." },
          tag: { type: "string", description: "Cloud tag for the saved image (default design).", default: "design" },
        },
        required: ["image"],
        additionalProperties: true,
      },
    },
    {
      name: "design_list",
      description: "Get or list design images from Cloud by tag (default tag=design). Returns image entries with public URLs and a pagination cursor.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Cloud tag to list (default design).", default: "design" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          cursor: { type: "string", description: "Pagination cursor." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "generate_character_sheet",
      description: "Generate a full multi-view identity set for a character from a source image via ARK seedream reference image input. For best identity fidelity, call with output=\"zones\" / return_zones=true; Studio returns one persisted Cloud image per requested zone, suitable for deliver_character_zone. The legacy contact-sheet output is still available for output=\"sheet\".",
      inputSchema: {
        type: "object",
        properties: {
          source_image_url: { type: "string", description: "Source/reference image URL for the character identity." },
          claim_token: { type: "string", description: "Optional Studio claim token; scoped callers can use it to fill claim-bound character/source/zones defaults." },
          source_image_urls: { type: "array", items: { type: "string" }, description: "Optional additional source/reference image URLs for the character identity." },
          output: { type: "string", enum: ["zones", "sheet"], description: "Use zones for one high-quality image per view; use sheet for a single 3x3 contact sheet." },
          return_zones: { type: "boolean", description: "Alias for output=zones." },
          zones: {
            type: "array",
            description: "Zones to generate, one image per zone in order.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Zone id." },
                label: { type: "string", description: "Human-readable zone label." },
                prompt: { type: "string", description: "Framing/view instruction for this zone." },
              },
              required: ["id", "prompt"],
              additionalProperties: true,
            },
          },
          character_name: { type: "string", description: "Character display name." },
          identity_contract: { type: "array", items: { type: "string" }, description: "Identity contract constraints to preserve." },
          negative_prompt: { type: "string", description: "Negative prompt describing what to avoid." },
          size: { type: "string", description: "Optional output size, e.g. 2K." },
          tag: { type: "string", description: "Cloud tag for the saved images (default design).", default: "design" },
        },
        required: ["source_image_url", "zones"],
        additionalProperties: true,
      },
    },
    {
      name: "deliver_character_zone",
      description: "Deliver one finished character-design zone image back to the Studio website using a single-use claim token issued by the website. Provide image_url (a public https URL you uploaded to your cloud) OR image (an image data URL to upload). The image is pushed to the website inbox and applied to the claimed character zone. The claim token is single-use and short-lived.",
      inputSchema: {
        type: "object",
        properties: {
          claim_token: { type: "string", description: "Single-use claim token issued by the Studio website for one character zone." },
          image_url: { type: "string", description: "Public https URL of the finished image you uploaded to your cloud." },
          image: { type: "string", description: "Optional image data URL of the finished image to upload to Cloud instead of image_url." },
          note: { type: "string", description: "Optional note describing the delivery." },
        },
        required: ["claim_token"],
        additionalProperties: true,
      },
    },
    {
      name: "deliver_character_sheet",
      description: "Deliver ONE finished 3x3 identity contact sheet image back to the Studio website using a single-use claim token; the website crops it into the character's zones. Provide sheet_image_url (public https) or image (data URL).",
      inputSchema: {
        type: "object",
        properties: {
          claim_token: { type: "string", description: "Single-use claim token issued by the Studio website for one character sheet." },
          sheet_image_url: { type: "string", description: "Public https URL of the finished contact sheet you uploaded to your cloud." },
          image_url: { type: "string", description: "Alias for sheet_image_url." },
          image: { type: "string", description: "Optional image data URL of the finished contact sheet to upload to Cloud instead of a url." },
          note: { type: "string", description: "Optional note describing the delivery." },
        },
        required: ["claim_token"],
        additionalProperties: true,
      },
    },
  ];
}

function mcpTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function callMcpTool(name, args = {}) {
  if (name === "upload_image") {
    const image = args.image || args.data_url || args.image_url || args.src;
    if (!image) {
      throw httpError(400, "image_required", "Image data URL is required.");
    }
    const tag = String(args.tag || args.cloud_tag || args.cloudTag || "").trim();
    const uploaded = await uploadImageToRepo(image, args.name || args.filename || "image.jpg", "Image", tag || undefined);
    if (!uploaded) {
      throw httpError(400, "image_invalid", "Unsupported image data URL.");
    }
    return mcpTextResult({ image: uploadedImagePayload(uploaded, args.name || args.filename) });
  }

  if (name === "create_video_task") {
    const task = await createVideoTask({ ...args, model: "seedance-pro" });
    return mcpTextResult({ task: publicTask(task) });
  }

  if (name === "get_video_task") {
    const task = tasks.get(String(args.id || ""));
    if (!task) {
      throw httpError(404, "task_not_found", "Task not found.");
    }
    return mcpTextResult({ task: publicTask(task) });
  }

  if (name === "list_video_tasks") {
    const status = args.status ? normalizeStatus(args.status) : null;
    const limit = clampInt(args.limit, 1, 100, 20);
    const items = [...tasks.values()]
      .filter((task) => !status || task.status === status)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map(publicTask);
    return mcpTextResult({ tasks: items });
  }

  if (name === "design_iterate") {
    const scopedArgs = designArgsWithClaimDefaults(args);
    const result = await generateCharacterZoneImage({ ...scopedArgs, tag: scopedArgs.tag || "design" }, publicBaseUrl);
    return mcpTextResult(result);
  }

  if (name === "design_upload") {
    const image = args.image || args.data_url;
    if (!image) {
      throw httpError(400, "image_required", "Image data URL is required.");
    }
    const uploaded = await uploadImageToRepo(image, args.name || "design.jpg", "Design image", args.tag || "design");
    if (!uploaded) {
      throw httpError(400, "image_invalid", "Unsupported image data URL.");
    }
    return mcpTextResult({ image: uploadedImagePayload(uploaded, args.name) });
  }

  if (name === "design_list") {
    const out = await listImagesFromRepo({ limit: clampInt(args.limit, 1, 200, 50), cursor: args.cursor || "", tag: args.tag || "design" });
    return mcpTextResult(out);
  }

  if (name === "generate_character_sheet") {
    const scopedArgs = designArgsWithClaimDefaults(args);
    const out = await generateCharacterSheet({ ...scopedArgs, tag: scopedArgs.tag || "design" }, publicBaseUrl);
    return mcpTextResult(out);
  }

  if (name === "deliver_character_zone") {
    const claimToken = args.claim_token || args.claimToken;
    // Use the recognized (even exhausted) claim to validate zone membership so an
    // unknown zone_id yields the authoritative 400 rather than a generic 401, then
    // gate the actual delivery on resolveDesignClaim (claim still live).
    const knownClaim = lookupKnownClaim(claimToken);
    if (!knownClaim) {
      throw httpError(401, "invalid_or_expired_claim", "The claim token is invalid, used, or expired.");
    }
    let zoneId;
    if (knownClaim.kind === "sheet") {
      zoneId = String(args.zone_id || args.zoneId || "").trim();
      const zones = Array.isArray(knownClaim.zones) ? knownClaim.zones : [];
      if (!zoneId || !zones.some((zone) => String(zone.id || "") === zoneId)) {
        throw httpError(400, "zone_not_in_claim", "zone_id must be one of the zones in this sheet claim.");
      }
    } else {
      zoneId = knownClaim.zoneId;
    }
    const claim = resolveDesignClaim(claimToken);
    if (!claim) {
      throw httpError(401, "invalid_or_expired_claim", "The claim token is invalid, used, or expired.");
    }
    let imageUrl = "";
    const dataImage = args.image || args.data_url;
    if (typeof dataImage === "string" && dataImage.startsWith("data:")) {
      const uploaded = await uploadImageToRepo(dataImage, `bot-${zoneId}.jpg`, "Bot delivery", "design");
      if (!uploaded?.url) {
        throw httpError(400, "image_invalid", "Unsupported image data URL.");
      }
      imageUrl = uploaded.url;
    } else {
      imageUrl = String(args.image_url || args.imageUrl || "").trim();
      if (!/^https:\/\//i.test(imageUrl)) {
        throw httpError(400, "image_url_required", "Provide a public https image_url or an image data URL.");
      }
    }
    if (claim.kind === "sheet") {
      claim.zonesDone = claim.zonesDone || {};
      claim.zonesDone[zoneId] = true;
    } else {
      claim.used = true;
    }
    const delivery = {
      id: "dlv_" + randomUUID(),
      kind: "zone",
      characterId: claim.characterId,
      zoneId,
      image: {
        url: imageUrl,
        name: `bot-${zoneId}.jpg`,
        provider: "bot",
        cloud: true,
        temporary: false,
      },
      note: String(args.note || "").trim() || null,
      deliveredAt: Date.now(),
    };
    designDeliveries.push(delivery);
    pruneDesignState();
    return mcpTextResult({ ok: true, delivered: true, zone_id: zoneId });
  }

  if (name === "deliver_character_sheet") {
    const claim = resolveDesignClaim(args.claim_token || args.claimToken);
    if (!claim) {
      throw httpError(401, "invalid_or_expired_claim", "The claim token is invalid, used, or expired.");
    }
    const grid = claim.grid && typeof claim.grid === "object" ? claim.grid : { rows: 3, cols: 3 };
    let url = "";
    const dataImage = args.image || args.data_url;
    if (typeof dataImage === "string" && dataImage.startsWith("data:")) {
      const uploaded = await uploadImageToRepo(dataImage, `bot-sheet-${claim.characterId}.jpg`, "Bot sheet delivery", "design");
      if (!uploaded?.url) {
        throw httpError(400, "image_invalid", "Unsupported image data URL.");
      }
      url = uploaded.url;
    } else {
      url = String(args.sheet_image_url || args.image_url || args.imageUrl || "").trim();
      if (!/^https:\/\//i.test(url)) {
        throw httpError(400, "sheet_image_url_required", "Provide a public https sheet_image_url or an image data URL.");
      }
    }
    const zones = Array.isArray(claim.zones) ? claim.zones : [];
    claim.zonesDone = claim.zonesDone || {};
    for (const zone of zones) claim.zonesDone[String(zone.id || "")] = true;
    claim.used = true;
    const delivery = {
      id: "dlv_" + randomUUID(),
      kind: "sheet",
      characterId: claim.characterId,
      sheet: {
        url,
        grid,
        zones: zones.map((zone) => ({ id: zone.id, label: zone.label })),
      },
      note: String(args.note || "").trim() || null,
      deliveredAt: Date.now(),
    };
    designDeliveries.push(delivery);
    pruneDesignState();
    return mcpTextResult({ ok: true, delivered: true, kind: "sheet", zones: zones.length });
  }

  throw httpError(404, "tool_not_found", `Unknown MCP tool: ${name}`);
}

const SCOPED_MCP_TOOLS = new Set([
  "upload_image",
  "deliver_character_zone",
  "deliver_character_sheet",
]);

async function handleMcpRpc(message, scope = {}) {
  const id = message?.id;
  const method = message?.method;
  const params = message?.params || {};
  const scoped = Boolean(scope.scoped);

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "studio", version: "1.0.0" },
        },
      };
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      const tools = scoped ? mcpTools().filter((tool) => SCOPED_MCP_TOOLS.has(tool.name)) : mcpTools();
      return { jsonrpc: "2.0", id, result: { tools } };
    }

    if (method === "tools/call") {
      const args = { ...(params.arguments || {}) };
      if (scoped) {
        if (!SCOPED_MCP_TOOLS.has(params.name)) {
          throw httpError(401, "unauthorized", "This claim token may only deliver design results.");
        }
        if (!args.claim_token && !args.claimToken && scope.bearerClaim) {
          args.claim_token = scope.bearerClaim;
        }
      }
      const result = await callMcpTool(params.name, args);
      return { jsonrpc: "2.0", id, result };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.status || -32000,
        message: error.message || "MCP tool failed.",
        data: publicError(error),
      },
    };
  }
}

function mcpBearer(req) {
  const header = String(req.headers.authorization || "");
  return header.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

// A scoped JSON-RPC message is permitted for a claim-token bearer when it is
// one of the handshake methods, a tools/list, or a tools/call for the small
// claim-scoped design tool set with a valid claim (bearer claim or claim_token arg).
function scopedMcpMessageAllowed(message, bearerClaim) {
  const method = message?.method;
  if (method === "initialize" || method === "ping" || method === "notifications/initialized" || method === "tools/list") {
    return true;
  }
  if (method === "tools/call") {
    const params = message?.params || {};
    if (!SCOPED_MCP_TOOLS.has(params.name)) return false;
    const args = params.arguments || {};
    const token = args.claim_token || args.claimToken || bearerClaim;
    // A recognized (not timed-out) claim may reach the deliver handler so it can
    // return the authoritative result/error even when the claim is exhausted.
    return Boolean(resolveDesignClaim(token)) || claimKnown(token);
  }
  return false;
}

async function handleMcp(req, res, url) {
  const master = mcpAuthorized(req, url);
  const bearer = mcpBearer(req);
  const bearerClaim = !master && bearer.startsWith("clm_") && claimKnown(bearer) ? bearer : "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    });
    res.end();
    return;
  }

  if (req.method === "GET") {
    // Master callers see the full tool list; a valid claim-token bearer sees
    // only the scoped delivery tool. Anyone else is rejected.
    if (!master && !bearerClaim) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Invalid MCP token." } });
      return;
    }
    const advertised = master ? mcpTools() : mcpTools().filter((tool) => SCOPED_MCP_TOOLS.has(tool.name));
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("event: endpoint\n");
    res.write("data: /mcp\n\n");
    res.write("event: tools\n");
    res.write(`data: ${JSON.stringify({ tools: advertised.map((tool) => tool.name) })}\n\n`);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "MCP supports GET and POST." } });
    return;
  }

  const body = await readJson(req);
  const batch = Array.isArray(body) ? body : [body];

  if (!master) {
    // Scoped access: the caller must present a valid claim (bearer claim token or
    // a claim_token argument on a scoped design call), and every message in the
    // batch must be allowed for that scoped claim-token caller.
    const presentsClaim =
      Boolean(bearerClaim) ||
      batch.some((message) => {
        const args = message?.params?.arguments || {};
        const token = args.claim_token || args.claimToken;
        return Boolean(resolveDesignClaim(token)) || claimKnown(token);
      });
    const allowed =
      presentsClaim &&
      batch.length > 0 &&
      batch.every((message) => scopedMcpMessageAllowed(message, bearerClaim));
    if (!allowed) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Invalid MCP token." } });
      return;
    }
  }

  const scope = { scoped: !master, bearerClaim };
  const responses = (await Promise.all(batch.map((message) => handleMcpRpc(message, scope)))).filter(Boolean);

  if (responses.length === 0) {
    res.writeHead(202, { "cache-control": "no-store" });
    res.end();
    return;
  }

  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}

async function routeApi(req, res, url) {
  try {
    if (url.pathname === "/api/auth/config") {
      sendJson(res, 200, {
        authRequired: Boolean(webAccessToken),
        image: {
          model: arkImageModel,
          size: arkImageSize,
          uploadConfigured: Boolean(imageRepoBaseUrl && imageRepoUploadKey),
          tag: imageRepoTag,
        },
      });
      return true;
    }

    if (url.pathname === "/api/auth/verify") {
      if (!webAuthorized(req, url)) {
        sendJson(res, 401, { error: { code: "unauthorized", message: "Invalid access token." } });
      } else {
        sendJson(res, 200, { ok: true });
      }
      return true;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res, url);
      return true;
    }

    if (url.pathname === "/api/ark/webhook" && req.method === "POST") {
      await handleArkWebhook(req, res, url);
      return true;
    }

    // The sheet-proxy only serves host-allowlisted public images (repo host +
    // *.volces.com) and must be loadable by <img>/canvas (which cannot send the
    // bearer header), so it stays open like /media/* and static assets.
    if (
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/character-design/sheet-proxy" &&
      !webAuthorized(req, url)
    ) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Sign in to continue." } });
      return true;
    }

    if (url.pathname === "/api/generate" && req.method === "POST") {
      await handleGenerate(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/zone" && req.method === "POST") {
      await handleCharacterZoneImage(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/sheet" && req.method === "POST") {
      await handleCharacterSheet(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/claim" && req.method === "POST") {
      await handleCharacterDesignClaim(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/state" && req.method === "GET") {
      await handleGetCharacterDesignState(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/state" && (req.method === "PUT" || req.method === "POST")) {
      await handlePutCharacterDesignState(req, res);
      return true;
    }

    if (url.pathname === "/api/character-design/inbox" && req.method === "GET") {
      handleCharacterDesignInbox(req, res, url);
      return true;
    }

    if (url.pathname === "/api/character-design/sheet-proxy" && req.method === "GET") {
      await handleCharacterDesignSheetProxy(req, res, url);
      return true;
    }

    if ((url.pathname === "/api/images" || url.pathname === "/api/images/upload") && req.method === "POST") {
      await handleUploadImage(req, res);
      return true;
    }

    if (url.pathname === "/api/images" && req.method === "GET") {
      await handleListImages(req, res, url);
      return true;
    }

    const imageMatch = url.pathname.match(/^\/api\/images\/(.+)$/);
    if (imageMatch && req.method === "DELETE") {
      await handleDeleteImage(req, res, decodeURIComponent(imageMatch[1]));
      return true;
    }

    if (url.pathname === "/api/tasks" && req.method === "GET") {
      await handleListTasks(req, res);
      return true;
    }

    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (taskMatch && req.method === "GET") {
      await handleGetTask(req, res, decodeURIComponent(taskMatch[1]));
      return true;
    }

    if (taskMatch && req.method === "DELETE") {
      await handleDeleteTask(req, res, decodeURIComponent(taskMatch[1]));
      return true;
    }
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: publicError(error) });
    return true;
  }

  return false;
}

function readJson(req, maxBytes = maxJsonBodyBytes) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    let settled = false;
    const contentLength = Number(req.headers["content-length"] || 0);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      raw = "";
      req.resume();
      reject(error);
    };

    if (contentLength > maxBytes) {
      fail(httpError(413, "body_too_large", `Request body is too large. Limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`));
      return;
    }

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        fail(httpError(413, "body_too_large", `Request body is too large. Limit is ${Math.floor(maxBytes / 1024 / 1024)} MB.`));
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!raw) {
        resolveBody({});
        return;
      }

      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(httpError(400, "invalid_json", "Request body must be valid JSON."));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function httpError(status, code, message, cause) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.cause = cause;
  return error;
}

function publicError(error) {
  return {
    code: error.code || "server_error",
    message: error.message || "Unexpected server error.",
  };
}

function resolveAsset(urlPath) {
  const cleanPath = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(root, `.${cleanPath}`);

  if (!candidate.startsWith(root)) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  return join(root, "index.html");
}

function resolveDataAsset(urlPath) {
  const withoutPrefix = urlPath.replace(/^\/media\/?/, "");
  const cleanPath = normalize(decodeURIComponent(withoutPrefix.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(publicDataDir, `./${cleanPath}`);

  if (!candidate.startsWith(publicDataDir)) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  return null;
}

function parseRangeHeader(rangeHeader, size) {
  const match = String(rangeHeader || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return { invalid: true };

  if (!startRaw) {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number.parseInt(startRaw, 10);
  const end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end < start) {
    return { invalid: true };
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function sendFile(req, res, filePath, cacheControl) {
  const ext = extname(filePath);
  const { size } = statSync(filePath);
  const baseHeaders = {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "cache-control": cacheControl,
    "accept-ranges": "bytes",
  };

  const range = parseRangeHeader(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${size}`,
      "content-length": "0",
    });
    res.end();
    return;
  }

  if (range) {
    const chunkSize = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "content-length": String(chunkSize),
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    "content-length": String(size),
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
}

function scheduleBackgroundTimer(callback, delayMs) {
  if (isShuttingDown) return null;
  const timer = setTimeout(() => {
    backgroundTimers.delete(timer);
    if (!isShuttingDown) callback();
  }, delayMs);
  timer.unref?.();
  backgroundTimers.add(timer);
  return timer;
}

function trackBackgroundJob(promise) {
  const tracked = Promise.resolve(promise).finally(() => {
    backgroundJobs.delete(tracked);
  });
  backgroundJobs.add(tracked);
  return tracked;
}

function createShutdownController() {
  const controller = new AbortController();
  shutdownControllers.add(controller);
  return {
    controller,
    release: () => shutdownControllers.delete(controller),
  };
}

function isShutdownAbort(error) {
  return isShuttingDown && (error?.name === "AbortError" || error?.code === "ABORT_ERR");
}

function clearScheduledWork() {
  for (const timer of pollTimers.values()) {
    clearTimeout(timer);
  }
  pollTimers.clear();

  for (const timer of backgroundTimers) {
    clearTimeout(timer);
  }
  backgroundTimers.clear();
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close((error) => {
      if (error) {
        console.error("server close failed", publicError(error));
      }
      resolveClose();
    });
  });
}

async function shutdown(signal) {
  if (isShuttingDown) {
    console.warn(`received ${signal} while shutdown is already in progress; forcing open connections closed`);
    server.closeAllConnections?.();
    for (const socket of activeSockets) {
      socket.destroy();
    }
    return;
  }

  isShuttingDown = true;
  console.log(`received ${signal}; starting graceful shutdown with ${shutdownGraceMs}ms grace`);

  clearScheduledWork();
  for (const controller of shutdownControllers) {
    controller.abort();
  }

  try {
    saveTasks();
  } catch (error) {
    console.error("failed to save tasks during shutdown", publicError(error));
  }

  server.closeIdleConnections?.();

  const forceCloseTimer = setTimeout(() => {
    console.warn(`shutdown grace exceeded; forcing ${activeSockets.size} open connection(s) closed`);
    server.closeAllConnections?.();
    for (const socket of activeSockets) {
      socket.destroy();
    }
  }, shutdownGraceMs);

  await Promise.race([
    Promise.allSettled([
      closeServer(server),
      Promise.allSettled([...backgroundJobs]),
    ]),
    wait(shutdownGraceMs),
  ]);

  clearTimeout(forceCloseTimer);

  try {
    saveTasks();
  } catch (error) {
    console.error("failed to save tasks after shutdown", publicError(error));
  }

  console.log("graceful shutdown complete");
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (isShuttingDown) {
    res.setHeader("connection", "close");
    sendJson(res, 503, { error: { code: "server_shutting_down", message: "Server is shutting down." } });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      ark: Boolean(arkApiKey),
      tasks: tasks.size,
      monitor_mode: monitorMode,
      webhook_ready: monitorMode === "webhook" ? Boolean(callbackBaseUrl) : false,
      data_dir: dataDir,
      max_json_body_bytes: maxJsonBodyBytes,
      max_image_bytes: maxImageBytes,
      max_audio_bytes: maxAudioBytes,
      image_repo: {
        base_url: imageRepoBaseUrl,
        tag: imageRepoTag || null,
        upload_key_configured: Boolean(imageRepoUploadKey),
      },
      artifacts: [...tasks.values()].filter((task) => task.artifactUrl).length,
      covers: [...tasks.values()].filter((task) => task.coverUrl).length,
      input_images: [...tasks.values()].filter((task) => task.inputImagePath).length,
      last_frame_images: [...tasks.values()].filter((task) => task.lastFrameImagePath).length,
      reference_images: [...tasks.values()].reduce((total, task) => total + normalizeUrlList(task.referenceImagePaths || task.referenceImagePath).length, 0),
      reference_audios: [...tasks.values()].reduce((total, task) => total + normalizeUrlList(task.referenceAudioPaths || task.referenceAudioPath).length, 0),
    });
    return;
  }

  if (url.pathname === "/state/tasks.json") {
    if (!webAuthorized(req, url)) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Sign in to continue." } });
      return;
    }
    if (!existsSync(publicTasksFile)) {
      saveTasks();
    }
    sendFile(req, res, publicTasksFile, "no-store");
    return;
  }

  if (url.pathname.startsWith("/media/")) {
    const dataFile = resolveDataAsset(url.pathname);
    if (!dataFile) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    sendFile(req, res, dataFile, "public, max-age=31536000, immutable");
    return;
  }

  if (await routeApi(req, res, url)) {
    return;
  }

  const filePath = resolveAsset(req.url || "/");

  if (!filePath || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  sendFile(req, res, filePath, ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
});

server.on("connection", (socket) => {
  activeSockets.add(socket);
  socket.on("close", () => {
    activeSockets.delete(socket);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`studio listening on :${port}`);
  console.log(`task store: ${tasksFile}`);
  console.log(`artifact store: ${artifactsDir}`);
  console.log(`task monitor mode: ${monitorMode}`);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("graceful shutdown failed", publicError(error));
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("graceful shutdown failed", publicError(error));
    process.exit(1);
  });
});
