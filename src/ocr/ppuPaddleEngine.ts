import type { OcrEngine, OcrLine } from "./engine";
import { PaddleOcrService } from "ppu-paddle-ocr/web";
import { env as ortEnv } from "onnxruntime-web";
import { mapToOcrLines } from "./mapRecognitionResult";

/** モデル配置ディレクトリ(自サイト同梱、public/models/ を BASE_URL 基準で参照)。 */
const MODEL_BASE_URL = `${import.meta.env.BASE_URL}models/`;

/**
 * onnxruntime-web の wasm/mjs 配置ディレクトリ(自サイト同梱、public/ort/)。
 *
 * `onnxruntime-web` はブラウザ実行時、`env.wasm.wasmPaths` が未設定だと
 * `https://cdn.jsdelivr.net/npm/onnxruntime-web@.../dist/` をデフォルトの
 * 取得元にする(ビルド後の実バンドルで確認済み)。Viteは `new URL(...,
 * import.meta.url)` 経由でwasm本体をビルド成果物に含めるが、このCDN既定値が
 * 先に設定されてしまい実行時にそちらが優先されるため、外部ドメインへの
 * fetchを防ぐには `initialize()` 前に明示的にローカルパスへ上書きする必要がある。
 */
const ORT_WASM_BASE_URL = `${import.meta.env.BASE_URL}ort/`;

/**
 * `ppu-paddle-ocr/web` (onnxruntime-web) を用いた `OcrEngine` 実装。
 *
 * モデル/辞書は自サイト同梱の PP-OCRv6 small(フル辞書)を使う。
 * v6-tiny(ライブラリ既定)の辞書はひらがな・カタカナ・円記号を含まず
 * 日本語レシートでは実用にならないため、あえて small を選択している
 * (詳細は task-4-report.md 参照)。
 * WebGPU/WASMの選択はライブラリの自動判定・自動フォールバックに委ねる
 * (`session.executionProviders` を指定しない)。
 */
export function createPpuPaddleEngine(): OcrEngine {
  let service: PaddleOcrService | null = null;

  return {
    async initialize() {
      // 自サイト同梱のwasmを使わせる(外部CDNへのフォールバックを防ぐ)。
      ortEnv.wasm.wasmPaths = ORT_WASM_BASE_URL;
      service = new PaddleOcrService({
        model: {
          detection: `${MODEL_BASE_URL}PP-OCRv6_small_det.ort`,
          recognition: `${MODEL_BASE_URL}PP-OCRv6_small_rec.ort`,
          charactersDictionary: `${MODEL_BASE_URL}ppocrv6_dict.txt`,
        },
      });
      await service.initialize();
    },

    async recognize(image: HTMLCanvasElement): Promise<OcrLine[]> {
      if (!service) {
        throw new Error("createPpuPaddleEngine: initialize() must be called before recognize()");
      }
      const result = await service.recognize(image, { flatten: true });
      return mapToOcrLines(result.results);
    },

    async destroy() {
      await service?.destroy();
      service = null;
    },
  };
}
