import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Personal Manager",
        short_name: "Priorities",
        description: "Prioritise tasks and log your day, in sync across devices.",
        theme_color: "#4f46e5",
        background_color: "#f6f7fb",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app shell is cached so it opens offline; /api is never cached.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: API_TARGET, changeOrigin: false } },
  },
  build: { target: "es2022", sourcemap: true },
});
