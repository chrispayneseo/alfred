import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { notionApiPlugin } from "./server/notion/apiPlugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    notionApiPlugin(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: "auto",
      registerType: "autoUpdate",
      devOptions: {
        enabled: true,
        type: "module",
      },
      manifest: {
        id: "/",
        name: "Alfred",
        short_name: "Alfred",
        description: "A calm, proactive personal assistant that captures, organizes, and briefs.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f4f2ee",
        theme_color: "#f4f2ee",
        orientation: "portrait-primary",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "image",
                accept: ["image/*"],
              },
            ],
          },
        },
      },
    }),
  ],
});
