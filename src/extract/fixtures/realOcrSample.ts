import type { OcrLine } from "../../ocr/engine";

/**
 * 実際の `ppu-paddle-ocr`(Node向けエントリ、PP-OCRv6 small)で
 * 日本語レシート風の合成画像(スーパーABC/小計/合計/お預り/お釣り)を
 * OCRした実データ(`scripts/verify-node-ocr.mjs` の出力をそのまま固定化)。
 *
 * Task 3 の `synthetic.ts` は理想化された座標(width = text.length*12 の等間隔)
 * だが、こちらは実際のフォントレンダリング+検出+認識を経た本物の
 * confidence/box値なので、アダプタ境界(`mapToOcrLines`)と `extractTotal` の
 * 結合が実データでも壊れていないことを確認する回帰フィクスチャとして使う。
 */
export const realOcrSample: OcrLine[] = [
  { text: "スーパーABC", confidence: 0.9987953305244446, box: { x: 14, y: 17, width: 182, height: 35 } },
  { text: "ねぎ", confidence: 0.9688604831695556, box: { x: 9, y: 63, width: 78, height: 41 } },
  { text: "¥98", confidence: 0.9688604831695556, box: { x: 230, y: 66, width: 77, height: 37 } },
  { text: "小計", confidence: 0.9234544303682115, box: { x: 9, y: 112, width: 78, height: 44 } },
  { text: "¥1,234", confidence: 0.9234544303682115, box: { x: 230, y: 117, width: 120, height: 37 } },
  { text: "合計", confidence: 0.9247985747125413, box: { x: 11, y: 162, width: 76, height: 44 } },
  { text: "¥1,332", confidence: 0.9247985747125413, box: { x: 231, y: 167, width: 119, height: 37 } },
  { text: "お預り", confidence: 0.9422525703907013, box: { x: 12, y: 216, width: 96, height: 37 } },
  { text: "¥2,000", confidence: 0.9422525703907013, box: { x: 233, y: 218, width: 115, height: 36 } },
  { text: "お釣り", confidence: 0.9707447034972054, box: { x: 13, y: 266, width: 94, height: 36 } },
  { text: "¥668", confidence: 0.9707447034972054, box: { x: 234, y: 267, width: 89, height: 35 } },
];
