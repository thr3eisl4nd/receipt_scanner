#!/usr/bin/env node
/**
 * v1.3検証スパイク用: per-region OCRの効き目確認(タスク5)。
 * 使い捨て、CIには組み込まない、本番コード変更なし。
 *
 * 4枚(2×2)配置の模擬マルチレシート写真に対して2つの経路を比較する:
 *   (a) 従来経路: 写真全体を長辺1600pxへ縮小 → recognize() → extractTotal
 *       (1回のOCRにつき1行=1金額しか得られない。4枚分の合計を1回で処理しようとする
 *       従来の「1枚の写真=1レシート」実装をそのまま4レシート写真に適用した場合の挙動)
 *   (b) 領域クロップ経路: §16.1のパス1(長辺1200pxでdetect())→再帰XY-cut→
 *       各領域を「元解像度画像」から軸平行クロップ(§16.2 point5の余白付き)→
 *       長辺1600pxへ正規化(再拡大はしない)→領域ごとにrecognize()→extractTotal
 *
 * 両経路とも、1回目の結果がauto-highでなければコントラスト強調版で再試行する
 * (本番 src/ocr/queue.ts と同じ二段階再試行、既存スパイク run-degraded-ocr.mjs と同一)。
 *
 * 使い方:
 *   COMPILED_DIR=<dir> node scripts/run-per-region-ocr-compare.mjs \
 *     --imagesDir <dir with manifest.json> --file grid-2x2-wood.jpg \
 *     --xycutModule <compiled xycut.js> --out <out.json>
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.imagesDir) throw new Error("--imagesDir <dir> is required");
if (!args.file) throw new Error("--file <manifest file entry> is required");
if (!args.xycutModule) throw new Error("--xycutModule <compiled xycut.js> is required");

const compiledDir = process.env.COMPILED_DIR;
if (!compiledDir) throw new Error("COMPILED_DIR env var (scratchpad compiled output) is required");
const { extractTotal } = await import(path.join(compiledDir, "extract/extract/extractTotal.js"));
const { mapToOcrLines } = await import(path.join(compiledDir, "ocr/mapRecognitionResult.js"));
const { buildLayoutDecision, cropRectForRegion } = await import(path.resolve(args.xycutModule));

const manifest = JSON.parse(readFileSync(path.join(args.imagesDir, "manifest.json"), "utf8"));
const entry = manifest.find((m) => m.file === args.file);
if (!entry) throw new Error(`${args.file} not found in manifest`);

const DETECT_LONG_EDGE = 1200;
const RECOGNIZE_LONG_EDGE = 1600;

function drawScaledToLongEdge(image, targetLongEdge, allowUpscale = false) {
  const scale = allowUpscale ? targetLongEdge / Math.max(image.width, image.height) : Math.min(1, targetLongEdge / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return { canvas, scale };
}

function cropCanvas(image, rect) {
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, rect.x, rect.y, w, h, 0, 0, w, h);
  return canvas;
}

function enhanceContrast(src) {
  const canvas = createCanvas(src.width, src.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.round(((g - min) / range) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** recognize→extractTotal を実行し、auto-highでなければコントラスト再試行する(本番同等の常時再試行)。 */
async function recognizeAndExtract(service, canvas) {
  const t0 = Date.now();
  const raw1 = await service.recognize(canvas, { flatten: true, noCache: true });
  const ocrMs1 = Date.now() - t0;
  const lines1 = mapToOcrLines(raw1.results, { width: canvas.width, height: canvas.height });
  const result1 = extractTotal(lines1);

  let finalResult = result1;
  let retried = false;
  let ocrMs2 = 0;
  if (result1.status !== "auto-high") {
    retried = true;
    const enhanced = enhanceContrast(canvas);
    const t1 = Date.now();
    const raw2 = await service.recognize(enhanced, { flatten: true, noCache: true });
    ocrMs2 = Date.now() - t1;
    const lines2 = mapToOcrLines(raw2.results, { width: enhanced.width, height: enhanced.height });
    const result2 = extractTotal(lines2);
    if (result2.status === "auto-high") finalResult = result2;
    else if (finalResult.status === "failed" && result2.status !== "failed") finalResult = result2;
  }

  return { finalResult, retried, ocrMs1, ocrMs2, lineCount1: lines1.length, canvasSize: { width: canvas.width, height: canvas.height } };
}

function rectArea(r) { return Math.max(0, r.width) * Math.max(0, r.height); }
function intersectionArea(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}
/** regionを最も対応するground truthレシートへ幾何的にマッチングする(グレーディングと同じ考え方)。 */
function matchRegionToReceipt(region, receipts) {
  let best = -1, bestScore = 0;
  receipts.forEach((gt, gi) => {
    const inter = intersectionArea(region, gt);
    const score = inter / Math.max(1, rectArea(gt));
    if (score > bestScore) { bestScore = score; best = gi; }
  });
  return best;
}

async function main() {
  const modelDir = path.join(projectRoot, "public", "models");
  const service = new PaddleOcrService({
    model: {
      detection: path.join(modelDir, "PP-OCRv6_small_det.ort"),
      recognition: path.join(modelDir, "PP-OCRv6_small_rec.ort"),
      charactersDictionary: path.join(modelDir, "ppocrv6_dict.txt"),
    },
  });
  console.error("initializing PaddleOcrService...");
  await service.initialize();

  const img = await loadImage(entry.path);
  console.error(`${entry.file}: ${entry.receipts.length} receipts, expected totals = ${entry.receipts.map((r) => r.expectedTotal).join(",")}`);

  // --- (a) 従来経路: 写真全体をrecognize ---
  const tA0 = Date.now();
  const { canvas: wholeCanvas } = drawScaledToLongEdge(img, RECOGNIZE_LONG_EDGE);
  const wholeResult = await recognizeAndExtract(service, wholeCanvas);
  const totalMsA = Date.now() - tA0;
  const matchedAny = entry.receipts.some((r) => r.expectedTotal === wholeResult.finalResult.amountYen);
  console.error(
    `(a) whole-photo: status=${wholeResult.finalResult.status} amount=${wholeResult.finalResult.amountYen} ` +
      `matchesAnyReceipt=${matchedAny} totalMs=${totalMsA}`,
  );

  // --- (b) 領域クロップ経路 ---
  const tB0 = Date.now();
  const { canvas: detectCanvas, scale: detectScale } = drawScaledToLongEdge(img, DETECT_LONG_EDGE, true);
  const { boxes } = await service.detect(detectCanvas, { paddingVertical: 0.1, paddingHorizontal: 0.15 });
  const boxesOriginalSpace = boxes.map((b) => ({ x: b.x / detectScale, y: b.y / detectScale, width: b.width / detectScale, height: b.height / detectScale }));
  const decision = buildLayoutDecision(boxesOriginalSpace, img.width, img.height);
  const detectMs = Date.now() - tB0;

  console.error(`(b) layout decision: kind=${decision.kind}`);
  const regions = decision.kind === "multiple" ? decision.regions : decision.kind === "single" ? [decision.region] : [decision.fallbackRegion];

  const perRegion = [];
  for (const region of regions) {
    const cropRect = cropRectForRegion(region, img.width, img.height);
    const tR0 = Date.now();
    const cropped = cropCanvas(img, cropRect);
    const { canvas: normalized } = drawScaledToLongEdge(cropped, RECOGNIZE_LONG_EDGE);
    const r = await recognizeAndExtract(service, normalized);
    const regionMs = Date.now() - tR0;
    const matchedReceiptIndex = matchRegionToReceipt(region, entry.receipts);
    const expected = matchedReceiptIndex >= 0 ? entry.receipts[matchedReceiptIndex].expectedTotal : null;
    const correct = expected !== null && r.finalResult.amountYen === expected;
    perRegion.push({
      cropRect,
      croppedSize: { width: cropped.width, height: cropped.height },
      normalizedSize: r.canvasSize,
      matchedReceiptIndex,
      expected,
      status: r.finalResult.status,
      amountYen: r.finalResult.amountYen,
      correct,
      regionMs,
      ocrMs1: r.ocrMs1,
      ocrMs2: r.ocrMs2,
      retried: r.retried,
    });
    console.error(
      `  region matched->receipt#${matchedReceiptIndex} expected=${expected} got=${r.finalResult.amountYen} ` +
        `status=${r.finalResult.status} correct=${correct} regionMs=${regionMs}`,
    );
  }
  const totalMsB = Date.now() - tB0;
  const successCountB = perRegion.filter((r) => r.correct && r.status === "auto-high").length;
  const successCountBAnyStatus = perRegion.filter((r) => r.correct).length;

  await service.destroy();

  const out = {
    file: entry.file,
    groundTruth: entry.receipts.map((r) => r.expectedTotal),
    approachA: {
      description: "whole-photo resize(1600)->recognize->extractTotal (1 result total)",
      status: wholeResult.finalResult.status,
      amountYen: wholeResult.finalResult.amountYen,
      matchesAnyReceipt: matchedAny,
      successCount: wholeResult.finalResult.status === "auto-high" && matchedAny ? 1 : 0,
      successCountAnyStatus: matchedAny ? 1 : 0,
      totalMs: totalMsA,
      detail: wholeResult,
    },
    approachB: {
      description: "detect(1200)->xycut->crop from original->normalize(1600)->recognize->extractTotal per region",
      decisionKind: decision.kind,
      regionCount: regions.length,
      detectMs,
      totalMs: totalMsB,
      successCount: successCountB,
      successCountAnyStatus: successCountBAnyStatus,
      perRegion,
    },
  };
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.error(`wrote ${args.out}`);
  }
  console.log(JSON.stringify({
    file: entry.file,
    expectedCount: entry.receipts.length,
    approachA_successCount: out.approachA.successCount,
    approachA_totalMs: out.approachA.totalMs,
    approachB_successCount: out.approachB.successCount,
    approachB_totalMs: out.approachB.totalMs,
  }, null, 2));
}

main().catch((err) => {
  console.error("run-per-region-ocr-compare failed:", err);
  process.exitCode = 1;
});
