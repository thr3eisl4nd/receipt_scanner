import type { OcrLine } from "./engine";

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
 * - box の x/y/width/height のいずれかが非有限、または height<=0 の行は除外する
 *   (下流の `extractTotal` は box.height で除算する幾何判定を行うため)。
 *
 * ライブラリ本体(onnxruntime-web/onnxruntime-node)に依存しない純粋関数にして
 * あるので、Node向けエントリ(`ppu-paddle-ocr`)の出力に対しても同じ検証ロジックを
 * 再利用できる(`scripts/verify-node-ocr.mjs` 参照)。
 */
export function mapToOcrLines(results: readonly RawRecognitionResult[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const r of results) {
    const { x, y, width, height } = r.box;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }
    if (height <= 0) continue;
    const confidence = Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0;
    lines.push({ text: r.text, confidence, box: { x, y, width, height } });
  }
  return lines;
}
