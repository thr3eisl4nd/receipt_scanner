#!/usr/bin/env node
/**
 * Task 4 検証スクリプト(使い捨て、CIには組み込まない)。
 *
 * 目的: ppu-paddle-ocr の実APIをNode向けエントリ(onnxruntime-node)で実際に
 * 動かし、
 *   1. RecognitionResult の実際の形(text/confidence/box)が本タスクの
 *      アダプタ実装の想定通りであること
 *   2. アダプタ境界の純粋関数 `mapToOcrLines`(src/ocr/mapRecognitionResult.ts)
 *      が実際のライブラリ出力に対しても正しく動くこと
 * を、実際に生成した日本語レシート風の画像に対するOCR結果で確認する。
 *
 * 実行前提: `onnxruntime-node` は本番(ブラウザ向け)の依存に含めないため
 * package.json には保存していない。実行する場合は:
 *   npm install --no-save onnxruntime-node@1.23.2
 *   node scripts/verify-node-ocr.mjs
 *
 * モデルは public/models/ に自サイト同梱したものと同じファイル(PP-OCRv6 small)
 * をそのままローカルパスで読み込む(ネットワーク取得なし)。
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const { mapToOcrLines } = await import(
  path.join(projectRoot, "src/ocr/mapRecognitionResult.ts")
);
// 注意: extractTotal.ts はプロジェクトの慣例(バンドラ解決)で拡張子なしの
// 相対import ("./normalize") を使っており、Nodeネイティブの型剥がしは
// バンドラを介さないため解決できない。extractTotalとの結合確認は
// vitest側(src/extract/extractTotal.realocr.test.ts)で行う。

const fontFamily = GlobalFonts.families.some((f) => f.family === "Hiragino Sans")
  ? "Hiragino Sans"
  : "sans-serif";

function renderSyntheticReceipt() {
  const width = 400;
  const height = 320;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "black";
  ctx.font = `28px "${fontFamily}"`;
  ctx.textBaseline = "top";

  const rows = [
    { y: 20, label: "スーパーABC" },
    { y: 70, label: "ねぎ", amount: "¥98" },
    { y: 120, label: "小計", amount: "¥1,234" },
    { y: 170, label: "合計", amount: "¥1,332" },
    { y: 220, label: "お預り", amount: "¥2,000" },
    { y: 270, label: "お釣り", amount: "¥668" },
  ];
  for (const row of rows) {
    ctx.fillText(row.label, 20, row.y);
    if (row.amount) ctx.fillText(row.amount, 240, row.y);
  }
  return canvas;
}

async function main() {
  const canvas = renderSyntheticReceipt();

  const modelDir = path.join(projectRoot, "public", "models");
  const service = new PaddleOcrService({
    model: {
      detection: path.join(modelDir, "PP-OCRv6_small_det.ort"),
      recognition: path.join(modelDir, "PP-OCRv6_small_rec.ort"),
      charactersDictionary: path.join(modelDir, "ppocrv6_dict.txt"),
    },
  });

  console.log("initializing PaddleOcrService (Node, onnxruntime-node)...");
  await service.initialize();

  console.log("running recognize({flatten:true}) on synthetic receipt canvas...");
  const t0 = Date.now();
  const result = await service.recognize(canvas, { flatten: true });
  const ms = Date.now() - t0;
  console.log(`recognize() done in ${ms}ms, raw results:`);
  console.log(JSON.stringify(result.results, null, 2));

  const ocrLines = mapToOcrLines(result.results);
  console.log("\nmapToOcrLines() output (OcrLine[]):");
  console.log(JSON.stringify(ocrLines, null, 2));

  // 基本的な健全性チェック(手動目視の代わりに機械的に確認できる範囲)
  const problems = [];
  if (ocrLines.length === 0) problems.push("OcrLineが1件も得られなかった");
  for (const line of ocrLines) {
    if (!(line.confidence >= 0 && line.confidence <= 1)) {
      problems.push(`confidenceが[0,1]範囲外: ${JSON.stringify(line)}`);
    }
    if (!(line.box.height > 0)) {
      problems.push(`height<=0のOcrLineが混入: ${JSON.stringify(line)}`);
    }
  }
  const joinedText = ocrLines.map((l) => l.text).join(" ");
  if (!joinedText.includes("合計")) {
    problems.push(`"合計"を含む行が認識できなかった(実際のテキスト: ${joinedText})`);
  }

  await service.destroy();

  if (problems.length > 0) {
    console.error("\n[NG] 問題あり:");
    for (const p of problems) console.error(` - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\n[OK] mapToOcrLinesの出力はconfidence/box双方とも健全、'合計'行も認識できた。");
  }
}

main().catch((err) => {
  console.error("verify-node-ocr failed:", err);
  process.exitCode = 1;
});
