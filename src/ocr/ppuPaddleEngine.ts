import type { OcrBox, OcrEngine, OcrLine } from "./engine";
import { getDefaultWebExecutionProviders, PaddleOcrService } from "ppu-paddle-ocr/web";
import type { InferenceSession } from "onnxruntime-web";
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
 * onnxruntime-web wasmバックエンドのスレッド数上限。
 *
 * `env.wasm.numThreads` はcross-origin isolated(`window.crossOriginIsolated`)な
 * ページでのみ実際にマルチスレッド化される。本サイトは `index.html`/`spike.html`
 * 先頭で読み込む coi-serviceworker(`public/coi-serviceworker.js`)がGitHub Pages
 * でもcross-origin isolationを付与するため、対応環境では実際にマルチスレッドで
 * 動作する。
 *
 * 非対応環境では明示的に1(シングルスレッド)を指定する。以前は`window.crossOriginIsolated`
 * で分岐せず常に`min(4, hardwareConcurrency)`を設定していたが、これはonnxruntime-web
 * 自身の既定値`min(4, ceil(hardwareConcurrency / 2))`より積極的すぎ、「モバイル向けに
 * 保守的」という意図と矛盾していた(Codexレビュー指摘Minor)。ライブラリ側の
 * cross-origin isolated判定によるフォールバックに暗黙で頼るのではなく、ここで
 * ライブラリの既定値と同じ計算式を明示し、非対応環境では1に固定する。
 */
function resolveOrtNumThreads(): number {
  return window.crossOriginIsolated ? Math.min(4, Math.ceil((navigator.hardwareConcurrency || 1) / 2)) : 1;
}

/**
 * `ppu-paddle-ocr/web` (onnxruntime-web) を用いた `OcrEngine` 実装。
 *
 * モデル/辞書は自サイト同梱の PP-OCRv6 small(フル辞書)を使う。
 * v6-tiny(ライブラリ既定)の辞書はひらがな・カタカナ・円記号を含まず
 * 日本語レシートでは実用にならないため、あえて small を選択している
 * (詳細は task-4-report.md 参照)。
 *
 * 実行プロバイダは既定でWASM単体に固定している(`resolveExecutionProviders()`参照)。
 * 背景: `ppu-paddle-ocr`(6.2.0)の`BasePaddleOcrService`コンストラクタが
 * `session.executionProviders`を`["cpu"]`込みの既定値でdeepMerge済みにしてしまうため、
 * ライブラリ自身のWebGPU自動判定(`_resolveSessionExecutionProviders()`。「ユーザーが
 * 指定済み」と誤認して`getDefaultWebExecutionProviders()`を呼ばない)が実質常に無効化され、
 * 何もしなくても常にWASM実行になるバグがある(調査の詳細は`.superpowers/sdd/task-24-report.md`)。
 *
 * task-24で本ファイル側から明示的に`session.executionProviders`を渡すバグ回避を実装した上で
 * 実機検証(デスクトップChrome、Apple Silicon Metal GPU)したところ、検出/認識どちらの
 * ONNXモデルでもWebGPUでの`InferenceSession.create()`自体が毎回失敗した(ライブラリの
 * `createSessionWithFallback()`がWASM単体へ自動フォールバックするため実害はないが、
 * 速度上の利益なく初期化コストだけ増える)。そのため既定はWASM単体のままとし、
 * `?ocrProvider=webgpu`を付与した場合のみWebGPUを試す(opt-in)。onnxruntime-webや
 * ブラウザ側のWebGPU実装が改善したら実機再検証のうえ既定を切り替える想定。
 * (実機速度対策はcoi-serviceworker導入によるWASMマルチスレッド化で別途行っている)。
 */

/**
 * `session.executionProviders`を解決する。既定はWASM単体(現状はWebGPUを試しても
 * 恩恵がないため、上記docコメント参照)。`?ocrProvider=webgpu`が付与されている場合のみ、
 * ライブラリの`getDefaultWebExecutionProviders()`(WebGPU利用可能なら`["webgpu","wasm"]`、
 * `navigator.gpu`が無い/アダプタ取得失敗なら`["wasm"]`を返す)に委ねてWebGPUを試す。
 * 未知の値・パラメータなしはすべて安全側(WASM単体)に倒す。
 */
async function resolveExecutionProviders(): Promise<InferenceSession.SessionOptions["executionProviders"]> {
  if (new URLSearchParams(location.search).get("ocrProvider") === "webgpu") {
    return getDefaultWebExecutionProviders();
  }
  return ["wasm"];
}

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
      // cross-origin isolated環境ではマルチスレッドWASMを有効化し、非対応環境は
      // 明示的に1(シングルスレッド)にする(`resolveOrtNumThreads()`参照)。
      ortEnv.wasm.numThreads = resolveOrtNumThreads();
      // executionProvidersを明示指定する(`resolveExecutionProviders()`のdocコメント参照。
      // これを指定しないとppu-paddle-ocr側のバグで常にWASM実行になる)。
      const requestedExecutionProviders = await resolveExecutionProviders();
      // 「要求した」プロバイダであり、実際に使われたプロバイダとは限らない(WebGPUが
      // 要求されてもセッション生成に失敗すればWASMへ自動フォールバックする。フォールバック
      // 発生時は`createSessionWithFallback()`側が`console.warn`で別途ログする)。
      console.info(`[ppuPaddleEngine] requestedExecutionProviders=${JSON.stringify(requestedExecutionProviders)}`);
      const candidate = new PaddleOcrService({
        model: {
          detection: `${MODEL_BASE_URL}PP-OCRv6_small_det.ort`,
          recognition: `${MODEL_BASE_URL}PP-OCRv6_small_rec.ort`,
          charactersDictionary: `${MODEL_BASE_URL}ppocrv6_dict.txt`,
        },
        session: { executionProviders: requestedExecutionProviders },
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
