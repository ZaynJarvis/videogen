import { useState, useEffect, useContext, createContext, useCallback, useMemo, useRef } from 'react';
import { authHeader } from './auth';

const STORAGE_KEY = "vgs.state.v3";

const DEFAULT_STATE = {
  apiKey: "",
  videos: [],
  images: [],
  characterDesigns: {},
};

function sanitizeState(state) {
  const videos = Array.isArray(state?.videos) ? state.videos : [];
  const images = Array.isArray(state?.images) ? state.images : [];
  const characterDesigns = state?.characterDesigns && typeof state.characterDesigns === "object" ? state.characterDesigns : {};

  return {
    ...DEFAULT_STATE,
    ...state,
    videos: videos
      .filter((v) => !String(v?.id || "").startsWith("v_seed_"))
      .map((v) => ({ ...v, model: "seedance-pro" })),
    images: images.filter((img) => !String(img?.id || "").startsWith("i_seed_")),
    characterDesigns,
  };
}

function hasCharacterDesigns(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    return sanitizeState(JSON.parse(raw));
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(s) {
  try {
    const browserState = { ...(s || {}) };
    delete browserState.characterDesigns;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(browserState));
  } catch (e) {
    console.warn("save failed", e);
  }
}

async function readServerCharacterDesigns() {
  const res = await fetch("/api/character-design/state", { headers: authHeader() });
  if (!res.ok) throw new Error(`character designs load failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  return data.characterDesigns && typeof data.characterDesigns === "object" ? data.characterDesigns : {};
}

async function writeServerCharacterDesigns(characterDesigns) {
  const res = await fetch("/api/character-design/state", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ characterDesigns: characterDesigns || {} }),
  });
  if (!res.ok) throw new Error(`character designs save failed (${res.status})`);
}

function imageKeys(img) {
  return [img?.id, img?.src, img?.url, img?.key, img?.mediaPath, img?.media_path]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function normaliseLibraryImage(img) {
  return {
    addedAt: img.addedAt || img.added_at || Date.now(),
    ...img,
    src: img.src || img.url,
    url: img.url || img.src,
    mediaPath: img.mediaPath || img.media_path || img.url || img.src,
  };
}

function tagFromCloudKey(key) {
  const parts = String(key || "").split("/");
  if (parts.length >= 3 && parts[1] && parts[1] !== "sha256") return parts[1];
  return "";
}

function isCloudImageForTag(img, tag) {
  const isCloud = img?.cloud || img?.provider === "cloud" || Boolean(img?.key);
  if (!isCloud) return false;
  if (!tag) return true;

  const imageTag = String(img?.tag || tagFromCloudKey(img?.key) || "").trim();
  return imageTag === tag;
}

const StoreCtx = createContext(null);

export function StoreProvider({ children }) {
  const [state, setState] = useState(loadState);
  const serverCharacterDesignsLoadedRef = useRef(false);
  const saveTimerRef = useRef(null);

  useEffect(() => { saveState(state); }, [state]);

  useEffect(() => {
    let cancelled = false;
    const localCharacterDesigns = state.characterDesigns || {};
    readServerCharacterDesigns()
      .then(async (serverCharacterDesigns) => {
        if (cancelled) return;
        if (hasCharacterDesigns(serverCharacterDesigns)) {
          setState((s) => ({ ...s, characterDesigns: serverCharacterDesigns }));
        } else if (hasCharacterDesigns(localCharacterDesigns)) {
          await writeServerCharacterDesigns(localCharacterDesigns);
        } else {
          setState((s) => ({ ...s, characterDesigns: {} }));
        }
      })
      .catch((error) => {
        console.warn("character design server sync failed", error);
      })
      .finally(() => {
        if (!cancelled) serverCharacterDesignsLoadedRef.current = true;
      });
    return () => { cancelled = true; };
    // Run once: after AuthGate has allowed the app through, the token is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!serverCharacterDesignsLoadedRef.current) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      writeServerCharacterDesigns(state.characterDesigns || {})
        .catch((error) => console.warn("character design server save failed", error));
    }, 350);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state.characterDesigns]);

  const setApiKey = useCallback((apiKey) => setState((s) => ({ ...s, apiKey })), []);

  const addImage = useCallback((img) => {
    const item = {
      ...img,
      id: "i_" + Math.random().toString(36).slice(2, 9),
      addedAt: Date.now(),
    };
    setState((s) => ({ ...s, images: [item, ...s.images] }));
    return item;
  }, []);

  const removeImage = useCallback((id) => {
    setState((s) => ({ ...s, images: s.images.filter((i) => i.id !== id) }));
  }, []);

  const updateImage = useCallback((id, patch) => {
    setState((s) => ({
      ...s,
      images: s.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
    }));
  }, []);

  const updateCharacterDesign = useCallback((id, updater) => {
    setState((s) => {
      const current = s.characterDesigns?.[id] || {};
      const patch = typeof updater === "function" ? updater(current) : updater;
      return {
        ...s,
        characterDesigns: {
          ...(s.characterDesigns || {}),
          [id]: { ...current, ...(patch || {}) },
        },
      };
    });
  }, []);

  const removeCharacterDesign = useCallback((id) => {
    setState((s) => {
      const next = { ...(s.characterDesigns || {}) };
      delete next[id];
      return { ...s, characterDesigns: next };
    });
  }, []);

  const mergeImages = useCallback((images) => {
    const incoming = (Array.isArray(images) ? images : [])
      .filter((img) => img?.src || img?.url)
      .map(normaliseLibraryImage);

    if (!incoming.length) return;

    setState((s) => {
      const seen = new Set(s.images.flatMap(imageKeys));
      const additions = [];

      for (const img of incoming) {
        const keys = imageKeys(img);
        if (keys.some((key) => seen.has(key))) continue;
        additions.push(img);
        keys.forEach((key) => seen.add(key));
      }

      if (!additions.length) return s;
      return { ...s, images: [...additions, ...s.images] };
    });
  }, []);

  const syncCloudImages = useCallback((images, { tag = "" } = {}) => {
    const incoming = (Array.isArray(images) ? images : [])
      .filter((img) => img?.src || img?.url)
      .map(normaliseLibraryImage);

    setState((s) => {
      const remoteKeys = new Set(incoming.flatMap(imageKeys));
      const seen = new Set(remoteKeys);
      const local = [];

      for (const img of s.images) {
        const keys = imageKeys(img);
        const syncedCloudImage = isCloudImageForTag(img, tag);

        if (syncedCloudImage && !keys.some((key) => remoteKeys.has(key))) {
          continue;
        }

        if (keys.some((key) => seen.has(key))) {
          continue;
        }

        local.push(img);
        keys.forEach((key) => seen.add(key));
      }

      return { ...s, images: [...incoming, ...local] };
    });
  }, []);

  const addVideo = useCallback((v) => {
    const item = {
      id: "v_" + Math.random().toString(36).slice(2, 9),
      createdAt: Date.now(),
      ...v,
    };
    setState((s) => ({ ...s, videos: [item, ...s.videos] }));
    return item;
  }, []);

  const removeVideo = useCallback((id) => {
    setState((s) => ({ ...s, videos: s.videos.filter((v) => v.id !== id) }));
  }, []);

  const updateVideo = useCallback((id, patch) => {
    setState((s) => ({
      ...s,
      videos: s.videos.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    }));
  }, []);

  const upsertVideo = useCallback((video) => {
    const item = {
      id: "v_" + Math.random().toString(36).slice(2, 9),
      createdAt: Date.now(),
      ...video,
    };
    setState((s) => {
      const exists = s.videos.some((v) => v.id === item.id);
      return {
        ...s,
        videos: exists
          ? s.videos.map((v) => (v.id === item.id ? { ...v, ...item } : v))
          : [item, ...s.videos],
      };
    });
    return item;
  }, []);

  const value = useMemo(
    () => ({ state, setApiKey, addImage, removeImage, updateImage, updateCharacterDesign, removeCharacterDesign, mergeImages, syncCloudImages, addVideo, removeVideo, updateVideo, upsertVideo }),
    [state, setApiKey, addImage, removeImage, updateImage, updateCharacterDesign, removeCharacterDesign, mergeImages, syncCloudImages, addVideo, removeVideo, updateVideo, upsertVideo]
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}

export function useHashRoute() {
  const parse = () => {
    const h = window.location.hash.slice(1) || "/";
    const [path, qs] = h.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs || ""));
    return { path, query };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const fn = () => setRoute(parse());
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  const navigate = useCallback((path, query) => {
    let url = "#" + path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += "?" + qs;
    }
    window.location.hash = url.slice(1);
  }, []);
  return { ...route, navigate };
}

export function relTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const d = Math.floor(hr / 24);
  return d + "d ago";
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
