import type { OcrBox, OcrEngine, OcrLine } from "./engine";
import { PaddleOcrService } from "ppu-paddle-ocr/web";
import { env as ortEnv } from "onnxruntime-web";
import { mapToOcrLines, sanitizeBoxes } from "./mapRecognitionResult";

/**
 * `detect()`(検出専用API、v1.3)呼び出し時のpadding上書き値。
 *
 * `ppu-paddle-ocr`の`DetectionOptions`既定値(paddingVertical:0.4/paddingHorizontal:0.6)は
 * 認識モデルへ十分なマージンを与えるための値で、認識と組み合わせて使う分には妥当だが、
 * レイアウト検出(XY-cut)用途では box 同士を過剰に肥大化させ、本来別の印字行・別の
 * レシートであるboxを誤って隣接/重複させてしまう(検証スパイクで実測: 既定値のままだと
 * 模擬12枚中2/12(16.7%)しか正解せず誤結合が多発、この上書き値で10/12(83.3%)・誤結合0件。
 * 詳細は`.superpowers/sdd/v13-spike.md` §1.2参照)。スパイクの結論通り、認識用の
 * `recognize()`呼び出しには影響させず、`detect()`呼び出しにのみ適用する。
 */
const DETECT_PADDING_VERTICAL = 0.1;
const DETECT_PADDING_HORIZONTAL = 0.15;

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
  // initialize()の多重呼び出し(複数fileの並走選択など)を1つの初期化に集約する共有Promise。
  // ppu-paddle-ocr/webのinitialize()自体には多重初期化ガードがないため、ここで直列化する。
  let initPromise: Promise<void> | null = null;

  async function initialize(): Promise<void> {
    if (service?.isInitialized()) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      // 自サイト同梱のwasmを使わせる(外部CDNへのフォールバックを防ぐ)。
      ortEnv.wasm.wasmPaths = ORT_WASM_BASE_URL;
      const candidate = new PaddleOcrService({
        model: {
          detection: `${MODEL_BASE_URL}PP-OCRv6_small_det.ort`,
          recognition: `${MODEL_BASE_URL}PP-OCRv6_small_rec.ort`,
          charactersDictionary: `${MODEL_BASE_URL}ppocrv6_dict.txt`,
        },
      });
      try {
        await candidate.initialize();
        // 成功した場合のみ公開する(失敗時に半初期化serviceが残るのを防ぐ)。
        service = candidate;
      } catch (cause) {
        // 失敗した候補が保持するONNXセッションを解放してから例外を投げる
        // (~31MBのモデル+セッションをリークさせない)。
        await candidate.destroy().catch(() => undefined);
        throw new Error("OCRモデルの初期化に失敗しました", { cause });
      }
    })().finally(() => {
      initPromise = null;
    });

    return initPromise;
  }

  return {
    initialize,

    async recognize(image: HTMLCanvasElement): Promise<OcrLine[]> {
      if (!service) {
        throw new Error("createPpuPaddleEngine: initialize() must be called before recognize()");
      }
      // noCache: ppu-paddle-ocrの既定キャッシュキーは「先頭1024byte+全体サイズ」のみで
      // 決まるため、同寸法・同レイアウトのコントラスト補正版(src/image/preprocess.ts の
      // enhanceContrast)が元画像と同一キーになり得る。同一Canvasの結果再利用は不要な
      // アプリなので、常時noCacheにして再試行が確実に別画像として処理されるようにする。
      const result = await service.recognize(image, { flatten: true, noCache: true });
      return mapToOcrLines(result.results, { width: image.width, height: image.height });
    },

    async detect(image: HTMLCanvasElement): Promise<OcrBox[]> {
      if (!service) {
        throw new Error("createPpuPaddleEngine: initialize() must be called before detect()");
      }
      // スパイクで確定したpadding上書き(§16.2、上記定数のdocコメント参照)。
      const result = await service.detect(image, {
        paddingVertical: DETECT_PADDING_VERTICAL,
        paddingHorizontal: DETECT_PADDING_HORIZONTAL,
      });
      return sanitizeBoxes(result.boxes, { width: image.width, height: image.height });
    },

    async destroy(): Promise<void> {
      // 初期化が進行中なら完了(または失敗)を待ってから解放する
      // (進行中のcandidateサービスを取りこぼしてリークさせないため)。
      await initPromise?.catch(() => undefined);
      const current = service;
      service = null;
      await current?.destroy();
    },
  };
}
