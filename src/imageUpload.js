function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

export async function prepareUploadImage(file) {
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const fileType = String(file?.type || "").toLowerCase();
  const fileName = String(file?.name || "").toLowerCase();
  if (!allowedTypes.has(fileType) && !/\.(jpe?g|png|webp)$/.test(fileName)) {
    throw new Error("Unsupported image format.");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Image is too large.");
  }

  const original = await readFileAsDataUrl(file);
  const img = await loadImage(original);
  const maxSide = 1600;
  const longest = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);

  if (longest <= maxSide && file.size <= 1.5 * 1024 * 1024) {
    return original;
  }

  const scale = Math.min(1, maxSide / longest);
  const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.88);
}
