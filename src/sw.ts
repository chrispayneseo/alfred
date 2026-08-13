/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
import { savePendingShare } from "./lib/shareStore";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function fileToDataUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:${file.type};base64,${btoa(binary)}`;
}

async function handleShareTarget(request: Request): Promise<Response> {
  const formData = await request.formData();
  const title = formData.get("title");
  const text = formData.get("text");
  const url = formData.get("url");
  const image = formData.get("image");

  await savePendingShare({
    title: typeof title === "string" ? title : undefined,
    text: typeof text === "string" ? text : undefined,
    url: typeof url === "string" ? url : undefined,
    imageDataUrl: image instanceof File && image.size > 0 ? await fileToDataUrl(image) : undefined,
    receivedAt: new Date().toISOString(),
  });

  return Response.redirect("/capture", 303);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
  }
});
