/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `onnxruntime-web` は自身のwasm本体を `new URL("ort-wasm-simd-threaded.jsep.wasm",
 * import.meta.url)` で参照しており、Viteはこれを静的解析して `dist/assets/` へ
 * 自動的にバンドルする(約23.8MB)。
 *
 * しかし本プロジェクトは `src/ocr/ppuPaddleEngine.ts` の `initialize()` 内で、
 * onnxruntime-webの`initWasm()`実行より前に `ortEnv.wasm.wasmPaths` を
 * `public/ort/`(同一wasmを自サイト同梱したもの)へ明示的に上書きしている。
 * onnxruntime-web側の自動バンドル分岐・CDNフォールバック分岐はどちらも
 * `!wasmPaths`(未設定時のみ)というガード条件を共有するため、上記の上書きが
 * 先に効いている限りこの自動バンドル分の資産は実行時に一切参照されない
 * (詳細はビルド後バンドルの静的解析結果として `.superpowers/sdd/task-4-report.md`
 * に記録済み)。
 *
 * 未使用の重複資産をビルド出力からわざと削除し、Pages成果物サイズと
 * デプロイ時間を削減する。`public/ort/` 側の正本は影響を受けない
 * (publicディレクトリはこのプラグインを経由せずそのままコピーされるため)。
 */
function dropUnusedOrtWasmAsset(): Plugin {
  return {
    name: "drop-unused-ort-wasm-asset",
    generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "asset" && /^assets\/ort-wasm-simd-threaded[^/]*\.wasm$/.test(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), dropUnusedOrtWasmAsset()],
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
