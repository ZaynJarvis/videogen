// Client-side identity-sheet stitching.
// Takes the per-zone generated images and draws them into ONE tidy composite
// (3×3 grid for 9 zones) on a canvas, then returns a JPEG data URL.
//
// Remote http(s) zone images are loaded through the CORS-safe proxy so the
// canvas is never tainted (mirrors the robustness of src/sheetCrop.js). Data
// URLs and same-origin paths pass through untouched.

function proxiedZoneUrl(url) {
  const src = String(url || "");
  if (!src) return "";
  // Data URLs and relative/same-origin paths load directly and stay clean.
  if (src.startsWith("data:") || src.startsWith("/")) return src;
  if (/^https?:\/\//i.test(src)) {
    return `/api/character-design/sheet-proxy?url=${encodeURIComponent(src)}`;
  }
  return src;
}

function loadZoneImage(url) {
  const resolved = proxiedZoneUrl(url);
  if (!resolved) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    // crossOrigin only matters for remote URLs; data URLs ignore it and stay clean.
    if (!resolved.startsWith("data:")) image.crossOrigin = "anonymous";
    // Best-effort: a single missing zone must not break the whole composite.
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = resolved;
  });
}

// Draw `image` into the square cell at (dx, dy, size) using a centred cover crop.
function drawCover(ctx, image, dx, dy, size) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const side = Math.min(iw, ih);
  const sx = (iw - side) / 2;
  const sy = (ih - side) / 2;
  ctx.drawImage(image, sx, sy, side, side, dx, dy, size, size);
}

// zones: [{ id, label, currentImage, generated }]
// options: { cols, rows, cell, gap, bg }
// Returns a JPEG data URL of the stitched composite. Empty slots are drawn blank.
export async function stitchZonesToSheet(zones, options = {}) {
  const list = Array.isArray(zones) ? zones : [];
  const count = list.length || 9;
  const cols = Math.max(1, Number(options.cols) || 3);
  const rows = Math.max(1, Number(options.rows) || Math.ceil(count / cols));
  const cell = Math.max(96, Number(options.cell) || 512);
  const gap = Number.isFinite(options.gap) ? Number(options.gap) : 14;
  const bg = options.bg || "#0f0e0d";
  const slotBg = options.slotBg || "#1a1917";

  const width = cols * cell + (cols + 1) * gap;
  const height = rows * cell + (rows + 1) * gap;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Load every zone image up front (failed loads resolve to null → blank slot).
  const images = await Promise.all(list.map((zone) => (zone?.generated && zone?.currentImage ? loadZoneImage(zone.currentImage) : Promise.resolve(null))));

  for (let i = 0; i < list.length && i < rows * cols; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const dx = gap + col * (cell + gap);
    const dy = gap + row * (cell + gap);

    // Blank backing for every slot so missing zones read as intentional gaps.
    ctx.fillStyle = slotBg;
    ctx.fillRect(dx, dy, cell, cell);

    const image = images[i];
    if (image) drawCover(ctx, image, dx, dy, cell);
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}
