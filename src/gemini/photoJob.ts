import type { FailureKind } from "../types";
import {
  loadAsCanvas as defaultLoadAsCanvas,
  toThumbnailBlob as defaultToThumbnailBlob,
  toPreviewBlob as defaultToPreviewBlob,
} from "../image/preprocess";
import { classifyLoadError } from "../ocr/queue";
import {
  extractTotalsWithGemini as defaultExtractTotalsWithGemini,
  type GeminiExtractFailureReason,
  type GeminiExtractResult,
} from "./client";

/**
 * 写真1枚をGemini経路で処理する中核パイプライン(task-26、設計ドキュメント§19)。
 *
 * 既存OCR(`src/ocr/queue.ts`)と同じ`loadAsCanvas`(EXIF回転補正+長辺1600pxへ縮小)を
 * 再利用する(オーケストレーター指示: 「長辺1600px程度のJPEG」)。サムネイル・プレビュー
 * 生成も既存関数(`toThumbnailBlob`/`toPreviewBlob`)をそのまま使う(「トリミングなしの
 * 全体縮小でよい」)ため、Gemini経路でも既存のサムネイル生成が完全に維持される。
 */

/** OCR用に既に縮小済みのcanvasから生成する解像度は、既存OCR(§16.1)の完全OCR入力と
 *  揃える(長辺1600px)。検出専用の1200px経路(§16.1のパス1)はGemini経路には存在しない
 *  (Geminiが検出・分割・抽出を1回の呼び出しでまとめて行うため)。 */
const RECOGNIZE_LONG_EDGE = 1600;

/** canvasから縮小なしでJPEG(Base64)を生成する既定実装。`toDataURL`は同期APIのため、
 *  `toBlob`+`FileReader`より単純にBase64文字列を得られる。 */
function defaultCanvasToJpegBase64(canvas: HTMLCanvasElement, quality = 0.85): string {
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex === -1 ? "" : dataUrl.slice(commaIndex + 1);
}

/** `loadAsCanvas`/`toThumbnailBlob`/`toPreviewBlob`/`canvasToJpegBase64`/
 *  `extractTotalsWithGemini`の差し替えポイント(`src/ocr/queue.ts`の`OcrQueueDeps`と
 *  同じ考え方)。jsdom環境の単体テストでは実Canvas描画に依存できないため、薄いスタブに
 *  差し替えられるようにしている。 */
export type GeminiPhotoJobDeps = {
  loadAsCanvas: (file: File, maxEdge?: number) => Promise<HTMLCanvasElement>;
  toThumbnailBlob: (src: HTMLCanvasElement) => Promise<Blob>;
  toPreviewBlob: (src: HTMLCanvasElement) => Promise<Blob>;
  canvasToJpegBase64: (canvas: HTMLCanvasElement) => string;
  extractTotalsWithGemini: (apiKey: string, base64Jpeg: string) => Promise<GeminiExtractResult>;
};

const defaultDeps: GeminiPhotoJobDeps = {
  loadAsCanvas: defaultLoadAsCanvas,
  toThumbnailBlob: defaultToThumbnailBlob,
  toPreviewBlob: defaultToPreviewBlob,
  canvasToJpegBase64: defaultCanvasToJpegBase64,
  extractTotalsWithGemini: defaultExtractTotalsWithGemini,
};

export type GeminiPhotoJobCallbacks = {
  /** デコード直後(Gemini呼び出しの結果を待たずに)届ける、best-effortのサムネイル・
   *  プレビュー。生成自体が失敗した場合は呼ばれない(既存OCRキューのonThumbnail/
   *  onPreviewと同じ方針)。 */
  onThumbnail(blob: Blob): void;
  onPreview(blob: Blob): void;
};

export type GeminiPhotoJobResult =
  | { kind: "load-error"; failureKind: FailureKind }
  | { kind: "success"; totals: number[] }
  | { kind: "fallback"; reason: GeminiExtractFailureReason | "encode-error" };

/**
 * 呼び出し側(App.tsx)の責務: 戻り値`kind`に応じて
 * - `"load-error"`: 該当行を`failureKind`付きでfailed確定する(内蔵OCRも同じ`loadAsCanvas`
 *   で同じFileを再デコードするため、フォールバックしても同じエラーになるだけで無意味)。
 * - `"success"`: `totals`(1レシート=1要素、順序どおり)でプレースホルダ行をN行へ展開する。
 *   結果は必ず`needs-review`として扱うこと(誤読を勝手に確定しない安全設計)。
 * - `"fallback"`: 内蔵OCRキューへ同じFileを渡し、ユーザーへ通知する。
 */
export async function runGeminiPhotoJob(
  file: File,
  apiKey: string,
  callbacks: GeminiPhotoJobCallbacks,
  deps: GeminiPhotoJobDeps = defaultDeps,
): Promise<GeminiPhotoJobResult> {
  let canvas: HTMLCanvasElement;
  try {
    canvas = await deps.loadAsCanvas(file, RECOGNIZE_LONG_EDGE);
  } catch (err) {
    console.error("Gemini photo job: image load failed:", file.name, err);
    return { kind: "load-error", failureKind: classifyLoadError(err) };
  }

  try {
    // サムネイル・プレビュー生成はbest-effort(既存OCRキューのemitThumbnailAndPreviewと
    // 同じ方針)。失敗してもGemini呼び出し自体は継続する。
    try {
      const thumbnail = await deps.toThumbnailBlob(canvas);
      callbacks.onThumbnail(thumbnail);
    } catch (err) {
      console.error("Gemini photo job: thumbnail generation failed:", err);
    }
    try {
      const preview = await deps.toPreviewBlob(canvas);
      callbacks.onPreview(preview);
    } catch (err) {
      console.error("Gemini photo job: preview generation failed:", err);
    }

    let base64: string;
    try {
      base64 = deps.canvasToJpegBase64(canvas);
    } catch (err) {
      console.error("Gemini photo job: image encode failed:", err);
      return { kind: "fallback", reason: "encode-error" };
    }

    const result = await deps.extractTotalsWithGemini(apiKey, base64);
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    return { kind: "success", totals: result.totals };
  } finally {
    // 処理済みcanvasの明示解放(`src/ocr/queue.ts`のreleaseCanvasと同じ方針)。
    canvas.width = 1;
    canvas.height = 1;
  }
}
