import { useState, useRef, useEffect } from 'react';
import { prepareUploadImage } from './imageUpload';

export function Icon({ name, size = 16, ...rest }) {
  const paths = {
    sparkle: <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3zM5 17l.85 2.15L8 20l-2.15.85L5 23l-.85-2.15L2 20l2.15-.85L5 17z" fill="currentColor"/>,
    plus: <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>,
    play: <path d="M6 4l14 8-14 8V4z" fill="currentColor"/>,
    pause: <><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></>,
    download: <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>,
    trash: <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m-8 0v12a2 2 0 002 2h6a2 2 0 002-2V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>,
    home: <path d="M3 11l9-8 9 8M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>,
    upload: <path d="M12 17V5m0 0l-4 4m4-4l4 4M4 19h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>,
    share: <path d="M16 6l-4-4-4 4m4-4v13M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>,
    key: <><circle cx="8" cy="14" r="4" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M11 11l9-9m-3 0h3v3m-3 3l-2-2" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></>,
    arrowLeft: <path d="M19 12H5m0 0l6 6m-6-6l6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>,
    calendar: <><rect x="4" y="5" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M8 3v4M16 3v4M4 10h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></>,
    x: <path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="1.6" fill="none"/></>,
    refresh: <path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16m0 5v-5h5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    grid: <><rect x="3" y="3" width="7" height="7" stroke="currentColor" strokeWidth="1.6" fill="none"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" strokeWidth="1.6" fill="none"/><rect x="3" y="14" width="7" height="7" stroke="currentColor" strokeWidth="1.6" fill="none"/><rect x="14" y="14" width="7" height="7" stroke="currentColor" strokeWidth="1.6" fill="none"/></>,
    message: <><path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-6l-5 4v-4H5a2 2 0 01-2-2V7a2 2 0 012-2z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round"/><path d="M7 9h10M7 13h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></>,
    person: <><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" fill="none"/><path d="M5 21a7 7 0 0114 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...rest}>{paths[name] || null}</svg>
  );
}

export function DropZone({ onFile, onFiles, image, onClear, onError, hint = "Drop image, or click to browse", accept = "image/*", compact = false, allowDrag = true, multiple = false }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const handle = async (files) => {
    const fileList = Array.from(files || []).filter(Boolean);
    if (busy || !fileList.length) return;
    try {
      setBusy(true);
      setError("");
      const selected = multiple ? fileList : fileList.slice(0, 1);
      const images = [];
      for (const file of selected) {
        const src = await prepareUploadImage(file);
        images.push({ name: file.name, src });
      }
      if (multiple && onFiles) await onFiles(images);
      else await onFile?.(images[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image upload failed.";
      setError(message);
      onError?.(error);
      console.warn("image upload failed", error);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <div
      className={"drop" + (over ? " over" : "") + (!allowDrag ? " no-drag" : "")}
      onClick={() => !busy && !image && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!allowDrag) return;
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault(); setOver(false);
        if (!allowDrag) return;
        const data = e.dataTransfer.getData("application/x-vgs-image");
        if (data) {
          try {
            setBusy(true);
            setError("");
            await onFile?.(JSON.parse(data));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Image upload failed.";
            setError(message);
            onError?.(error);
            // Ignore malformed drag payloads.
          } finally {
            setBusy(false);
          }
          return;
        }
        handle(e.dataTransfer.files);
      }}
      style={image
        ? { padding: 0, minHeight: compact ? 172 : 280, border: "1px solid var(--line-strong)" }
        : compact ? { minHeight: 172, padding: 22 } : undefined}
    >
      {image ? (
        <div style={{ position: "relative", width: "100%", height: "100%", minHeight: compact ? 172 : 280 }}>
          <img src={image.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "inherit" }} />
          <button
            className="btn btn-icon"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            style={{ position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,.7)", borderColor: "transparent", color: "#fff" }}
            title="Remove"
          ><Icon name="x" /></button>
          <div className="mono" style={{
            position: "absolute", bottom: 10, left: 10, fontSize: 10,
            background: "rgba(0,0,0,.65)", color: "#fff", padding: "3px 8px",
            borderRadius: 3, letterSpacing: ".08em", textTransform: "uppercase",
          }}>{image.name || "reference"}</div>
        </div>
      ) : (
        <>
          <Icon name="upload" size={32} className={"drop-icon" + (busy ? " spin-ic" : "")} />
          <div style={{ fontSize: 14, fontWeight: 500 }}>{busy ? "Uploading image" : hint}</div>
          {error && <div className="drop-error">{error}</div>}
          <input
            ref={inputRef} type="file" accept={accept} multiple={multiple}
            style={{ display: "none" }}
            onChange={(e) => handle(e.target.files)}
          />
        </>
      )}
    </div>
  );
}

export function VideoPlayer({ src, poster, autoplay = false, preload = "metadata" }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(autoplay);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const update = () => { setT(v.currentTime); setDur(v.duration || 0); };
    v.addEventListener("timeupdate", update);
    v.addEventListener("loadedmetadata", update);
    v.addEventListener("play", () => setPlaying(true));
    v.addEventListener("pause", () => setPlaying(false));
    return () => {
      v.removeEventListener("timeupdate", update);
      v.removeEventListener("loadedmetadata", update);
    };
  }, []);

  const toggle = () => {
    const v = ref.current; if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };
  const fmt = (n) => {
    if (!isFinite(n)) return "0:00";
    const m = Math.floor(n / 60); const s = Math.floor(n % 60);
    return m + ":" + String(s).padStart(2, "0");
  };
  const pct = dur ? (t / dur) * 100 : 0;

  return (
    <div style={{
      position: "relative", background: "#000", borderRadius: "var(--radius-lg)",
      overflow: "hidden", aspectRatio: "16/9", width: "100%",
    }}>
      <video
        ref={ref} src={src} poster={poster}
        autoPlay={autoplay} preload={preload} playsInline
        onClick={toggle}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", cursor: "pointer" }}
      />
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        padding: "32px 18px 14px",
        background: "linear-gradient(180deg,transparent,rgba(0,0,0,.85))",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <button className="btn btn-icon" onClick={toggle}
          style={{ background: "rgba(255,255,255,.95)", color: "#000", borderColor: "transparent" }}>
          <Icon name={playing ? "pause" : "play"} size={14} />
        </button>
        <div className="mono" style={{ color: "#fff", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 44 }}>
          {fmt(t)}
        </div>
        <div
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - r.left) / r.width;
            if (ref.current && dur) ref.current.currentTime = ratio * dur;
          }}
          style={{
            flex: 1, height: 4, background: "rgba(255,255,255,.18)",
            borderRadius: 2, cursor: "pointer", position: "relative",
          }}
        >
          <div style={{
            position: "absolute", inset: 0, width: pct + "%",
            background: "var(--accent)", borderRadius: 2,
          }} />
        </div>
        <div className="mono" style={{ color: "#fff", fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right" }}>
          {fmt(dur)}
        </div>
      </div>
    </div>
  );
}

export function GenerationProgress({ progress, label }) {
  return (
    <div style={{ width: 280 }}>
      <div className="mono" style={{ fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--accent-2)", animation: "spin 1s linear infinite" }}></span>
        Recording &middot; {label}
      </div>
      <div className="serif" style={{ fontSize: 72, lineHeight: 1, letterSpacing: "-.02em", color: "var(--fg)" }}>
        {Math.round(progress)}%
      </div>
      <div style={{ marginTop: 14, height: 1, background: "var(--line)" }}>
        <div style={{ height: 1, background: "var(--accent)", width: progress + "%", transition: "width .3s" }} />
      </div>
    </div>
  );
}
