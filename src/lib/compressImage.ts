// Vercel Functions cap request bodies at ~4.5MB — a full-resolution phone
// photo (often several MB before base64 even adds its own ~33% overhead)
// blows past that before the request reaches the server at all. Downscaling
// client-side also just makes sense independent of that limit: vision
// models internally cap their effective input resolution anyway, so sending
// a 12MP original buys nothing but a slower upload.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

/** Downscales and re-encodes an image file as JPEG via canvas, returning
 * base64 (no data: prefix) ready to send to the server. */
export function compressImage(file: File): Promise<{ base64: string; mimeType: "image/jpeg" }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Couldn't process that photo."));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      resolve({ base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that photo — try a different one."));
    };
    img.src = url;
  });
}
