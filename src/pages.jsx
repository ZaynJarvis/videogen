import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Icon, DropZone, VideoPlayer, GenerationProgress } from './components';
import { useToast } from './useToast';
import { useStore, useHashRoute, relTime, fmtDate } from './store';
import { authHeader, clearToken, getToken } from './auth';
import { prepareUploadImage } from './imageUpload';
import { CHARACTER_DESIGNS, DEFAULT_CHARACTER_DESIGN, GENERIC_ZONE_DEFS } from './characterDesignData';
import { cropSheetToCells } from './sheetCrop';
import { stitchZonesToSheet } from './sheetStitch';

const HOST_PARAMS = {
  resolutions: ["720p", "1080p"],
  aspects: ["16:9", "9:16", "1:1"],
  durationMin: 5,
  durationMax: 15,
  cameras: ["fixed", "dynamic"],
};

const INPUT_MODES = [
  { id: "text", label: "Text" },
  { id: "frames", label: "Frames" },
  { id: "references", label: "References" },
];

const CHARACTER_SHEET_WAIT_MS = 30 * 60 * 1000;

const ACTIVE_TASK_STATUSES = new Set([
  "created",
  "queued",
  "running",
  "pending",
  "processing",
  "rendering",
  "submitted",
  "scheduled",
  "waiting",
  "not_started",
  "in_queue",
  "in_progress",
  "executing",
  "started",
]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);

function isActiveTask(status) {
  return ACTIVE_TASK_STATUSES.has(String(status || "").toLowerCase());
}

function videoPatchFromTask(task, current = {}) {
  const status = task.status || current.status || "queued";
  const monitorMode = task.monitor_mode || current.monitorMode || "poll";
  const progress = task.progress ?? (monitorMode === "webhook" && isActiveTask(status) ? null : current.progress ?? 0);
  const remoteThumb = task.cover_url || (task.thumb && !String(task.thumb).startsWith("data:") ? task.thumb : "");
  const referenceImageUrl = task.source_frame_url || task.reference_image_url || current.referenceImageUrl || null;
  const characterReferenceUrls = Array.isArray(task.character_reference_urls) && task.character_reference_urls.length
    ? task.character_reference_urls
    : task.character_reference_url
      ? [task.character_reference_url]
      : current.characterReferenceUrls || [];
  const characterReferenceUrl = characterReferenceUrls[0] || current.characterReferenceUrl || null;
  const referenceAudioUrls = Array.isArray(task.reference_audio_urls) && task.reference_audio_urls.length
    ? task.reference_audio_urls
    : task.reference_audio_url
      ? [task.reference_audio_url]
      : current.referenceAudioUrls || [];

  return {
    id: current.id || task.id,
    taskId: task.id,
    arkTaskId: task.task_id,
    status,
    progress,
    monitorMode,
    coverUrl: task.cover_url || current.coverUrl || null,
    coverStatus: task.cover_status || current.coverStatus || null,
    title: task.title || current.title || "Untitled take",
    prompt: task.prompt || current.prompt || "",
    src: task.video_url || current.src || "",
    thumb: remoteThumb || "",
    referenceImageUrl,
    lastFrameUrl: task.last_frame_url || current.lastFrameUrl || null,
    characterReferenceUrl,
    characterReferenceUrls,
    referenceAudioUrls,
    generateAudio: task.generate_audio ?? current.generateAudio ?? true,
    duration: task.duration || current.duration || 5,
    resolution: task.resolution || current.resolution || "1080p",
    aspect: task.aspect || current.aspect || "16:9",
    model: task.model || current.model || "seedance-pro",
    mode: task.mode || current.mode || "t2v",
    camera: task.camera || current.camera || "dynamic",
    seed: task.seed ?? current.seed ?? 0,
    imageId: task.image_id || current.imageId,
    error: task.error || current.error || null,
    createdAt: task.created_at || current.createdAt || Date.now(),
    updatedAt: task.updated_at || Date.now(),
    finishedAt: task.finished_at || current.finishedAt,
  };
}

function taskRuntimeText(v) {
  if (!isActiveTask(v.status)) return `${v.duration}s · ${v.resolution}`;
  if (v.monitorMode === "poll" && Number.isFinite(v.progress)) return `${Math.round(v.progress)}%`;
  return "rendering";
}

function taskBadgeText(v) {
  const active = isActiveTask(v.status);
  const failed = TERMINAL_TASK_STATUSES.has(v.status) && v.status !== "succeeded";
  if (active && v.monitorMode === "webhook") return "RENDERING";
  if (active || failed) return String(v.status || "queued").toUpperCase();
  if (v.mode === "ref2v") return "REF→V";
  return v.mode === "i2v" ? "I→V" : "T→V";
}

function modeLabel(mode) {
  if (mode === "i2v") return "image → video";
  if (mode === "ref2v") return "reference → video";
  return "text → video";
}

function taskSort(a, b) {
  const activeDelta = Number(isActiveTask(b.status)) - Number(isActiveTask(a.status));
  if (activeDelta) return activeDelta;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

async function fetchJson(path, options = {}) {
  const merged = {
    ...options,
    headers: { ...(options.headers || {}), ...authHeader() },
  };
  const res = await fetch(path, merged);
  if (res.status === 401) {
    if (getToken()) {
      clearToken();
      window.location.reload();
    }
    const error = new Error("Session expired. Sign in again.");
    error.status = 401;
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error?.message || `Request failed with HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function imageFromUploadResponse(data, fallback = {}) {
  const image = data?.image || data || {};
  const src = image.src || image.url;
  if (!src) {
    throw new Error("Image upload did not return a URL.");
  }

  const provider = image.provider || fallback.provider || "cloud";
  return {
    id: image.id || fallback.id,
    name: image.name || fallback.name || "upload.png",
    src,
    url: image.url || src,
    mediaPath: image.media_path || fallback.mediaPath,
    path: image.path || fallback.path,
    key: image.key || fallback.key || null,
    tag: image.tag || fallback.tag || null,
    provider,
    bytes: image.bytes || fallback.bytes,
    mime: image.mime || fallback.mime,
    mediaType: image.mediaType || image.media_type || fallback.mediaType || "image",
    addedAt: image.added_at || fallback.addedAt || Date.now(),
    cloud: image.cloud ?? fallback.cloud ?? (provider === "cloud" || Boolean(image.key)),
    temporary: image.temporary ?? fallback.temporary ?? false,
  };
}

function imageFromListResponse(image) {
  const src = image?.src || image?.url;
  if (!src) return null;
  const addedAt = image.addedAt
    || (typeof image.added_at === "number" ? image.added_at : Date.parse(image.added_at || image.lastModified || image.last_modified || ""))
    || Date.now();

  return {
    id: image.id || image.key || src,
    name: image.name || image.filename || "cloud image",
    src,
    url: image.url || src,
    mediaPath: image.mediaPath || image.media_path || image.url || src,
    path: image.path || null,
    key: image.key || null,
    tag: image.tag || null,
    provider: image.provider || "cloud",
    bytes: image.bytes || image.size || null,
    mime: image.mime || image.contentType || image.content_type || null,
    addedAt,
    cloud: true,
  };
}

async function uploadImageAsset(img, tag = img?.tag || "") {
  const src = String(img?.src || "");
  if (!src) {
    throw new Error("Image is missing.");
  }
  if (!src.startsWith("data:")) {
    return { ...img, tag: tag || img.tag, cloud: true };
  }

  const data = await fetchJson("/api/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: img.name, image: src, tag }),
  });
  return imageFromUploadResponse(data, img);
}

async function deleteRemoteTask(v) {
  const id = v?.taskId || v?.id;
  if (!id || (!v?.taskId && !v?.arkTaskId)) return;

  try {
    await fetchJson(`/api/task/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if (!String(error.message || "").toLowerCase().includes("not found")) {
      throw error;
    }
  }
}

function encodeCloudKeyPath(key) {
  return String(key || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function cloudKeyFromImage(img) {
  const key = String(img?.key || "").trim();
  if (key) return key;
  const src = String(img?.url || img?.src || "");
  try {
    const url = new URL(src, window.location.href);
    const match = url.pathname.match(/^\/i\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

async function deleteImageAsset(img) {
  const key = cloudKeyFromImage(img);
  if (!key) return false;
  await fetchJson(`/api/images/${encodeCloudKeyPath(key)}`, { method: "DELETE" });
  return true;
}

function isAppleTouchDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /iP(hone|ad|od)/.test(ua)
    || /iP(hone|ad|od)/.test(platform)
    || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function canAttemptFileShare() {
  return typeof navigator !== "undefined"
    && typeof navigator.share === "function"
    && typeof navigator.canShare === "function"
    && typeof File === "function";
}

function canShareVideoFile(file) {
  if (!canAttemptFileShare()) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function videoExtensionFromSrc(src) {
  try {
    const ext = new URL(src, window.location.href).pathname.match(/\.(mp4|m4v|mov|webm)$/i)?.[0];
    if (ext) return ext.toLowerCase();
  } catch {
    // Use the default below when the URL cannot be parsed.
  }
  return ".mp4";
}

function videoMimeFromExtension(ext) {
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "video/mp4";
}

function videoFileName(v) {
  const fallback = String(v?.taskId || v?.id || "studio-render").slice(0, 24) || "studio-render";
  const base = String(v?.title || fallback)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || fallback;
  return `${base}${videoExtensionFromSrc(v?.src || "")}`;
}

async function fetchVideoFile(src, filename) {
  if (typeof File !== "function") {
    throw new Error("This browser cannot prepare videos for sharing.");
  }

  const res = await fetch(src, { credentials: "same-origin", cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`Video download failed with HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const ext = videoExtensionFromSrc(filename);
  const type = blob.type || videoMimeFromExtension(ext);
  return new File([blob], filename, { type, lastModified: Date.now() });
}

function downloadVideoLink(src, filename) {
  const a = document.createElement("a");
  a.href = src;
  a.download = filename;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ServerTaskSync() {
  const { state, updateVideo, upsertVideo } = useStore();
  const videosRef = useRef(state.videos);

  useEffect(() => {
    videosRef.current = state.videos;
  }, [state.videos]);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const sync = async () => {
      try {
        const data = await fetchJson("/api/tasks");
        if (stopped) return;

        const remoteTasks = data.tasks || [];
        for (const task of remoteTasks) {
          const local = videosRef.current.find((v) => v.taskId === task.id || v.id === task.id);
          const patch = videoPatchFromTask(task, local || { id: task.id });
          if (local) updateVideo(local.id, patch);
          else upsertVideo(patch);
        }

        const remoteHasActive = remoteTasks.some((task) => isActiveTask(task.status));
        if (remoteHasActive) {
          timer = setTimeout(sync, 3000);
          return;
        }
      } catch {
        // The app can still render seed/local videos if the API is unavailable.
      }

      if (!stopped) {
        const hasActive = videosRef.current.some((v) => isActiveTask(v.status));
        timer = setTimeout(sync, hasActive ? 2500 : 5000);
      }
    };

    sync();
    const syncNow = () => {
      if (timer) clearTimeout(timer);
      sync();
    };
    window.addEventListener("focus", syncNow);
    window.addEventListener("hashchange", syncNow);
    document.addEventListener("visibilitychange", syncNow);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", syncNow);
      window.removeEventListener("hashchange", syncNow);
      document.removeEventListener("visibilitychange", syncNow);
    };
  }, [updateVideo, upsertVideo]);

  return null;
}

export function RemoteImageSync() {
  const { syncCloudImages } = useStore();

  useEffect(() => {
    let stopped = false;

    const sync = async () => {
      try {
        const images = [];
        let cursor = "";
        let syncTag = "";

        do {
          const params = new URLSearchParams({ limit: "120" });
          if (cursor) params.set("cursor", cursor);
          const data = await fetchJson(`/api/images?${params.toString()}`);
          images.push(...((data.images || []).map(imageFromListResponse).filter(Boolean)));
          cursor = data.nextCursor || "";
          syncTag = data.tag || syncTag;
        } while (cursor && !stopped);

        if (stopped) return;
        syncCloudImages(images, { tag: syncTag || "studio" });
      } catch (error) {
        console.warn("image library sync failed", error);
      }
    };

    sync();
    window.addEventListener("focus", sync);

    return () => {
      stopped = true;
      window.removeEventListener("focus", sync);
    };
  }, [syncCloudImages]);

  return null;
}

export function Nav({ route, navigate }) {
  const items = [
    { path: "/", icon: "home", label: "Home", kbd: "1" },
    { path: "/create", icon: "sparkle", label: "Create", kbd: "2" },
    { path: "/library", icon: "grid", label: "Library", kbd: "3" },
    { path: "/design", icon: "person", label: "Design", kbd: "4" },
  ];

  return (
    <nav className="nav">
      <div className="nav-section">Workspace</div>
      <div className="nav-items">
        {items.map((it) => (
          <button key={it.path}
             className={"nav-item" + (route.path === it.path ? " active" : "")}
             onClick={() => navigate(it.path)}>
            <Icon name={it.icon} size={16} />
            <span>{it.label}</span>
            <span className="kbd">{it.kbd}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function SectionHeader({ title, sub, count }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "8px 0 20px", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h2 className="display" style={{ fontSize: 26, margin: 0 }}>{title}</h2>
        {count != null && <span className="mono muted-2" style={{ fontSize: 11, letterSpacing: ".14em" }}>{String(count).padStart(2,"0")}</span>}
      </div>
      {sub && <span className="mono muted-2" style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase" }}>{sub}</span>}
    </div>
  );
}

function characterDesignDeepLink(characterId, zoneId) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.hash = `/design?character=${encodeURIComponent(characterId)}&zone=${encodeURIComponent(zoneId)}`;
  return url.toString();
}

function safeCharacterId(name) {
  return `character_${String(name || "character")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42) || "custom"}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUploadedCharacterMeta(name, sourceImage) {
  const cleanName = String(name || "").trim() || "New Character";
  const shortName = cleanName.split(/\s+/).slice(0, 2).join(" ");
  return {
    id: safeCharacterId(cleanName),
    code: `ID-C${Math.floor(100 + Math.random() * 900)}`,
    name: cleanName,
    shortName,
    tagline: "Uploaded reference character with reusable identity zones.",
    source: sourceImage.src,
    sourceCard: sourceImage.src,
    generatedSheet: sourceImage.src,
    sourcePackagePath: "custom/uploaded-character",
    spec: [
      ["Source", sourceImage.name || "Uploaded image"],
      ["Identity", cleanName],
      ["Build", "User supplied reference"],
      ["Face", "Preserve source facial identity"],
      ["Wardrobe", "Preserve source wardrobe and props"],
      ["Lighting", "Use source image as identity anchor"],
      ["Background", "Can vary by generation prompt"],
    ],
    identityContract: [
      `Preserve ${cleanName} as a distinct character across all generated shots.`,
      "Keep face, body scale, outfit, color palette, and recognizable props consistent with the uploaded reference.",
      "Do not merge this character with other characters or drift into a different identity.",
    ],
    negativePrompt: "No text, labels, logos, watermark, merged identity, different character, distorted face, malformed hands or paws, or cartoon style unless requested.",
    sheetPrompt: `Generate a clean multi-view identity sheet for ${cleanName} from the uploaded reference. Preserve the same identity across face, full-body, outfit, and prop zones.`,
    sourceImageId: sourceImage.id || null,
    sourceImageName: sourceImage.name || "uploaded reference",
    custom: true,
  };
}

function characterFromMeta(meta = {}) {
  const base = DEFAULT_CHARACTER_DESIGN;
  const sourceCard = meta.sourceCard || meta.source || base.sourceCard;
  const generatedSheet = meta.generatedSheet || sourceCard;
  const shortName = meta.shortName || meta.name || "Character";

  return {
    ...base,
    ...meta,
    id: meta.id || base.id,
    code: meta.code || "ID-CUSTOM",
    name: meta.name || "Custom Character",
    shortName,
    source: meta.source || sourceCard,
    sourceCard,
    generatedSheet,
    spec: Array.isArray(meta.spec) && meta.spec.length ? meta.spec : base.spec,
    identityContract: Array.isArray(meta.identityContract) && meta.identityContract.length ? meta.identityContract : base.identityContract,
    negativePrompt: meta.negativePrompt || base.negativePrompt,
    zones: (meta.custom ? GENERIC_ZONE_DEFS : base.zones).map((zone) => ({
      ...zone,
      image: sourceCard,
      sheetImage: sourceCard,
      referenceImage: sourceCard,
      improvement: zone.prompt || `Improve ${shortName}'s ${zone.label.toLowerCase()} view from the uploaded reference while preserving the same identity.`,
    })),
  };
}

function listWorkspaceCharacters(characterDesigns = {}) {
  const builtIns = new Map(CHARACTER_DESIGNS.map((character) => [character.id, character]));
  const custom = Object.entries(characterDesigns || {})
    .filter(([, saved]) => saved?.meta && !builtIns.has(saved.meta.id))
    .map(([, saved]) => characterFromMeta(saved.meta));
  return [...CHARACTER_DESIGNS, ...custom];
}

function resolveWorkspaceCharacter(characterDesigns = {}, characterId) {
  const characters = listWorkspaceCharacters(characterDesigns);
  // Returns null when the workspace has no characters yet (empty-state CTA).
  return characters.find((character) => character.id === characterId) || characters[0] || null;
}

function mergeCharacterZones(character, saved = {}) {
  if (!character?.zones) return [];
  const savedZones = saved.zones || {};
  return character.zones.map((zone) => {
    const override = savedZones[zone.id] || {};
    return {
      ...zone,
      // Only a real generated/delivered image becomes the zone image. Zones with
      // nothing yet have no image (loading skeleton / empty placeholder) — never
      // the duplicated source.
      currentImage: override.url || null,
      generated: Boolean(override.url),
      currentName: override.name || `${character.shortName} ${zone.label}`,
      imageId: override.imageId || null,
      updatedAt: override.updatedAt || null,
      note: override.note || "Prototype crop",
      botRequestedAt: override.botRequestedAt || null,
      lastBotPrompt: override.lastBotPrompt || "",
      model: override.model || "",
      generatedPrompt: override.generatedPrompt || "",
      referenceImages: Array.isArray(override.referenceImages) ? override.referenceImages : [],
      referenceDescription: override.referenceDescription || "",
      temporary: Boolean(override.temporary),
    };
  });
}

function characterReferenceItems(character, saved = {}) {
  const zones = mergeCharacterZones(character, saved);
  const preferred = ["full_front", "half_body", "face_front"]
    .map((id) => zones.find((zone) => zone.id === id))
    .filter(Boolean);
  const selected = preferred.length ? preferred : zones.slice(0, 2);
  return selected.map((zone) => {
    // Fall back to the source card for zones luna hasn't generated yet.
    const src = zone.currentImage || character.sourceCard || character.source;
    return {
    id: `design_${character.id}_${zone.id}`,
    name: `${character.shortName} ${zone.label}`,
    src,
    url: src,
    mediaPath: src,
    provider: zone.updatedAt ? "cloud" : "studio-design",
    tag: "studio",
    characterId: character.id,
    characterName: character.name,
    zoneId: zone.id,
  };
  });
}

function buildZoneContext(character, zone, instruction, referenceImages = [], referenceDescription = "") {
  // Fall back to the source card when this zone has no generated image yet.
  const currentImage = zone.currentImage || character.sourceCard || character.source;
  const references = (Array.isArray(referenceImages) ? referenceImages : []).filter((img) => img?.src || img?.url);
  return [
    `Character: ${character.name} (${character.code})`,
    `Zone: ${zone.id} / ${zone.label}`,
    `Role: ${zone.role}`,
    `Current image: ${currentImage}`,
    references.length ? `Dropped reference images: ${references.map((img) => img.src || img.url).join(" ")}` : "",
    referenceDescription ? `Reference description: ${referenceDescription}` : "",
    `Requested improvement: ${instruction}`,
    `Identity contract: ${character.identityContract.join(" ")}`,
    `Negative prompt: ${character.negativePrompt}`,
  ].filter(Boolean).join("\n");
}

function buildZoneImprovement(character, zone, instruction, referenceImages = [], referenceDescription = "") {
  const references = (Array.isArray(referenceImages) ? referenceImages : []).filter((img) => img?.src || img?.url);
  return [
    `Improve only the "${zone.label}" view (${zone.role}) of ${character.name}.`,
    references.length ? "Use the dropped reference image(s) as the main visual reference for this single zone." : "",
    referenceDescription ? `Reference description: ${referenceDescription}` : "",
    instruction,
    `Keep ${character.name} the same recognizable identity — do not change it into another character.`,
    `Identity contract: ${character.identityContract.join(" ")}`,
    `Negative prompt: ${character.negativePrompt}`,
  ].filter(Boolean).join(" ");
}

function buildZoneBotMessage(character, zone, instruction, referenceImages = [], referenceDescription = "") {
  return [
    `Please improve the "${zone.label}" zone of character ${character.name} (${character.code}).`,
    "",
    buildZoneImprovement(character, zone, instruction, referenceImages, referenceDescription),
    "",
    "Use the source image and any dropped reference image URLs in the context block. Deliver exactly one final image back via the MCP tool described there.",
  ].join("\n");
}

function CharacterSpecRows({ rows }) {
  return (
    <div className="character-spec-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

// ── Review & Save: stitch the generated zones into ONE identity composite ──
function CharacterReview({ character, zones, onClose, onSelectZone, onSave, show }) {
  const [composite, setComposite] = useState("");
  const [stitching, setStitching] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    stitchZonesToSheet(zones, { cols: 3, rows: 3, cell: 512, gap: 14 })
      .then((dataUrl) => { if (!cancelled) { setComposite(dataUrl); setStitching(false); } })
      .catch(() => { if (!cancelled) { setComposite(""); setStitching(false); } });
    return () => { cancelled = true; };
  }, [zones]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = () => {
    if (!composite) return;
    const a = document.createElement("a");
    a.href = composite;
    a.download = `${character.shortName || "character"}-identity.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const saveToLibrary = async () => {
    if (!composite || saving) return;
    setSaving(true);
    try {
      await onSave(composite);
      show("Saved identity to library");
      onClose();
    } catch (error) {
      show(error.message || "Could not save identity");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="character-review-overlay" onClick={onClose}>
      <div className="character-review-card" onClick={(e) => e.stopPropagation()}>
        <header className="character-review-head">
          <div>
            <div className="mono muted">identity composite</div>
            <h2 className="display">{character.name}</h2>
          </div>
          <button type="button" className="zouk-studio-close" onClick={onClose} aria-label="Close review">×</button>
        </header>

        <div className="character-review-composite">
          {stitching
            ? <div className="character-review-loading"><span className="spinner" /><span className="mono muted-2">Stitching identity…</span></div>
            : composite
              ? <img src={composite} alt={`${character.shortName} identity composite`} />
              : <div className="character-review-loading"><span className="mono muted-2">Could not build composite</span></div>}
        </div>

        <div className="character-review-thumbs">
          {zones.map((zone) => (
            <button
              key={zone.id}
              type="button"
              className={"character-review-thumb" + (zone.generated ? "" : " is-empty")}
              title={zone.label}
              onClick={() => { onSelectZone(zone.id); onClose(); }}
            >
              {zone.generated && zone.currentImage
                ? <img src={zone.currentImage} alt={zone.label} />
                : <span className="mono">{zone.label}</span>}
            </button>
          ))}
        </div>

        <div className="character-review-actions">
          <button type="button" className="btn" onClick={download} disabled={!composite}>
            <Icon name="download" size={14} /> Download
          </button>
          <button type="button" className="btn btn-primary" onClick={saveToLibrary} disabled={!composite || saving}>
            {saving ? <span className="spinner" /> : <Icon name="sparkle" size={14} />} Save to library
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function CharacterSourceUploadForm({
  adding,
  description,
  onDescriptionChange,
  onFiles,
  stagedImages = [],
  onRemoveImage,
  onClearImages,
  onStart,
  onError,
  phoneView,
  compact = false,
}) {
  const count = stagedImages.length;
  return (
    <div className={"character-source-upload" + (adding ? " is-busy" : "") + (compact ? " is-compact" : "")}>
      {adding && (
        <div className="character-upload-busy">
          <span className="spinner" />
          <span className="mono muted-2">Starting design…</span>
        </div>
      )}
      <textarea
        className="textarea character-source-description"
        value={description}
        onChange={(event) => onDescriptionChange(event.target.value)}
        placeholder="Describe identity, clothing, pose, style, or details to preserve"
      />
      <DropZone
        compact={compact}
        multiple
        image={null}
        onFile={(image) => onFiles?.([image])}
        onFiles={onFiles}
        allowDrag={!phoneView}
        onError={onError}
        hint={adding ? "Starting…" : phoneView ? "Upload source images" : "Drop source images"}
      />
      {count > 0 && (
        <div className="character-source-drafts">
          {stagedImages.map((image) => (
            <div className="character-source-draft" key={image.id || image.src}>
              <img src={image.src} alt="" />
              <strong>{image.name || "source image"}</strong>
              <button
                type="button"
                className="btn btn-icon"
                title="Remove"
                onClick={() => onRemoveImage?.(image.id)}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="character-source-actions">
        <button className="btn btn-primary" type="button" onClick={onStart} disabled={adding || count === 0}>
          {adding ? <span className="spinner" /> : <Icon name="sparkle" size={14} />} Start design
        </button>
        <button className="btn btn-ghost" type="button" onClick={onClearImages} disabled={adding || count === 0}>
          Clear
        </button>
        <span className="mono muted-2">{count} image{count === 1 ? "" : "s"} staged</span>
      </div>
    </div>
  );
}

export function CharacterDesignPage() {
  const { state, addImage, updateCharacterDesign, removeCharacterDesign } = useStore();
  const { query, navigate } = useHashRoute();
  const { show, node } = useToast();
  const phoneView = usePhoneView();
  const builtInIds = useMemo(() => new Set(CHARACTER_DESIGNS.map((c) => c.id)), []);
  const characters = useMemo(() => listWorkspaceCharacters(state.characterDesigns), [state.characterDesigns]);
  const selectedCharacter = useMemo(
    () => resolveWorkspaceCharacter(state.characterDesigns, query.character),
    [query.character, state.characterDesigns]
  );
  const hasCharacter = Boolean(selectedCharacter);
  const saved = useMemo(
    () => (selectedCharacter ? state.characterDesigns?.[selectedCharacter.id] || {} : {}),
    [selectedCharacter, state.characterDesigns]
  );
  const zones = useMemo(() => mergeCharacterZones(selectedCharacter, saved), [selectedCharacter, saved]);
  const selectedZoneId = query.zone || saved.activeZoneId || zones[0]?.id;
  const activeZone = zones.find((zone) => zone.id === selectedZoneId) || zones[0] || null;
  const [zoneDrafts, setZoneDrafts] = useState({});
  const [replacingZone, setReplacingZone] = useState("");
  const [addingCharacter, setAddingCharacter] = useState(false);
  const [sourceUploadDescription, setSourceUploadDescription] = useState("");
  const [sourceUploadDrafts, setSourceUploadDrafts] = useState([]);
  const [zoneReferenceDescriptions, setZoneReferenceDescriptions] = useState({});
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [runtimeImage, setRuntimeImage] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const activeKey = activeZone ? `${selectedCharacter.id}:${activeZone.id}` : "";
  const activeInstruction = activeZone ? (zoneDrafts[activeKey] ?? activeZone.improvement) : "";
  const activeReferenceDescription = activeZone ? (zoneReferenceDescriptions[activeKey] ?? activeZone.referenceDescription ?? "") : "";
  const uploadMode = query.upload === "1";
  const updatedZones = zones.filter((zone) => zone.updatedAt).length;
  const sheetRequestedAt = Number(saved.sheetRequestedAt || 0);
  const sheetRequestActive = sheetRequestedAt > 0 && now - sheetRequestedAt < CHARACTER_SHEET_WAIT_MS;
  // Still waiting for luna to deliver some zones after a fresh sheet request.
  const awaitingSheet = hasCharacter && sheetRequestActive && updatedZones < zones.length;
  const sheetRequestExpired = hasCharacter && sheetRequestedAt > 0 && !sheetRequestActive && updatedZones < zones.length;

  // Dock the bot chat as a persistent right rail on desktop /design only.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.setAttribute("data-design-rail", "1");
    return () => document.body.removeAttribute("data-design-rail");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/auth/config")
      .then((config) => { if (!cancelled) setRuntimeImage(config.image || null); })
      .catch(() => { if (!cancelled) setRuntimeImage(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeZone?.id || saved.activeZoneId === activeZone.id) return;
    updateCharacterDesign(selectedCharacter.id, { activeZoneId: activeZone.id, meta: saved.meta });
  }, [activeZone?.id, saved.activeZoneId, saved.meta, selectedCharacter?.id, updateCharacterDesign]);

  useEffect(() => {
    if (!hasCharacter || !sheetRequestActive || updatedZones >= zones.length) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [hasCharacter, sheetRequestActive, updatedZones, zones.length]);

  // ── Inbox polling: apply bot deliveries to the matching zone ──
  const seenDeliveriesRef = useRef(new Set());
  const inboxSinceRef = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const data = await fetchJson(`/api/character-design/inbox?since=${inboxSinceRef.current}`);
        if (stopped) return;
        for (const delivery of data.deliveries || []) {
          const id = delivery.id;
          if (!id || seenDeliveriesRef.current.has(id)) continue;
          seenDeliveriesRef.current.add(id);
          const characterId = delivery.character_id;
          if (delivery.kind === "sheet" && delivery.sheet?.url) {
            const sheet = delivery.sheet;
            const grid = sheet.grid || { rows: 3, cols: 3 };
            const zoneList = (sheet.zones || []).map((z, i) => ({ zone_id: z.id || z.zone_id, index: i, row: Math.floor(i / (grid.cols || 3)), col: i % (grid.cols || 3) }));
            if (!state.characterDesigns?.[characterId] || !zoneList.length) continue;
            const sheetSrc = `/api/character-design/sheet-proxy?url=${encodeURIComponent(sheet.url)}`;
            try {
              const crops = await cropSheetToCells(sheetSrc, grid, zoneList);
              const byZone = {};
              for (const crop of crops) {
                const remote = await uploadImageAsset({ src: crop.dataUrl, name: `bot-${crop.zone_id}.jpg` }, "design");
                byZone[crop.zone_id] = { url: remote.src || remote.url, name: remote.name, imageId: remote.id || null, updatedAt: Date.now(), note: "Bot sheet", model: "bot", temporary: Boolean(remote.temporary) };
              }
              updateCharacterDesign(characterId, (current) => ({ meta: { ...(current.meta), generatedSheet: sheet.url }, zones: { ...(current.zones || {}), ...byZone } }));
              show("luna delivered the identity sheet");
            } catch { show("Bot sheet could not be cropped"); }
            continue;
          }
          const zoneId = delivery.zone_id;
          const image = delivery.image || {};
          if (!characterId || !zoneId || !image.url) continue;
          if (!state.characterDesigns?.[characterId]) continue;
          updateCharacterDesign(characterId, (current) => ({
            meta: current.meta,
            activeZoneId: current.activeZoneId || zoneId,
            zones: {
              ...(current.zones || {}),
              [zoneId]: {
                ...(current.zones?.[zoneId] || {}),
                url: image.url,
                name: image.name || `bot ${zoneId}`,
                imageId: image.id || null,
                updatedAt: Date.now(),
                note: "Bot delivery",
                model: "bot",
                temporary: Boolean(image.temporary),
                botRequestedAt: null,
              },
            },
          }));
          show(`${zoneId.replace(/_/g, " ")} updated by bot`);
        }
        if (typeof data.now === "number") inboxSinceRef.current = data.now;
      } catch {
        // Inbox is best-effort; keep polling.
      }
      if (!stopped) timer = setTimeout(poll, 4000);
    };
    poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [show, state.characterDesigns, updateCharacterDesign]);

  const selectCharacter = (characterId) => {
    const character = resolveWorkspaceCharacter(state.characterDesigns, characterId);
    if (!character) return;
    const characterSaved = state.characterDesigns?.[character.id] || {};
    navigate("/design", {
      character: character.id,
      zone: characterSaved.activeZoneId || character.zones[0]?.id,
      ...(uploadMode ? { upload: "1" } : {}),
    });
  };

  const selectZone = (zoneId) => {
    updateCharacterDesign(selectedCharacter.id, { activeZoneId: zoneId, meta: saved.meta });
    navigate("/design", { character: selectedCharacter.id, zone: zoneId });
  };

  // ── Generate via luna: mint a sheet claim, dispatch compose with MCP delivery info ──
  const runSheetGeneration = async (character, savedMeta) => {
    const sourceUrl = savedMeta?.meta?.source || character.source || character.sourceCard;
    if (!sourceUrl || !/^https?:\/\//i.test(String(sourceUrl))) { show("Upload a source image first"); return; }
    const sourceReferences = (Array.isArray(savedMeta?.meta?.sourceImages) && savedMeta.meta.sourceImages.length
      ? savedMeta.meta.sourceImages
      : [{ src: sourceUrl, url: sourceUrl, name: savedMeta?.meta?.sourceImageName || "source image" }])
      .filter((image) => image?.src || image?.url)
      .map((image) => ({ ...image, src: image.src || image.url, url: image.url || image.src }));
    const charZones = mergeCharacterZones(character, savedMeta);
    const zonesPayload = charZones.map((z) => ({ id: z.id, label: z.label, prompt: z.prompt || z.improvement || z.role }));
    try {
      const claim = await fetchJson("/api/character-design/claim", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          character_id: character.id,
          character_name: character.name,
          kind: "sheet",
          label: character.shortName,
          source_image_url: sourceUrl,
          identity_contract: character.identityContract,
          negative_prompt: character.negativePrompt,
          zones: zonesPayload,
          grid: { rows: 3, cols: 3 },
        }) });
      const description = savedMeta?.meta?.sourceDescription ? ` Description: ${savedMeta.meta.sourceDescription}` : "";
      const referenceText = sourceReferences.length > 1
        ? ` Use all ${sourceReferences.length} source images together as one unified character reference set.`
        : "";
      const improvement = `Build ${character.name}'s full 9-zone identity set from the reference. Keep one consistent identity across all views.${referenceText}${description}`;
      const message = `@luna please generate ${character.name}'s character identity views from the reference image, then deliver them back to Studio.`;
      updateCharacterDesign(character.id, (current) => ({ meta: current.meta || savedMeta?.meta, sheetRequestedAt: Date.now() }));
      window.dispatchEvent(new CustomEvent("studio:zouk-compose", { detail: {
        message, autoSend: true,
        sourceUrl: characterDesignDeepLink(character.id, charZones[0]?.id),
        sourceImage: sourceUrl, improvement,
        referenceImages: sourceReferences,
        mcp: {
          endpoint: claim.mcp_url,
          token: claim.token,
          tool: "deliver_character_sheet",
          kind: "sheet",
          zones: zonesPayload,
          grid: { rows: 3, cols: 3 },
          referenceImages: sourceReferences.map((image) => image.src || image.url),
        },
      } }));
      show(`Sent ${character.shortName} to luna`);
      return true;
    } catch (error) {
      show(error.message || "Could not reach the bot");
      return false;
    }
  };

  const stageSourceUploads = async (images) => {
    const additions = (Array.isArray(images) ? images : [images])
      .filter(Boolean)
      .map((image, index) => ({
        ...image,
        id: `draft_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      }));
    if (!additions.length) return;
    setSourceUploadDrafts((current) => [...current, ...additions]);
    show(`${additions.length} source image${additions.length === 1 ? "" : "s"} staged`);
  };

  const removeSourceDraft = (id) => {
    setSourceUploadDrafts((current) => current.filter((image) => image.id !== id));
  };

  const createCharacterFromStagedSources = async () => {
    if (addingCharacter) return;
    const queue = sourceUploadDrafts.filter(Boolean);
    if (!queue.length) return;
    setAddingCharacter(true);
    try {
      const description = sourceUploadDescription.trim();
      const sources = [];
      for (const [index, img] of queue.entries()) {
        const remote = await uploadImageAsset({
          ...img,
          name: `character-source-${index + 1}-${img.name || "reference.png"}`,
        }, "design");
        sources.push(addImage({
          ...remote,
          name: img.name || `Source image ${index + 1}`,
          provider: remote.provider || "cloud",
          tag: remote.tag || "design",
        }));
      }
      const primary = sources[0];
      const displayName = primary.name || "Character reference";
      const meta = makeUploadedCharacterMeta(displayName, primary);
      meta.sourceImages = sources.map((source) => ({
        id: source.id || source.src,
        name: source.name,
        src: source.src,
        url: source.url || source.src,
        tag: source.tag || "design",
        provider: source.provider || "cloud",
      }));
      meta.sourceImageName = sources.map((source) => source.name).filter(Boolean).join(", ") || meta.sourceImageName;
      meta.spec = [
        ...(meta.spec || []),
        ["Reference set", `${sources.length} source image${sources.length === 1 ? "" : "s"}`],
      ];
      meta.identityContract = [
        ...(meta.identityContract || []),
        `Use all ${sources.length} uploaded source image${sources.length === 1 ? "" : "s"} as one unified character reference set.`,
      ];
      if (description) {
        meta.sourceDescription = description;
        meta.spec = [...(meta.spec || []), ["Description", description]];
        meta.identityContract = [...(meta.identityContract || []), `User description: ${description}`];
      }
      updateCharacterDesign(meta.id, { meta, activeZoneId: "full_front", zones: {} });
      const builtCharacter = characterFromMeta(meta);
      const sent = await runSheetGeneration(builtCharacter, { meta, zones: {} });
      if (!sent) return;
      setSourceUploadDescription("");
      setSourceUploadDrafts([]);
      navigate("/design", { character: meta.id, zone: "full_front" });
    } catch (error) {
      show(error.message || "Character upload failed");
    } finally {
      setAddingCharacter(false);
    }
  };

  const requestZoneFromLuna = async ({
    zone = activeZone,
    instruction = activeInstruction,
    references = zone?.referenceImages || [],
    description = activeReferenceDescription,
  } = {}) => {
    if (!zone) return;
    const referenceImages = (Array.isArray(references) ? references : [references])
      .filter((img) => img?.src || img?.url)
      .map((img) => ({ ...img, src: img.src || img.url, url: img.url || img.src }));
    const sourceImage = referenceImages[0]?.src || zone.currentImage || selectedCharacter.sourceCard || selectedCharacter.source;
    const improvement = buildZoneImprovement(selectedCharacter, zone, instruction, referenceImages, description);
    const message = buildZoneBotMessage(selectedCharacter, zone, instruction, referenceImages, description);
    const referencedText = buildZoneContext(selectedCharacter, zone, instruction, referenceImages, description);
    try {
      const claim = await fetchJson("/api/character-design/claim", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          character_id: selectedCharacter.id,
          character_name: selectedCharacter.name,
          zone_id: zone.id,
          label: zone.label,
          source_image_url: sourceImage,
          identity_contract: selectedCharacter.identityContract,
          negative_prompt: selectedCharacter.negativePrompt,
        }),
      });
      updateCharacterDesign(selectedCharacter.id, (current) => ({
        meta: current.meta || saved.meta,
        activeZoneId: zone.id,
        zones: {
          ...(current.zones || {}),
          [zone.id]: {
            ...(current.zones?.[zone.id] || {}),
            botRequestedAt: Date.now(),
            lastBotPrompt: instruction,
            referenceImages,
            referenceDescription: description,
          },
        },
      }));
      window.dispatchEvent(new CustomEvent("studio:zouk-compose", {
        detail: {
          message,
          referencedText,
          sourceUrl: characterDesignDeepLink(selectedCharacter.id, zone.id),
          autoSend: true,
          sourceImage,
          referenceImages,
          improvement,
          mcp: {
            endpoint: claim.mcp_url,
            token: claim.token,
            tool: claim.tool,
            characterId: selectedCharacter.id,
            zoneId: zone.id,
            characterName: selectedCharacter.name,
            zoneLabel: zone.label,
            referenceImages,
          },
        },
      }));
      show(`Sent ${zone.label} to luna`);
    } catch (error) {
      show(error.message || "Could not reach luna");
    }
  };

  const replaceZoneImages = async (images) => {
    if (!activeZone || replacingZone) return;
    const queue = (Array.isArray(images) ? images : [images]).filter(Boolean);
    if (!queue.length) return;
    setReplacingZone(activeKey);
    try {
      const references = [];
      for (const img of queue) {
        const remote = await uploadImageAsset({
          ...img,
          name: `${selectedCharacter.shortName}-${activeZone.id}-${img.name || "zone.png"}`,
        }, "design");
        const item = addImage({
          ...remote,
          name: `${selectedCharacter.shortName} ${activeZone.label} reference`,
          provider: remote.provider || "cloud",
          tag: remote.tag || "design",
          characterId: selectedCharacter.id,
          characterName: selectedCharacter.name,
          zoneId: activeZone.id,
        });
        references.push(item);
      }
      updateCharacterDesign(selectedCharacter.id, (current) => ({
        meta: current.meta || saved.meta,
        activeZoneId: activeZone.id,
        zones: {
          ...(current.zones || {}),
          [activeZone.id]: {
            ...(current.zones?.[activeZone.id] || {}),
            referenceImages: references,
            referenceDescription: activeReferenceDescription,
            note: "Reference upload",
            lastBotPrompt: activeInstruction,
            botRequestedAt: Date.now(),
          },
        },
      }));
      await requestZoneFromLuna({
        zone: activeZone,
        instruction: activeInstruction,
        references,
        description: activeReferenceDescription,
      });
    } catch (error) {
      show(error.message || "Zone upload failed");
    } finally {
      setReplacingZone("");
    }
  };

  const replaceZoneImage = async (img) => replaceZoneImages([img]);

  const improveWithLuna = async () => {
    await requestZoneFromLuna({
      references: activeZone?.referenceImages || [],
      description: activeReferenceDescription,
    });
  };

  const openUploadFlow = () => {
    navigate("/design", { character: selectedCharacter.id, zone: activeZone?.id, upload: "1" });
  };

  const closeUploadFlow = () => {
    navigate("/design", { character: selectedCharacter.id, zone: activeZone?.id || saved.activeZoneId || "full_front" });
  };

  // ── Add the rename + review-save handlers ──
  const startRename = () => {
    if (!selectedCharacter) return;
    setRenameDraft(selectedCharacter.name);
    setRenaming(true);
  };

  const commitRename = () => {
    if (!selectedCharacter) { setRenaming(false); return; }
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === selectedCharacter.name) return;
    updateCharacterDesign(selectedCharacter.id, (current) => ({
      meta: { ...(current.meta || saved.meta), name: next || current.meta?.name },
    }));
    show("Character renamed");
  };

  const RosterStrip = (
    <div className="character-roster-list">
      {characters.map((character) => {
        const characterSaved = state.characterDesigns?.[character.id] || {};
        const primary = characterReferenceItems(character, characterSaved)[0];
        const count = mergeCharacterZones(character, characterSaved).filter((zone) => zone.updatedAt).length;
        const isCustom = !builtInIds.has(character.id);
        return (
          <div
            key={character.id}
            role="button"
            tabIndex={0}
            className={"character-roster-card" + (hasCharacter && character.id === selectedCharacter.id ? " active" : "")}
            onClick={() => selectCharacter(character.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCharacter(character.id); } }}
          >
            <img src={primary?.src || character.sourceCard} alt="" />
            <strong>{character.shortName}</strong>
            <em>{count} zones</em>
            {isCustom && (
              <button
                type="button"
                className="character-roster-del"
                title={`Delete ${character.shortName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!window.confirm(`Delete ${character.shortName}? This removes the character and its zone overrides.`)) return;
                  removeCharacterDesign(character.id);
                  if (hasCharacter && character.id === selectedCharacter.id) navigate("/design", {});
                  show(`${character.shortName} deleted`);
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  // ── Empty state: no characters yet ──
  if (!hasCharacter) {
    return (
      <div className="page-shell character-design-page is-empty">
        {node}
        <div className="character-empty">
          <div className="mono muted">character design</div>
          <h1 className="display">Create your first character</h1>
          <p>Drop a clean reference image and luna builds a uniform set of nine reusable identity zones.</p>
          <CharacterSourceUploadForm
            adding={addingCharacter}
            description={sourceUploadDescription}
            onDescriptionChange={setSourceUploadDescription}
            onFiles={stageSourceUploads}
            stagedImages={sourceUploadDrafts}
            onRemoveImage={removeSourceDraft}
            onClearImages={() => setSourceUploadDrafts([])}
            onStart={createCharacterFromStagedSources}
            phoneView={phoneView}
            onError={(error) => show(error.message || "Image upload failed")}
          />
        </div>
      </div>
    );
  }

  if (uploadMode) {
    return (
      <div className="page-shell character-design-page character-upload-page">
        {node}
        <header className="character-upload-head">
          <button className="btn btn-ghost" type="button" onClick={closeUploadFlow}>
            <Icon name="arrowLeft" size={14} /> Back
          </button>
          <div>
            <div className="mono muted">character design</div>
            <h1 className="display">Upload profiles</h1>
          </div>
        </header>

        <div className="character-upload-layout">
          <aside className="character-upload-sidebar surface">
            <div className="character-upload-sidebar-head">
              <span className="label">Profiles</span>
              <span className="mono muted-2">{characters.length}</span>
            </div>
            {RosterStrip}
          </aside>

          <section className="character-upload-main surface">
            <div className="character-upload-copy">
              <span className="mono muted">source upload</span>
              <h2 className="display">Add one or more source images</h2>
            </div>
            <CharacterSourceUploadForm
              adding={addingCharacter}
              description={sourceUploadDescription}
              onDescriptionChange={setSourceUploadDescription}
              onFiles={stageSourceUploads}
              stagedImages={sourceUploadDrafts}
              onRemoveImage={removeSourceDraft}
              onClearImages={() => setSourceUploadDrafts([])}
              onStart={createCharacterFromStagedSources}
              phoneView={phoneView}
              onError={(error) => show(error.message || "Image upload failed")}
            />
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell character-design-page">
      {node}
      {reviewOpen && (
        <CharacterReview
          character={selectedCharacter}
          zones={zones}
          show={show}
          onClose={() => setReviewOpen(false)}
          onSelectZone={(zoneId) => selectZone(zoneId)}
          onSave={async (dataUrl) => {
            const remote = await uploadImageAsset({ src: dataUrl, name: `${selectedCharacter.shortName}-identity.jpg` }, "design");
            addImage({
              ...remote,
              name: `${selectedCharacter.shortName} identity`,
              provider: remote.provider || "cloud",
              tag: remote.tag || "design",
              characterId: selectedCharacter.id,
              characterName: selectedCharacter.name,
            });
          }}
        />
      )}
      <header className="character-design-bar">
        <div className="character-design-headline">
          <div className="mono muted">character design</div>
          {renaming ? (
            <input
              className="input character-name-edit"
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); commitRename(); }
                else if (event.key === "Escape") { event.preventDefault(); setRenaming(false); }
              }}
            />
          ) : (
            <h1 className="display character-name-title" onClick={startRename} title="Rename character" role="button" tabIndex={0}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); startRename(); } }}>
              <span>{selectedCharacter.name}</span>
              <svg className="character-name-pencil" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path d="M4 20h4l10-10-4-4L4 16v4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </h1>
          )}
          <div className="character-design-stats">
            <span>{selectedCharacter.code}</span>
            <span>{zones.length} zones</span>
            <span>{updatedZones} generated</span>
            <span>{runtimeImage?.uploadConfigured ? "cloud ready" : "cloud missing"}</span>
          </div>
        </div>
        <div className="character-design-new">
          <button className="btn btn-primary character-design-upload-btn" type="button" onClick={openUploadFlow}>
            <Icon name="upload" size={14} /> Upload profiles
          </button>
        </div>
      </header>

      <div className="character-design-layout">
        <aside className="character-design-sidebar surface">
          <div className="character-upload-sidebar-head">
            <span className="label">Profiles</span>
            <span className="mono muted-2">{characters.length}</span>
          </div>
          {RosterStrip}
        </aside>

        <section className="character-zone-board">
          <div className="character-zone-toolbar">
            <div className="character-zone-toolbar-title">
              <h2 className="display">Identity zones</h2>
              <span className="mono muted-2">{String(zones.length).padStart(2, "0")}</span>
            </div>
            <div className="character-zone-generate-actions">
              {updatedZones > 0 && (
                <button
                  className="btn character-zone-review"
                  onClick={() => setReviewOpen(true)}
                >
                  <Icon name="grid" size={14} /> Review &amp; Save
                </button>
              )}
              <button
                className={"btn btn-primary character-zone-generate" + (awaitingSheet ? " is-awaiting" : "")}
                onClick={() => runSheetGeneration(selectedCharacter, saved)}
                disabled={awaitingSheet}
              >
                {awaitingSheet
                  ? <><span className="spinner" /> Sent to luna…</>
                  : sheetRequestExpired
                    ? <><Icon name="refresh" size={14} /> Retry with luna</>
                  : <><Icon name="sparkle" size={14} /> Generate with luna</>}
              </button>
            </div>
          </div>
          <div className="character-zone-grid">
            {zones.map((zone) => {
              const loading = !zone.generated && awaitingSheet;
              const empty = !zone.generated && !awaitingSheet;
              return (
                <button
                  key={zone.id}
                  className={"character-zone-card"
                    + (zone.id === activeZone.id ? " active" : "")
                    + (loading ? " is-loading" : "")
                    + (empty ? " is-empty" : "")}
                  onClick={() => selectZone(zone.id)}
                >
                  <div className="character-zone-img">
                    {zone.generated ? (
                      <img src={zone.currentImage} alt={`${selectedCharacter.shortName} ${zone.label}`} />
                    ) : loading ? (
                      <>
                        <span className="character-zone-shimmer" />
                        <span className="character-zone-spinner spinner" />
                        <span className="character-zone-loading-label mono">{zone.label}</span>
                      </>
                    ) : (
                      <span className="character-zone-empty">
                        <Icon name="sparkle" size={18} />
                        <em className="mono">not generated</em>
                      </span>
                    )}
                  </div>
                  <div className="character-zone-meta">
                    <strong>{zone.label}</strong>
                    <em className={zone.generated ? "is-set" : ""}>{zone.generated ? "set" : loading ? "…" : "empty"}</em>
                  </div>
                </button>
              );
            })}
          </div>

          <details className="character-dossier-fold">
            <summary>
              <span className="label">Identity dossier</span>
              <span className="mono muted-2">{selectedCharacter.code}</span>
            </summary>
            <div className="character-dossier-body">
              <div className="character-source">
                <img src={selectedCharacter.sourceCard} alt={`${selectedCharacter.shortName} source`} />
              </div>
              <div className="character-dossier-cols">
                <CharacterSpecRows rows={selectedCharacter.spec} />
                <div className="character-contract">
                  {selectedCharacter.identityContract.map((line) => <p key={line}>{line}</p>)}
                </div>
              </div>
            </div>
          </details>
        </section>

        <aside className="character-bot-panel surface">
          <div className={"character-bot-preview" + (activeZone.generated ? "" : (awaitingSheet ? " is-loading" : " is-empty"))}>
            {activeZone.generated ? (
              <img src={activeZone.currentImage} alt={`${activeZone.label} selected`} />
            ) : awaitingSheet ? (
              <span className="character-bot-preview-state">
                <span className="spinner" />
                <span className="mono muted-2">Waiting for luna…</span>
              </span>
            ) : (
              <span className="character-bot-preview-state">
                <Icon name="sparkle" size={20} />
                <span className="mono muted-2">Not generated</span>
              </span>
            )}
          </div>
          <div>
            <div className="character-zone-kicker mono">{activeZone.id}</div>
            <h2 className="display">{activeZone.label}</h2>
            <p className="character-zone-role">{activeZone.role}</p>
          </div>

          <div>
            <label className="label">Zone improvement request</label>
            <textarea
              className="textarea character-bot-textarea"
              value={activeInstruction}
              onChange={(e) => setZoneDrafts((drafts) => ({ ...drafts, [activeKey]: e.target.value }))}
            />
          </div>

          <div className="character-model-actions">
            <button className="btn btn-primary" onClick={improveWithLuna} disabled={Boolean(replacingZone)}>
              <Icon name="sparkle" size={14} /> Improve with luna
            </button>
          </div>

          <div>
            <label className="label">Reference description</label>
            <textarea
              className="textarea character-bot-textarea"
              value={activeReferenceDescription}
              onChange={(e) => setZoneReferenceDescriptions((drafts) => ({ ...drafts, [activeKey]: e.target.value }))}
              placeholder="Describe what these references should change or preserve"
            />
          </div>

          <div>
            <label className="label">{replacingZone === activeKey ? "Uploading" : "Reference upload"}</label>
            <DropZone
              compact
              multiple
              image={null}
              onFile={replaceZoneImage}
              onFiles={replaceZoneImages}
              allowDrag={!phoneView}
              onError={(error) => show(error.message || "Image upload failed")}
              hint={replacingZone === activeKey ? "Uploading zone" : phoneView ? `Upload ${activeZone.label} refs` : `Drop ${activeZone.label} refs`}
            />
          </div>

          {activeZone.botRequestedAt && (
            <div className="character-bot-status">
              <span>bot</span>
              <strong>{relTime(activeZone.botRequestedAt)}</strong>
            </div>
          )}

          {activeZone.referenceImages?.length > 0 && (
            <div className="character-bot-status">
              <span>refs</span>
              <strong>{activeZone.referenceImages.length} image{activeZone.referenceImages.length > 1 ? "s" : ""}</strong>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function VideoCard({ v, onClick, onTemplate, onDelete }) {
  const active = isActiveTask(v.status);
  const badge = taskBadgeText(v);

  return (
    <article className="video-card" onClick={onClick}>
      <div className="video-thumb">
        {v.thumb
          ? <img src={v.thumb} alt="" loading="lazy"/>
          : <div className={"video-thumb-placeholder" + (active ? " active" : "")}>
              {active && <span className="spinner" />}
            </div>}
        <div className="play"><div className={"play-ic" + (active ? " play-ic-active" : "")}><Icon name={active ? "refresh" : "play"} size={16}/></div></div>
        <div className="video-badge">{badge}</div>
        <div className="video-runtime">{taskRuntimeText(v)}</div>
      </div>
      <div className="video-meta">
        <h3 className="video-title">{v.title}</h3>
        <div className="video-sub">
          <span>{v.aspect}</span>
          <span>·</span>
          <span>{relTime(v.createdAt)}</span>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: "5px 9px" }}
            onClick={(e) => { e.stopPropagation(); onTemplate(); }}>
            <Icon name="copy" size={11}/> Use as template
          </button>
          {onDelete && (
            <button className="btn btn-ghost" style={{ fontSize: 11, padding: "5px 9px" }}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="Delete">
              <Icon name="trash" size={11}/> Delete
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function HomePage() {
  const { state, removeVideo } = useStore();
  const { navigate } = useHashRoute();
  const { show, node } = useToast();
  const videos = useMemo(() => [...state.videos].sort(taskSort), [state.videos]);
  const activeVideos = videos.filter((v) => isActiveTask(v.status));
  const readyVideos = videos.filter((v) => !isActiveTask(v.status));

  const applyTemplate = (v) => {
    navigate("/create", { from: v.id });
  };

  const deleteVideo = async (v) => {
    try {
      await deleteRemoteTask(v);
      removeVideo(v.id);
      show("Video removed");
    } catch (error) {
      show(error.message || "Failed to delete task");
    }
  };

  return (
    <div>
      {node}
      <section className="home-actions">
        <button className="btn btn-primary btn-lg" onClick={() => navigate("/create")}>
          <Icon name="plus" size={14}/> Add
        </button>
      </section>

      <section className="page-section compact">
        <SectionHeader title="Running" count={activeVideos.length} />
        {activeVideos.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
            {activeVideos.map((v) => (
              <VideoCard
                key={v.id}
                v={v}
                onClick={() => navigate("/preview", { id: v.id })}
                onTemplate={() => applyTemplate(v)}
                onDelete={() => deleteVideo(v)}
              />
            ))}
          </div>
        ) : (
          <div className="queue-empty">No running</div>
        )}
      </section>

      <section className="page-section">
        <SectionHeader title="Done" count={readyVideos.length} />
        {readyVideos.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
            {readyVideos.map((v) => (
              <VideoCard
                key={v.id}
                v={v}
                onClick={() => navigate("/preview", { id: v.id })}
                onTemplate={() => applyTemplate(v)}
                onDelete={() => deleteVideo(v)}
              />
            ))}
          </div>
        ) : (
          <div className="queue-empty">No done</div>
        )}
      </section>
    </div>
  );
}

function ParamRow({ label, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function DurationSlider({ value, onChange, min, max }) {
  const ticks = [];
  for (let i = min; i <= max; i++) ticks.push(i);
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div style={{ position: "relative", padding: "10px 0 6px" }}>
        <div style={{ position: "relative", height: 4, background: "var(--bg-3)", borderRadius: 2, border: "1px solid var(--line)" }}>
          <div style={{ position: "absolute", inset: 0, width: pct + "%", background: "var(--accent)", borderRadius: 2 }}/>
        </div>
        <input type="range" min={min} max={max} step={1} value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          style={{
            position: "absolute", left: 0, right: 0, top: 6, width: "100%",
            opacity: 0, height: 20, cursor: "pointer", margin: 0,
          }}/>
        <div style={{
          position: "absolute", left: `clamp(8px, ${pct}%, calc(100% - 8px))`, top: 4,
          width: 16, height: 16, borderRadius: "50%", background: "var(--fg)",
          border: "3px solid var(--accent)", pointerEvents: "none",
          boxShadow: "0 1px 4px rgba(0,0,0,.3)", transform: "translateX(-50%)",
        }}/>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        {ticks.map((t) => (
          <span key={t} className="mono" style={{
            fontSize: 9.5, color: t === value ? "var(--accent)" : "var(--fg-3)",
            letterSpacing: ".05em", fontWeight: t === value ? 600 : 400,
          }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function usePhoneView() {
  const [phone, setPhone] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches
  ));

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return phone;
}

function SelectedImagePreview({ image, label, onClear }) {
  if (!image) return null;
  return (
    <div className="selected-image-preview">
      <img src={image.src} alt="" />
      <div className="selected-image-meta">
        <span className="mono">{label}</span>
        <strong>{image.name || "image"}</strong>
      </div>
      <button className="btn btn-icon" onClick={onClear} title="Remove">
        <Icon name="x" size={13}/>
      </button>
    </div>
  );
}

export function CreatePage() {
  const { state, addImage, updateImage, addVideo } = useStore();
  const route = useHashRoute();
  const { navigate, query } = route;
  const phoneView = usePhoneView();

  const tmpl = useMemo(() => state.videos.find((v) => v.id === query.from), [query.from, state.videos]);
  const imageFromRoute = useMemo(() => state.images.find((img) => img.id === query.fromImage), [query.fromImage, state.images]);
  const imagesFromRoute = useMemo(() => (
    String(query.fromImages || "")
      .split(",")
      .map((id) => state.images.find((img) => img.id === id))
      .filter(Boolean)
  ), [query.fromImages, state.images]);
  const imageFromUrl = useCallback((src, name = "template image") => {
    if (!src) return null;
    const found = state.images.find((img) => [img.src, img.url, img.mediaPath, img.media_path].filter(Boolean).includes(src));
    if (found) return found;
    return {
      id: `template_${src.replace(/[^a-zA-Z0-9]+/g, "_").slice(-48)}`,
      name,
      src,
      url: src,
      mediaPath: src,
      cloud: true,
      addedAt: Date.now(),
    };
  }, [state.images]);
  const templateFirstFrame = useMemo(() => (
    tmpl?.mode === "i2v" ? imageFromRoute || imageFromUrl(tmpl.referenceImageUrl, "template first frame") : null
  ), [imageFromRoute, imageFromUrl, tmpl]);
  const templateLastFrame = useMemo(() => (
    tmpl?.mode === "i2v" ? imageFromUrl(tmpl.lastFrameUrl, "template last frame") : null
  ), [imageFromUrl, tmpl]);
  const templateReferenceImages = useMemo(() => {
    if (imagesFromRoute.length) return imagesFromRoute;
    if (imageFromRoute) return [imageFromRoute];
    if (tmpl?.mode !== "ref2v") return [];
    return Array.from(new Set([
      ...(Array.isArray(tmpl.characterReferenceUrls) ? tmpl.characterReferenceUrls : []),
      tmpl.characterReferenceUrl,
    ].filter(Boolean)))
      .map((src, index) => imageFromUrl(src, `template reference ${index + 1}`))
      .filter(Boolean);
  }, [imageFromRoute, imageFromUrl, imagesFromRoute, tmpl]);
  const model = "seedance-pro";
  const designCharacters = useMemo(() => listWorkspaceCharacters(state.characterDesigns), [state.characterDesigns]);

  const [prompt, setPrompt] = useState(tmpl ? tmpl.prompt : "");
  const [resolution, setResolution] = useState(tmpl ? tmpl.resolution : "1080p");
  const [aspect, setAspect] = useState(tmpl ? tmpl.aspect : "9:16");
  const [duration, setDuration] = useState(tmpl ? tmpl.duration : 15);
  const [camera, setCamera] = useState(tmpl ? tmpl.camera : "dynamic");
  const [seed, setSeed] = useState(() => (tmpl ? tmpl.seed : Math.floor(Math.random() * 99999)));
  const [image, setImage] = useState(templateFirstFrame);
  const [lastFrame, setLastFrame] = useState(templateLastFrame);
  const [referenceImages, setReferenceImages] = useState(templateReferenceImages);
  const [referenceAudioText, setReferenceAudioText] = useState(() => (tmpl?.referenceAudioUrls || []).join("\n"));
  const [generateAudio, setGenerateAudio] = useState(tmpl ? tmpl.generateAudio !== false : true);
  const [inputMode, setInputMode] = useState(() => tmpl?.mode === "i2v" ? "frames" : "references");
  const mode = inputMode === "frames" && image
    ? "i2v"
    : inputMode === "references" && referenceImages.length
      ? "ref2v"
      : "t2v";

  const [submitting, setSubmitting] = useState(false);
  const [pendingImageUploads, setPendingImageUploads] = useState(0);
  const { show, node } = useToast();

  const toStoredImage = async (img) => {
    const remote = await uploadImageAsset(img);
    if (img.id) {
      const patch = {
        ...remote,
        id: img.id,
        addedAt: img.addedAt || remote.addedAt,
      };
      updateImage(img.id, patch);
      return { ...img, ...patch };
    }
    return addImage(remote);
  };

  const trackImageUpload = async (work) => {
    setPendingImageUploads((count) => count + 1);
    try {
      await work();
    } catch (error) {
      show(error.message || "Image upload failed");
      throw error;
    } finally {
      setPendingImageUploads((count) => Math.max(0, count - 1));
    }
  };

  const onPickFile = (img) => {
    return trackImageUpload(async () => {
      const item = await toStoredImage(img);
      setImage(item);
    });
  };

  const onPickLastFrame = (img) => {
    return trackImageUpload(async () => {
      const item = await toStoredImage(img);
      setLastFrame(item);
    });
  };

  const onPickReference = (img) => {
    return trackImageUpload(async () => {
      const item = await toStoredImage(img);
      setReferenceImages((items) => items.some((x) => x.id === item.id || x.src === item.src) ? items : [...items, item].slice(0, 6));
    });
  };

  const addReferenceItems = useCallback((refs) => {
    const incoming = (Array.isArray(refs) ? refs : []).filter((ref) => ref?.src || ref?.url);
    if (!incoming.length) return 0;
    const currentKeys = new Set(referenceImages.map((img) => img.id || img.src || img.url).filter(Boolean));
    const additions = [];
    for (const ref of incoming) {
      const key = ref.id || ref.src || ref.url;
      if (!key || currentKeys.has(key)) continue;
      currentKeys.add(key);
      additions.push({
        ...ref,
        src: ref.src || ref.url,
        url: ref.url || ref.src,
        mediaPath: ref.mediaPath || ref.media_path || ref.url || ref.src,
        addedAt: ref.addedAt || Date.now(),
      });
      if (referenceImages.length + additions.length >= 6) break;
    }
    if (!additions.length) return 0;
    setReferenceImages((items) => {
      const next = [...items];
      const seen = new Set(items.map((img) => img.id || img.src || img.url).filter(Boolean));
      for (const ref of additions) {
        const key = ref.id || ref.src || ref.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(ref);
        if (next.length >= 6) break;
      }
      return next;
    });
    return additions.length;
  }, [referenceImages]);

  const addDesignCharacterReferences = (character) => {
    const saved = state.characterDesigns?.[character.id] || {};
    const refs = characterReferenceItems(character, saved);
    const added = addReferenceItems(refs);
    show(added ? `${character.shortName} references added` : `${character.shortName} already selected`);
  };

  const libraryStrip = (onSelect, selected = []) => {
    const selectedIds = new Set(selected.filter(Boolean).map((img) => img.id || img.src));
    const items = state.images.slice(0, 10);
    if (!items.length) return null;
    return (
      <div style={{ marginTop: 14 }}>
        <div className="mono muted-2" style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 8 }}>
          Reuse from library
        </div>
        <div className="scroll-x" style={{ display: "flex", gap: 8, paddingBottom: 4 }}>
          {items.map((img) => {
            const selectedAlready = selectedIds.has(img.id || img.src);
            return (
            <button key={img.id}
              disabled={selectedAlready}
              onClick={() => !selectedAlready && onSelect(img)}
              title={selectedAlready ? "Selected" : img.name}
              style={{
                width: 64, height: 64, padding: 0,
                border: "1px solid var(--line)", borderRadius: "var(--radius)",
                background: "transparent", overflow: "hidden", flexShrink: 0,
                cursor: selectedAlready ? "default" : "pointer",
                opacity: selectedAlready ? .36 : 1,
                filter: selectedAlready ? "grayscale(1)" : "none",
              }}>
              <img src={img.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
            </button>
            );
          })}
        </div>
      </div>
    );
  };

  const startGen = async () => {
    if (submitting) return;
    if (pendingImageUploads > 0) { show("Wait for image upload to finish"); return; }
    if (!prompt.trim()) { show("Write a prompt to generate"); return; }
    if (inputMode === "frames" && lastFrame && !image) { show("Add a first frame before using a last frame"); return; }
    if (inputMode === "references" && referenceImages.length === 0) { show("Add at least one reference image"); return; }
    setSubmitting(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const imageSrc = inputMode === "frames" ? image?.src : null;
      const lastFrameSrc = inputMode === "frames" ? lastFrame?.src : null;
      const referenceImageUrls = inputMode === "references" ? referenceImages.map((img) => img.src) : [];
      const referenceAudioUrls = inputMode === "references"
        ? referenceAudioText.split(/[\n,]+/).map((url) => url.trim()).filter(Boolean)
        : [];
      const task = await fetchJson("/api/generate", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          image_url: imageSrc,
          image_role: imageSrc ? "scene_first_frame" : undefined,
          last_frame_image_url: lastFrameSrc,
          reference_image_urls: referenceImageUrls.length ? referenceImageUrls : undefined,
          reference_audio_urls: referenceAudioUrls.length ? referenceAudioUrls : undefined,
          generate_audio: generateAudio,
          image_id: inputMode === "frames" ? image?.id : undefined,
          model,
          resolution,
          aspect,
          duration,
          camera,
          seed,
        }),
      });
      const v = addVideo(videoPatchFromTask(task, {
        id: task.id,
        referenceImageUrl: imageSrc || null,
        lastFrameUrl: lastFrameSrc || null,
        characterReferenceUrls: referenceImageUrls,
        referenceAudioUrls,
        generateAudio,
        imageId: inputMode === "frames" ? image?.id : undefined,
      }));
      navigate("/preview", { id: v.id });
    } catch (error) {
      setSubmitting(false);
      show(error.name === "AbortError" ? "Submit timed out. Try a smaller image or retry." : error.message || "Failed to submit task");
    } finally {
      clearTimeout(timeout);
    }
  };

  return (
    <div className="page-shell create-page">
      {node}
      <header className="create-header">
        <div>
          <div className="mono muted" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 6 }}>
            Bay 02 / New take
          </div>
          <h1 className="display create-title">
            {tmpl ? "Remix" : "New generation"}
          </h1>
          {tmpl && (
            <div className="mono muted-2" style={{ fontSize: 11, letterSpacing: ".12em", marginTop: 8, textTransform: "uppercase" }}>
              Forked from &laquo;{tmpl.title}&raquo;
            </div>
          )}
        </div>
        <button className="btn btn-ghost" onClick={() => navigate("/")}>
          <Icon name="arrowLeft" size={14}/> Cancel
        </button>
      </header>

      <div className="create-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div>
            <label className="label">Input mode</label>
            <div className="seg" style={{ marginBottom: 16 }}>
              {INPUT_MODES.map((option) => (
                <button key={option.id}
                  className={"seg-opt" + (inputMode === option.id ? " active" : "")}
                  onClick={() => setInputMode(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>

            {inputMode === "frames" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 }}>
                <div>
                  <label className="label">
                    First frame · <em style={{ color: "var(--fg-3)", fontStyle: "normal" }}>actual opening scene</em>
                  </label>
                  <DropZone compact onFile={onPickFile} image={null} onClear={() => setImage(null)} allowDrag={!phoneView} hint={phoneView ? "Tap to choose first frame" : "Drop or choose first frame"} />
                  <SelectedImagePreview image={image} label="First frame" onClear={() => setImage(null)} />
                  {libraryStrip(onPickFile, [image, lastFrame])}
                </div>
                <div>
                  <label className="label">
                    Last frame · <em style={{ color: "var(--fg-3)", fontStyle: "normal" }}>optional final scene</em>
                  </label>
                  <DropZone compact onFile={onPickLastFrame} image={null} onClear={() => setLastFrame(null)} allowDrag={!phoneView} hint={phoneView ? "Tap to choose last frame" : "Drop or choose last frame"} />
                  <SelectedImagePreview image={lastFrame} label="Last frame" onClear={() => setLastFrame(null)} />
                  {libraryStrip(onPickLastFrame, [image, lastFrame])}
                </div>
              </div>
            )}

            {inputMode === "references" && (
              <div>
                <label className="label">
                  Reference images · <em style={{ color: "var(--fg-3)", fontStyle: "normal" }}>identity and story references</em>
                </label>
                <DropZone compact onFile={onPickReference} image={null} allowDrag={!phoneView} hint={phoneView ? "Tap to choose reference" : "Drop or choose reference"} />
                {designCharacters.length > 0 && (
                  <div className="design-reference-picker">
                    <div className="mono muted-2">Design characters</div>
                    <div className="design-reference-list">
                      {designCharacters.map((character) => {
                        const characterSaved = state.characterDesigns?.[character.id] || {};
                        const refs = characterReferenceItems(character, characterSaved);
                        const selectedCount = refs.filter((ref) => referenceImages.some((img) => (img.id || img.src) === (ref.id || ref.src))).length;
                        return (
                          <button
                            key={character.id}
                            className={"design-reference-card" + (selectedCount ? " selected" : "")}
                            type="button"
                            onClick={() => addDesignCharacterReferences(character)}
                          >
                            <img src={refs[0]?.src || character.sourceCard} alt="" />
                            <strong>{character.shortName}</strong>
                            <span>{refs.length} refs{selectedCount ? ` · ${selectedCount} selected` : ""}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {referenceImages.length > 0 && (
                  <div className="selected-image-grid">
                    {referenceImages.map((img) => (
                      <div key={img.id || img.src} className="img-tile selected-reference-tile">
                        <img src={img.src} alt="" />
                        <button className="btn btn-icon"
                          onClick={() => setReferenceImages((items) => items.filter((item) => item !== img))}
                          title="Remove reference"
                          style={{ position: "absolute", top: 6, right: 6, width: 24, height: 24, minWidth: 24, background: "rgba(0,0,0,.68)", color: "#fff", borderColor: "transparent" }}>
                          <Icon name="x" size={13}/>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {libraryStrip(onPickReference, referenceImages)}
              </div>
            )}
          </div>

          <div>
            <label className="label">Prompt</label>
            <textarea
              className="textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={mode === "i2v"
                ? "Describe motion between the frame endpoints: 'camera pushes in slowly, light flickers...'"
                : mode === "ref2v"
                  ? "Describe the shot while using references for identity, wardrobe, props, or story beats..."
                  : "Describe the shot: subject, environment, motion, lens, mood, lighting..."}
              style={{ minHeight: 140 }}
            />
            <div className="mono muted-2 prompt-helper">
              <span>Be specific: subject · motion · lens · lighting · mood</span>
              <span>{prompt.length} chars</span>
            </div>
          </div>
        </div>

        <aside style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="chip" style={{ alignSelf: "flex-start" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: mode === "t2v" ? "var(--fg-3)" : "var(--accent-2)", display: "inline-block" }}/>
            {modeLabel(mode)} · {inputMode}
          </div>

          <div className="param-grid">
            <ParamRow label="Resolution">
              <div className="seg">
                {HOST_PARAMS.resolutions.map((r) => (
                  <button key={r} className={"seg-opt" + (resolution === r ? " active" : "")} onClick={() => setResolution(r)}>{r}</button>
                ))}
              </div>
            </ParamRow>
            <ParamRow label={`Duration · ${duration}s`}>
              <DurationSlider value={duration} onChange={setDuration} min={HOST_PARAMS.durationMin} max={HOST_PARAMS.durationMax} />
            </ParamRow>
            <ParamRow label="Aspect">
              <div className="seg">
                {HOST_PARAMS.aspects.map((a) => (
                  <button key={a} className={"seg-opt" + (aspect === a ? " active" : "")} onClick={() => setAspect(a)}>{a}</button>
                ))}
              </div>
            </ParamRow>
            <ParamRow label="Camera">
              <div className="seg">
                {HOST_PARAMS.cameras.map((c) => (
                  <button key={c} className={"seg-opt" + (camera === c ? " active" : "")} onClick={() => setCamera(c)}>{c}</button>
                ))}
              </div>
            </ParamRow>
          </div>

          <ParamRow label="Seed">
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input mono" type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || 0))} />
              <button className="btn btn-icon" onClick={() => setSeed(Math.floor(Math.random() * 99999))} title="Randomize">
                <Icon name="refresh" size={14}/>
              </button>
            </div>
          </ParamRow>

          {inputMode === "references" && (
            <ParamRow label="Reference audio">
              <textarea
                className="textarea"
                value={referenceAudioText}
                onChange={(e) => setReferenceAudioText(e.target.value)}
                placeholder="https://..."
                style={{ minHeight: 72 }}
              />
            </ParamRow>
          )}

          <ParamRow label="Generate audio">
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--fg-2)" }}>
              <input type="checkbox" checked={generateAudio} onChange={(e) => setGenerateAudio(e.target.checked)} />
              <span>Enabled</span>
            </label>
          </ParamRow>

          <button className="btn btn-primary btn-lg" onClick={startGen} disabled={submitting} aria-busy={submitting} style={{ marginTop: 4 }}>
            <Icon name={submitting ? "refresh" : "sparkle"} size={14} className={submitting ? "spin-ic" : undefined}/>
            {submitting ? "Submitting task" : "Generate video"}
          </button>
          <div className="submit-note">
            {submitting
              ? "Creating the server task. The preview page will open as soon as the task id is ready."
              : "Generation runs in the background. Closing the tab will not cancel the render."}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Spec({ rows }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {rows.map(([k, val], i) => (
        <div key={k} style={{
          display: "flex", justifyContent: "space-between", gap: 12,
          padding: "8px 0",
          borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none",
        }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: ".1em", textTransform: "uppercase" }}>{k}</span>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg)" }}>{val}</span>
        </div>
      ))}
    </div>
  );
}

function TaskWaitPanel({ v }) {
  const status = String(v.status || "queued");
  const failed = TERMINAL_TASK_STATUSES.has(status) && status !== "succeeded";
  const label = failed ? status : status === "running" ? "Rendering task" : "Queued task";
  const showProgress = v.monitorMode === "poll" && Number.isFinite(v.progress);
  const shortTaskId = (v.arkTaskId || v.taskId || v.id || "").slice(0, 24);

  return (
    <div style={{
      position: "relative", background: "#000", borderRadius: "var(--radius-lg)",
      overflow: "hidden", aspectRatio: "16/9", width: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "1px solid var(--line)",
    }}>
      {v.thumb && <img src={v.thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: .28 }} />}
      <div style={{ position: "relative", zIndex: 1, padding: 32, textAlign: "center" }}>
        {failed ? (
          <>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--accent-2)", marginBottom: 12 }}>
              Task failed
            </div>
            <p style={{ color: "#fff", maxWidth: 520, lineHeight: 1.55, margin: 0 }}>
              {v.error?.message || "Seedance did not return a playable video."}
            </p>
          </>
        ) : showProgress ? (
          <GenerationProgress progress={v.progress || 0} label={label} />
        ) : (
          <div className="rendering-state" aria-live="polite">
            <div className="rendering-mark">
              <Icon name="refresh" size={28}/>
            </div>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 12 }}>
              {status}
            </div>
            <h2 className="display" style={{ color: "#fff", fontSize: 30, margin: "0 0 12px", lineHeight: 1.1 }}>
              Rendering in the background
            </h2>
            <p style={{ color: "rgba(255,255,255,.72)", maxWidth: 520, lineHeight: 1.55, margin: "0 auto" }}>
              This preview page is backed by the server task. Keep it open or come back later; the video will replace this state when Ark sends the result.
            </p>
            <div className="rendering-pills">
              <span>{v.resolution}</span>
              <span>{v.aspect}</span>
              <span>{v.duration}s</span>
              {shortTaskId && <span>{shortTaskId}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PreviewPage() {
  const { state, removeVideo, updateVideo, upsertVideo } = useStore();
  const { query, navigate } = useHashRoute();
  const v = state.videos.find((x) => x.id === query.id);
  const { show, node } = useToast();
  const taskId = v?.taskId || query.id;
  const shouldPoll = taskId && (!v || v.taskId || isActiveTask(v.status));
  const videoRef = useRef(v);
  const [taskError, setTaskError] = useState(null);
  const shareFileRef = useRef(null);
  const shareFilePromiseRef = useRef(null);
  const [shareState, setShareState] = useState({ src: null, status: "idle" });
  const videoSrc = v?.src;
  const shareStatus = shareState.src === videoSrc ? shareState.status : "idle";
  const shareVideo = useMemo(() => videoSrc ? {
    id: v?.id,
    taskId: v?.taskId,
    src: videoSrc,
    title: v?.title,
  } : null, [v?.id, v?.taskId, v?.title, videoSrc]);

  useEffect(() => {
    videoRef.current = v;
  }, [v]);

  const setShareStatusForVideo = useCallback((src, status) => {
    setShareState({ src, status });
  }, []);

  const prepareShareFile = useCallback((video) => {
    if (!video?.src) return Promise.reject(new Error("Video is not ready yet"));
    const filename = videoFileName(video);
    const cached = shareFileRef.current;
    if (cached?.src === video.src && cached.filename === filename) {
      setShareStatusForVideo(video.src, canShareVideoFile(cached.file) ? "ready" : "unavailable");
      return Promise.resolve(cached.file);
    }

    const pending = shareFilePromiseRef.current;
    if (pending?.src === video.src && pending.filename === filename) {
      return pending.promise;
    }

    setShareStatusForVideo(video.src, "preparing");
    let entry = null;
    const promise = fetchVideoFile(video.src, filename)
      .then((file) => {
        shareFileRef.current = { src: video.src, filename, file };
        setShareStatusForVideo(video.src, canShareVideoFile(file) ? "ready" : "unavailable");
        return file;
      })
      .catch((error) => {
        setShareStatusForVideo(video.src, "unavailable");
        throw error;
      })
      .finally(() => {
        if (shareFilePromiseRef.current === entry) {
          shareFilePromiseRef.current = null;
        }
      });

    entry = { src: video.src, filename, promise };
    shareFilePromiseRef.current = entry;
    promise.catch(() => {});
    return promise;
  }, [setShareStatusForVideo]);

  useEffect(() => {
    shareFileRef.current = null;
    shareFilePromiseRef.current = null;
  }, [videoSrc]);

  useEffect(() => {
    if (!shareVideo?.src || !isAppleTouchDevice() || !canAttemptFileShare()) return undefined;
    let cancelled = false;
    prepareShareFile(shareVideo)
      .then((file) => {
        if (!cancelled) setShareStatusForVideo(shareVideo.src, canShareVideoFile(file) ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) setShareStatusForVideo(shareVideo.src, "unavailable");
      });
    return () => { cancelled = true; };
  }, [shareVideo, prepareShareFile, setShareStatusForVideo]);

  useEffect(() => {
    if (!shouldPoll) return undefined;

    let stopped = false;
    let timer = null;

    const poll = async () => {
      try {
        const task = await fetchJson(`/api/task/${encodeURIComponent(taskId)}`);
        if (stopped) return;

        const currentVideo = videoRef.current;
        const patch = videoPatchFromTask(task, currentVideo || { id: task.id });
        if (currentVideo) updateVideo(currentVideo.id, patch);
        else upsertVideo(patch);
        setTaskError(null);

        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          timer = setTimeout(poll, 2500);
        }
      } catch (error) {
        if (!stopped) {
          if (error.status === 404) {
            setTaskError(error.message || "Task not found");
            return;
          }
          show(error.message || "Failed to fetch task status");
          timer = setTimeout(poll, 5000);
        }
      }
    };

    poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldPoll, taskId, updateVideo, upsertVideo, show]);

  if (!v) return (
    <div className="page-shell">
      <div className="queue-empty" style={{ margin: "64px auto", textAlign: "center" }}>
        <div className="mono muted-2" style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 8 }}>
          {taskError ? "Task unavailable" : "Loading task"}
        </div>
        <p style={{ margin: "0 0 14px", color: "var(--fg-2)", lineHeight: 1.55 }}>
          {taskError || "Fetching the server record for this preview."}
        </p>
        <button className="btn" onClick={() => navigate("/")}>← Back to gallery</button>
      </div>
    </div>
  );

  const onShare = async () => {
    if (!v.src) {
      show("Video is not ready yet");
      return;
    }
    if (!canAttemptFileShare()) {
      downloadVideoLink(v.src, videoFileName(v));
      show("Share is unavailable here; download started");
      return;
    }

    try {
      const file = await prepareShareFile(v);
      if (!canShareVideoFile(file)) {
        downloadVideoLink(v.src, videoFileName(v));
        show("This video cannot be shared here; download started");
        return;
      }
      await navigator.share({
        files: [file],
        title: v.title || "Videogen render",
      });
      show("Share completed");
    } catch (error) {
      if (error?.name === "AbortError") {
        show("Share cancelled");
        return;
      }
      if (error?.name === "NotAllowedError") {
        show("Video prepared. Tap Share again.");
        return;
      }
      console.warn("video share failed", error);
      downloadVideoLink(v.src, videoFileName(v));
      show("Share failed; download started");
    }
  };
  const onDelete = async () => {
    if (!confirm("Delete this video permanently?")) return;
    try {
      await deleteRemoteTask(v);
      removeVideo(v.id);
      navigate("/");
    } catch (error) {
      show(error.message || "Failed to delete task");
    }
  };
  const onTemplate = () => navigate("/create", { from: v.id });
  const ready = Boolean(v.src) && (!v.status || v.status === "succeeded");
  const onCopyLink = async () => {
    const link = `${window.location.origin}${window.location.pathname}#/preview?id=${encodeURIComponent(v.id)}`;
    try {
      await navigator.clipboard.writeText(link);
      show("Preview link copied");
    } catch {
      show(link);
    }
  };

  return (
    <div className="page-shell">
      {node}
      <header className="preview-header">
        <button className="btn btn-ghost" onClick={() => navigate("/")}>
          <Icon name="arrowLeft" size={14}/> Back to gallery
        </button>
        <div className="preview-actions">
          <button className="btn" onClick={onTemplate}><Icon name="copy" size={14}/> Use as template</button>
          <button className="btn" onClick={onShare} disabled={!v.src || shareStatus === "preparing"}>
            <Icon name="share" size={14}/> {shareStatus === "preparing" ? "Preparing" : "Share"}
          </button>
          <button className="btn btn-icon" onClick={onCopyLink} title="Copy link" aria-label="Copy link"><Icon name="copy" size={14}/></button>
          <button className="btn btn-icon" onClick={onDelete} title="Delete" aria-label="Delete"><Icon name="trash" size={14}/></button>
        </div>
      </header>

      <div className="preview-grid">
        <div>
          {ready ? <VideoPlayer src={v.src} poster={v.thumb} preload="metadata"/> : <TaskWaitPanel v={v} />}
        </div>

        <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div className="mono muted" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>Title</div>
            <h1 className="display" style={{ fontSize: 28, margin: 0, lineHeight: 1.15 }}>{v.title}</h1>
          </div>
          <details className="surface preview-fold">
            <summary>Prompt</summary>
            <div className="preview-fold-body">
              <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, color: "var(--fg-2)" }}>{v.prompt}</p>
            </div>
          </details>
          <details className="surface preview-fold">
            <summary>Parameters</summary>
            <div className="preview-fold-body">
              <Spec rows={[
                ["status", v.status || "ready"],
                ...(v.taskId ? [["task", v.taskId.slice(0, 22)]] : []),
                ["mode", modeLabel(v.mode)],
                ["resolution", v.resolution],
                ["aspect", v.aspect],
                ["duration", v.duration + "s · 24fps"],
                ["camera", v.camera],
                ["seed", v.seed],
                ["created", fmtDate(v.createdAt) + " · " + relTime(v.createdAt)],
              ]}/>
            </div>
          </details>
          {(() => {
            const ref = state.images.find((i) => i.id === v.imageId);
            const sceneFrameSrc = v.mode === "ref2v" ? null : ref?.src || v.referenceImageUrl;
            const referenceUrls = Array.from(new Set([
              ...(Array.isArray(v.characterReferenceUrls) ? v.characterReferenceUrls : []),
              v.characterReferenceUrl,
            ].filter(Boolean)));
            if (!sceneFrameSrc && !v.lastFrameUrl && referenceUrls.length === 0) return null;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(sceneFrameSrc || v.lastFrameUrl) && (
                  <div>
                    <div className="mono muted" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>
                      Scene frames
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10 }}>
                      {sceneFrameSrc && (
                        <div className="img-tile" style={{ aspectRatio: "16/9" }}>
                          <img src={sceneFrameSrc} alt=""/>
                        </div>
                      )}
                      {v.lastFrameUrl && (
                        <div className="img-tile" style={{ aspectRatio: "16/9" }}>
                          <img src={v.lastFrameUrl} alt=""/>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {referenceUrls.length > 0 && (
                  <div>
                    <div className="mono muted" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 8 }}>
                      Reference images
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(82px,1fr))", gap: 8 }}>
                      {referenceUrls.map((src, index) => (
                        <div key={`${src}-${index}`} className="img-tile" style={{ aspectRatio: "4/3" }}>
                          <img src={src} alt=""/>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </aside>
      </div>
    </div>
  );
}

export function LibraryPage() {
  const { state, removeImage, removeVideo, addImage } = useStore();
  const { navigate } = useHashRoute();
  const phoneView = usePhoneView();
  const [tab, setTab] = useState("images");
  const [search, setSearch] = useState("");
  const { show, node } = useToast();
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const libraryVideos = useMemo(() => [...state.videos].sort(taskSort), [state.videos]);
  const visibleVideos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return libraryVideos;
    return libraryVideos.filter((v) => [
      v.title,
      v.prompt,
      v.status,
      v.aspect,
      v.resolution,
    ].join(" ").toLowerCase().includes(q));
  }, [libraryVideos, search]);
  const activeVideos = libraryVideos.filter((v) => isActiveTask(v.status));

  const onUpload = async (files) => {
    const list = Array.from(files || []);
    if (!list.length || uploading) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(list.map(async (file) => {
        const src = await prepareUploadImage(file);
        return uploadImageAsset({ name: file.name, src });
      }));
      uploaded.forEach((img) => addImage(img));
      show(`Uploaded ${uploaded.length} image${uploaded.length === 1 ? "" : "s"}`);
    } catch (error) {
      show(error.message || "Image upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="page-shell wide">
      {node}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 28, gap: 16 }}>
        <div>
          <div className="mono muted" style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 6 }}>
            Asset locker
          </div>
          <h1 className="display" style={{ fontSize: 40, margin: 0 }}>
            Library
          </h1>
        </div>
        <div className="seg" style={{ width: "auto" }}>
          <button className={"seg-opt" + (tab === "images" ? " active" : "")} onClick={() => setTab("images")} style={{ padding: "8px 18px" }}>
            Images · {state.images.length}
          </button>
          <button className={"seg-opt" + (tab === "videos" ? " active" : "")} onClick={() => setTab("videos")} style={{ padding: "8px 18px" }}>
            Videos · {state.videos.length}
          </button>
        </div>
      </header>

      {tab === "images" && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
            <button className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={uploading}>
              <Icon name="upload" size={14} className={uploading ? "spin-ic" : undefined}/> {uploading ? "Uploading" : "Upload images"}
            </button>
            <input ref={inputRef} type="file" accept="image/*" multiple
                   style={{ display: "none" }}
                   onChange={(e) => onUpload(e.target.files)} />
            {!phoneView && (
              <span className="mono muted-2" style={{ fontSize: 11, letterSpacing: ".1em", alignSelf: "center" }}>
                Drag any tile onto Create to use as a scene frame
              </span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 14 }}>
            {state.images.length === 0 && (
              <div className="muted" style={{ gridColumn: "1/-1", padding: 64, textAlign: "center" }}>
                No images yet. Upload some to reuse across generations.
              </div>
            )}
            {state.images.map((img) => (
              <div key={img.id} className="img-tile"
                draggable={!phoneView}
                onDragStart={(e) => {
                  if (phoneView) return;
                  e.dataTransfer.setData("application/x-vgs-image", JSON.stringify(img));
                }}
                onClick={() => navigate("/create", { fromImage: img.id })}
              >
                <img src={img.src} alt={img.name}/>
                <button className="img-tile-del" onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const deletedRemote = await deleteImageAsset(img);
                    removeImage(img.id);
                    show(deletedRemote ? "Image moved to cloud trash" : "Image removed locally");
                  } catch (error) {
                    show(error.message || "Image delete failed");
                  }
                }}>
                  <Icon name="trash" size={12}/>
                </button>
                <div style={{
                  position: "absolute", left: 0, right: 0, bottom: 0,
                  padding: "16px 10px 8px",
                  background: "linear-gradient(180deg,transparent,rgba(0,0,0,.75))",
                  color: "#fff",
                }}>
                  <div className="mono" style={{ fontSize: 10, letterSpacing: ".06em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {img.name}
                  </div>
                  <div className="mono" style={{ fontSize: 9.5, opacity: .7, letterSpacing: ".12em", textTransform: "uppercase" }}>
                    {relTime(img.addedAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "videos" && (
        <>
          <div className="library-video-tools">
            <div className="queue-note" style={{ margin: 0 }}>
              <span className={activeVideos.length ? "spinner" : "queue-dot"} />
              <span>{activeVideos.length
                ? `${activeVideos.length} rendering task${activeVideos.length > 1 ? "s" : ""} will update here when ready.`
                : "No pending tasks right now. New renders appear on Home and here."}</span>
            </div>
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter videos..."
              style={{ maxWidth: 320 }}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 18 }}>
          {state.videos.length === 0 && (
            <div className="muted" style={{ gridColumn: "1/-1", padding: 64, textAlign: "center" }}>
              No videos yet. Generate one from Create.
            </div>
          )}
          {state.videos.length > 0 && visibleVideos.length === 0 && (
            <div className="muted" style={{ gridColumn: "1/-1", padding: 64, textAlign: "center" }}>
              No videos match that filter.
            </div>
          )}
          {visibleVideos.map((v) => (
            <div key={v.id} style={{ position: "relative" }}>
              <VideoCard v={v}
                onClick={() => navigate("/preview", { id: v.id })}
                onTemplate={() => navigate("/create", { from: v.id })}/>
              <button className="btn btn-icon"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm("Delete this video?")) return;
                  try {
                    await deleteRemoteTask(v);
                    removeVideo(v.id);
                    show("Video removed");
                  } catch (error) {
                    show(error.message || "Failed to delete task");
                  }
                }}
                style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.7)", color: "#fff", borderColor: "transparent" }}>
                <Icon name="trash" size={12}/>
              </button>
            </div>
          ))}
          </div>
        </>
      )}
    </div>
  );
}
