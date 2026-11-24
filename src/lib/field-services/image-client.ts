const MAX_EDGE = 2000;
const THUMB_EDGE = 400;
const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export interface PreparedPhoto {
  photo: Blob;
  thumb: Blob;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw(src: ImageBitmap | HTMLImageElement, edge: number): HTMLCanvasElement {
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  const scale = Math.min(1, edge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas isn't available");
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Couldn't encode the photo"))),
      "image/jpeg",
      quality,
    ),
  );
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size > MAX_INPUT_BYTES) throw new Error("That photo is too large.");
  const src = await decode(file);
  const photo = await toBlob(draw(src, MAX_EDGE), 0.82);
  const thumb = await toBlob(draw(src, THUMB_EDGE), 0.7);
  if ("close" in src) src.close();
  return { photo, thumb };
}
