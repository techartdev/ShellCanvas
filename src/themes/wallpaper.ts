// SPDX-License-Identifier: MPL-2.0
// One locally chosen, normalized raster image. Never fetch image URLs from themes.
const changed = "shellcanvas-wallpaper-changed";
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shellcanvas-wallpaper", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("image");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Wallpaper storage is unavailable."));
  });
}
export async function readWallpaper(): Promise<Blob | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("image", "readonly");
      const request = tx.objectStore("image").get("custom");
      request.onsuccess = () =>
        resolve(
          request.result instanceof Blob &&
            request.result.type === "image/png" &&
            request.result.size <= 64 * 1024 * 1024
            ? request.result
            : undefined,
        );
      request.onerror = () =>
        reject(new Error("The saved wallpaper could not be read."));
    });
  } finally {
    db.close();
  }
}
export async function saveWallpaper(blob?: Blob) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("image", "readwrite");
      if (blob) tx.objectStore("image").put(blob, "custom");
      else tx.objectStore("image").delete("custom");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          new Error("Wallpaper could not be saved. Check available storage."),
        );
    });
  } finally {
    db.close();
  }
  window.dispatchEvent(new Event(changed));
}
export function watchWallpaper(listener: () => void) {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}
export async function prepareWallpaper(file: File): Promise<Blob> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 20 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG or WebP image up to 20 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("This image could not be opened."));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 80000000
    )
      throw new Error("Choose an image under 80 megapixels.");
    const scale = Math.min(
      1,
      3840 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Image could not be prepared.")),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
