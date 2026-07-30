import type { OcrBox, OcrLine } from "./engine";

/**
 * ライブラリの認識結果1件の構造。`ppu-paddle-ocr` の `RecognitionResult`
 * (core/base-recognition.service.ts、Node/Web/Mobile共通)と同じ形だが、
 * このモジュールをライブラリの型に直接依存させないための構造的コピー。
 */
export type RawRecognitionResult = {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
};

/**
 * ライブラリの認識結果を `OcrLine[]` にマッピングする(アダプタ境界)。
 *
 * - confidenceは[0,1]にクランプする(非有限値は0扱い)。
 * - box の x/y/width/height のいずれかが非有限、または width<=0/height<=0 の行は除外する
 *   (下流の `extractTotal` は box.height で除算し、box.width を用いた左右判定
 *   (`amount.x >= label.x + label.width - 8`)も行う幾何判定のため、負のwidthが
 *   混入すると右側判定が壊れる)。
 * - box は `bounds`(画像の width/height)でクランプし、クランプ後に交差領域が
 *   空になる行(画像完全に外側のbox)は除外する。
 *
 * ライブラリ本体(onnxruntime-web/onnxruntime-node)に依存しない純粋関数にして
 * あるので、Node向けエントリ(`ppu-paddle-ocr`)の出力に対しても同じ検証ロジックを
 * 再利用できる(`scripts/verify-node-ocr.mjs` 参照)。
 */
export function mapToOcrLines(
  results: readonly RawRecognitionResult[],
  bounds: { width: number; height: number },
): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const r of results) {
    const { x, y, width, height } = r.box;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }
    if (width <= 0 || height <= 0) continue;

    const x0 = Math.max(0, Math.min(bounds.width, x));
    const y0 = Math.max(0, Math.min(bounds.height, y));
    const x1 = Math.max(0, Math.min(bounds.width, x + width));
    const y1 = Math.max(0, Math.min(bounds.height, y + height));
    if (x1 <= x0 || y1 <= y0) continue;

    const confidence = Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0;
    lines.push({
      text: r.text,
      confidence,
      box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    });
  }
  return lines;
}

/**
 * `OcrEngine.detect()`(検出専用API、v1.3)が返すboxをサニタイズする(`mapToOcrLines`と
 * 同水準の防御。タスク指示: 「boxサニタイズは既存mapRecognitionResultと同水準」)。
 *
 * - x/y/width/height のいずれかが非有限、または width<=0/height<=0 のboxは除外する
 *   (`regionDetection.ts`の幾何演算は有限の正の寸法を前提とするため)。
 * - `bounds`(検出に使ったcanvasのwidth/height)でクランプし、クランプ後に交差領域が
 *   空になるbox(画像完全に外側のbox)は除外する。
 */
export function sanitizeBoxes(boxes: readonly RawRecognitionResult["box"][], bounds: { width: number; height: number }): OcrBox[] {
  const out: OcrBox[] = [];
  for (const b of boxes) {
    const { x, y, width, height } = b;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }
    if (width <= 0 || height <= 0) continue;

    const x0 = Math.max(0, Math.min(bounds.width, x));
    const y0 = Math.max(0, Math.min(bounds.height, y));
    const x1 = Math.max(0, Math.min(bounds.width, x + width));
    const y1 = Math.max(0, Math.min(bounds.height, y + height));
    if (x1 <= x0 || y1 <= y0) continue;

    out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}
