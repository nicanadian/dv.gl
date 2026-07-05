import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Cesium needs its static assets served and CESIUM_BASE_URL defined.
export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("./cesium"),
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        composed: "composed.html",
        cleansheet: "cleansheet.html",
        explore: "explore.html",
      },
    },
    chunkSizeWarningLimit: 5000,
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "node_modules/cesium/Build/Cesium/Workers", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/ThirdParty", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/Assets", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/Widgets", dest: "cesium" },
      ],
    }),
  ],
});
