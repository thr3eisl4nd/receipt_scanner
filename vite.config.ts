/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/receipt_scanner/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        spike: "spike.html", // Task 4で追加(それまで空のプレースホルダを置く)
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
