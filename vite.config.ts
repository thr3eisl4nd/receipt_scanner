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

/**
 * 本番ビルド時のみCSPをmetaタグとして注入する(task-27セキュリティレビュー指摘: 静的SPAで
 * バックエンドを持たずCSPレスポンスヘッダーを設定できないため、meta要素での近似運用となる。
 * meta要素は`frame-ancestors`/`report-uri`/Report-Onlyに対応しないため含めない)。
 *
 * `vite dev`(HMR)はインラインスクリプト注入・WebSocket接続に依存するため開発サーバーでは
 * 適用しない(`ctx.server`はdev/preview時のみ存在し、`vite build`時は存在しない)。
 *
 * 各ディレクティブの根拠:
 * - `script-src 'self' 'wasm-unsafe-eval'`: onnxruntime-webのWASMコンパイルに必要な最小限
 *   (JSの`eval`まで許す`'unsafe-eval'`は不要)。pthreadワーカーは
 *   `new Worker(new URL(import.meta.url))`で同一オリジンのファイルから生成されるため
 *   blob:は不要(`node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs`参照)。
 * - `worker-src 'self' blob:`: coi-serviceworker・onnxruntime-webのWorkerに加え、将来の
 *   Blob Worker追加にも耐えるようblob:も許可しておく。
 * - `connect-src 'self' https://generativelanguage.googleapis.com`: 同一オリジンのWASM取得と
 *   Gemini API呼び出し(`src/gemini/client.ts`)のみを許可する。
 * - `img-src 'self' blob:`: サムネイル/プレビュー(`URL.createObjectURL`のblob: URL)用。
 * - `style-src 'self'`: `dangerouslySetInnerHTML`/インライン`<style>`/`style=""`属性を
 *   使っていないため`'unsafe-inline'`は不要(Reactの`style`propはCSSOM経由の個別プロパティ
 *   設定でありCSPのstyle-src/style-src-attrの対象外。`spike.html`のインラインCSSも
 *   `src/spike/spike.css`へ切り出し済み)。
 * - `object-src 'none'` / `base-uri 'none'` / `frame-src 'none'` / `form-action 'none'` /
 *   `media-src 'none'`: 使っていない機能を明示的に閉じる。
 * - `default-src 'self'`: 上記で個別に指定していないリソース種別(明示していないディレクティブ
 *   すべて)のフォールバック既定値。同一オリジンのみを許可する安全側の既定にしておく。
 * - `script-src-attr 'none'`: `onclick=""`等のインライン イベントハンドラ属性は使っていない
 *   (Reactは`addEventListener`を使うため該当なし)。
 * - `child-src 'self' blob:'`: `worker-src`未対応の古いブラウザ向けのフォールバック
 *   (Worker/`<iframe>`両方に効くレガシーディレクティブ)。`frame-src 'none'`と矛盾しないよう、
 *   本アプリは`<iframe>`を使っていないためWorker用途としてのみ効く。
 * - `font-src 'self'`: 外部フォント(Google Fonts等)を使わず、フォントファイルを追加していない
 *   ため念のため同一オリジンのみに制限する(現状フォントファイル自体を配信していない)。
 */
function injectCsp(): Plugin {
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "connect-src 'self' https://generativelanguage.googleapis.com",
    "img-src 'self' blob:",
    "font-src 'self'",
    "frame-src 'none'",
    "form-action 'none'",
    "media-src 'none'",
  ].join("; ");

  return {
    name: "inject-csp",
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html; // devサーバー(HMR)には適用しない。本番ビルドのみ。
      // meta要素で指定するCSPは「そのmeta要素より後に現れる要素」にしか適用されない
      // (それより前に既にパース済みのscript/link等は対象外になる)。そのため`<head>`の
      // 一番最初(`<meta charset>`の直後)に挿入し、以降の全リソース読み込みへ確実に
      // 適用されるようにする。
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), dropUnusedOrtWasmAsset(), injectCsp()],
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
