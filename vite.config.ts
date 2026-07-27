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
        spike: "spike.html", // OCR検証スパイクページ(Task 4)
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
