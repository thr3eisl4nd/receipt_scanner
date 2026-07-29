#!/usr/bin/env node
/**
 * Phase 3 仮説B(レシート領域の自動クロップ+拡大)検証用ハーネス(使い捨て、CI非組み込み)。
 * 本番コードは変更していない(src/image/preprocess.ts 等は一切変更なし)。
 *
 * 経路: loadAsCanvas相当(長辺maxEdge=1600へ縮小, 本番と同一) →
 *   autoCropAndUpscale(明度しきい値→最大の明るい連結領域のbbox→マージン付きクロップ→
 *   長辺targetLongEdgeへ拡大、外部依存なしのcanvasピクセル操作のみ) →
 *   ppu-paddle-ocr → mapToOcrLines → extractTotal(本番の実ソースをコンパイルしたもの) →
 *   (必要なら)enhanceContrast再試行。
 *
 * 実行前提: scripts/run-degraded-ocr.mjsと同じ(onnxruntime-node --no-save、COMPILED_DIR環境変数)。
 *
 * 使い方: COMPILED_DIR=<dir> node scripts/run-crop-ocr.mjs --manifest <manifest.json> --out <out.json>
 * manifest.json: [{ "label": "...", "image": "path.jpg", "maxEdge": 1600, "cropTargetEdge": 1800 }, ...]
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
if (!args.manifest) throw new Error("--manifest <manifest.json> is required");
const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));

const compiledDir = process.env.COMPILED_DIR;
if (!compiledDir) throw new Error("COMPILED_DIR env var is required");
const { extractTotal } = await import(path.join(compiledDir, "extract/extract/extractTotal.js"));
const { mapToOcrLines } = await import(path.join(compiledDir, "ocr/mapRecognitionResult.js"));

function drawScaled(image, width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

function enhanceContrast(src) {
  const canvas = createCanvas(src.width, src.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let min = 255,
    max = 0;
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

/** Otsuの2値化しきい値を輝度ヒストグラムから求める。 */
function otsuThreshold(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    varMax = 0,
    threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 外部依存なしのcanvasピクセル操作のみで、最大の明るい連結領域のbboxを求める。
 * 解析は縮小サムネイル(analysisWidth)上で行い(速度・ノイズ耐性のため)、
 * 結果を元canvas座標へスケールし戻す。
 */
function findBrightestRegionBBox(canvas, analysisWidth = 200) {
  const scale = analysisWidth / canvas.width;
  const aw = analysisWidth;
  const ah = Math.max(1, Math.round(canvas.height * scale));
  const small = createCanvas(aw, ah);
  const sctx = small.getContext("2d");
  sctx.drawImage(canvas, 0, 0, aw, ah);
  const img = sctx.getImageData(0, 0, aw, ah);
  const d = img.data;

  const lum = new Uint8ClampedArray(aw * ah);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    lum[p] = g;
    hist[g]++;
  }
  const threshold = otsuThreshold(hist, aw * ah);

  const mask = new Uint8Array(aw * ah);
  for (let p = 0; p < lum.length; p++) mask[p] = lum[p] > threshold ? 1 : 0;

  // 4連結の連結成分をBFSで求め、最大面積のものを選ぶ。
  const visited = new Uint8Array(aw * ah);
  let best = null;
  const stack = new Int32Array(aw * ah);
  for (let start = 0; start < aw * ah; start++) {
    if (mask[start] !== 1 || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = aw,
      maxX = -1,
      minY = ah,
      maxY = -1,
      area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % aw;
      const y = (idx / aw) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= aw || ny < 0 || ny >= ah) continue;
        const nIdx = ny * aw + nx;
        if (mask[nIdx] === 1 && !visited[nIdx]) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
    }
    if (best === null || area > best.area) {
      best = { minX, maxX, minY, maxY, area };
    }
  }
  if (best === null) return null;

  return {
    x: best.minX / scale,
    y: best.minY / scale,
    width: (best.maxX - best.minX + 1) / scale,
    height: (best.maxY - best.minY + 1) / scale,
    areaFraction: best.area / (aw * ah),
    threshold,
  };
}

/** 明るい連結領域をマージン付きでクロップし、長辺targetEdgeへ拡大する。 */
function autoCropAndUpscale(canvas, targetEdge, marginRatio = 0.04) {
  const bbox = findBrightestRegionBBox(canvas);
  if (bbox === null) return { canvas, bbox: null, cropped: false };

  const marginX = bbox.width * marginRatio;
  const marginY = bbox.height * marginRatio;
  const sx = Math.max(0, Math.floor(bbox.x - marginX));
  const sy = Math.max(0, Math.floor(bbox.y - marginY));
  const ex = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width + marginX));
  const ey = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height + marginY));
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return { canvas, bbox, cropped: false };

  const scale = targetEdge / Math.max(sw, sh);
  const dw = Math.round(sw * Math.max(1, scale));
  const dh = Math.round(sh * Math.max(1, scale));
  const out = createCanvas(dw, dh);
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, dw, dh);

  return { canvas: out, bbox: { sx, sy, sw, sh }, cropped: true };
}

/**
 * 検出(bbox特定)はmaxEdge=1600の縮小canvas上で行うが、実際のクロップは
 * リサイズ前の元画像(sourceImage、フルネイティブ解像度)から直接切り出す変種。
 * 「縮小画像でクロップ」(既にブラー/圧縮で失われた画素を拡大するだけ)ではなく、
 * 「検出だけ縮小画像で行い、切り出しは元の高解像度ソースから行う」ことで、
 * 撮影時点でまだ残っていたはずの高周波成分を活かせるかを比較検証する。
 */
function autoCropAndUpscaleFromSource(detectionCanvas, sourceImage, targetEdge, marginRatio = 0.04) {
  const bbox = findBrightestRegionBBox(detectionCanvas);
  if (bbox === null) return { canvas: detectionCanvas, bbox: null, cropped: false };

  const scaleToSource = sourceImage.width / detectionCanvas.width;
  const marginX = bbox.width * marginRatio;
  const marginY = bbox.height * marginRatio;
  const sx = Math.max(0, Math.floor((bbox.x - marginX) * scaleToSource));
  const sy = Math.max(0, Math.floor((bbox.y - marginY) * scaleToSource));
  const ex = Math.min(sourceImage.width, Math.ceil((bbox.x + bbox.width + marginX) * scaleToSource));
  const ey = Math.min(sourceImage.height, Math.ceil((bbox.y + bbox.height + marginY) * scaleToSource));
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return { canvas: detectionCanvas, bbox, cropped: false };

  // 元画像からの切り出しは既にtargetEdgeより大きいことが多いため、ここでは
  // (crop-from-resized版と異なり)拡大方向にクランプしない。目標の長辺に
  // 実際に合わせる(必要なら縮小も行う)ことで「maxEdge相当の画素数をフレーム
  // 全体でなくレシート領域だけに配分したら」という仮説を素直に検証する。
  const scale = targetEdge / Math.max(sw, sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const out = createCanvas(dw, dh);
  const ctx = out.getContext("2d");
  ctx.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, dw, dh);

  return { canvas: out, bbox: { sx, sy, sw, sh }, cropped: true };
}

function summarizeLines(lines) {
  if (lines.length === 0) return { count: 0, avgConfidence: null, minConfidence: null };
  const confs = lines.map((l) => l.confidence);
  return {
    count: lines.length,
    avgConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
    minConfidence: Math.min(...confs),
  };
}

async function runOne(service, entry) {
  const { label, image: imagePath, maxEdge, cropTargetEdge, cropFromOriginal } = entry;
  const img = await loadImage(imagePath);

  const t0 = Date.now();
  const resized = drawScaled(img, img.width, img.height, maxEdge ?? 1600);
  const resizeMs = Date.now() - t0;

  const tCrop0 = Date.now();
  const { canvas, bbox, cropped } = cropFromOriginal
    ? autoCropAndUpscaleFromSource(resized, img, cropTargetEdge ?? 1800)
    : autoCropAndUpscale(resized, cropTargetEdge ?? 1800);
  const cropMs = Date.now() - tCrop0;

  const t1 = Date.now();
  const raw1 = await service.recognize(canvas, { flatten: true, noCache: true });
  const ocrMs1 = Date.now() - t1;
  const lines1 = mapToOcrLines(raw1.results, { width: canvas.width, height: canvas.height });
  const result1 = extractTotal(lines1);

  let finalResult = result1;
  let attempt2 = null;
  if (result1.status !== "auto-high") {
    const enhanced = enhanceContrast(canvas);
    const t2 = Date.now();
    const raw2 = await service.recognize(enhanced, { flatten: true, noCache: true });
    const ocrMs2 = Date.now() - t2;
    const lines2 = mapToOcrLines(raw2.results, { width: enhanced.width, height: enhanced.height });
    const result2 = extractTotal(lines2);
    attempt2 = { ocrMs: ocrMs2, lines: lines2, result: result2 };
    if (result2.status === "auto-high") finalResult = result2;
  }

  const totalMs = Date.now() - t0;

  return {
    label,
    imagePath,
    maxEdge: maxEdge ?? 1600,
    cropTargetEdge: cropTargetEdge ?? 1800,
    cropFromOriginal: !!cropFromOriginal,
    resizedSize: { width: resized.width, height: resized.height },
    cropped,
    bbox,
    croppedSize: { width: canvas.width, height: canvas.height },
    resizeMs,
    cropMs,
    attempt1: { ocrMs: ocrMs1, lineSummary: summarizeLines(lines1), lines: lines1, result: result1 },
    attempt2,
    finalResult,
    totalMs,
  };
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
  const initT0 = Date.now();
  await service.initialize();
  console.error(`initialize() done in ${Date.now() - initT0}ms`);

  const results = [];
  for (const entry of manifest) {
    console.error(`running: ${entry.label} (maxEdge=${entry.maxEdge ?? 1600}, cropTargetEdge=${entry.cropTargetEdge ?? 1800})...`);
    const r = await runOne(service, entry);
    console.error(
      `  -> cropped=${r.cropped} croppedSize=${r.croppedSize.width}x${r.croppedSize.height} ` +
        `lines=${r.attempt1.lineSummary.count} avgConf=${r.attempt1.lineSummary.avgConfidence?.toFixed(3)} ` +
        `status(1st)=${r.attempt1.result.status} amount(1st)=${r.attempt1.result.amountYen} ` +
        `final=${r.finalResult.status} amountFinal=${r.finalResult.amountYen} totalMs=${r.totalMs} (resize=${r.resizeMs}ms crop=${r.cropMs}ms)`,
    );
    results.push(r);
  }

  await service.destroy();
  const out = { results };
  writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.error(`wrote ${args.out}`);
}

main().catch((err) => {
  console.error("run-crop-ocr failed:", err);
  process.exitCode = 1;
});
