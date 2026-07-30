#!/usr/bin/env node
/**
 * v1.3検証スパイク用: 模擬マルチレシート写真に対して `ppu-paddle-ocr` の検出専用API
 * `service.detect()` を実行するハーネス(使い捨て、CIには組み込まない、本番コード
 * 変更なし)。§16.1のパス1(長辺1200pxで検出専用実行)を再現する。
 *
 * 出力(detections.json)は検出box群を「元解像度(写真ピクセル)座標」へスケールし
 * 戻して保存する。これにより、再帰XY-cut(scripts/xycut.ts)の閾値調整・グレーディング
 * (scripts/measure-xycut-accuracy.mjs)は`detect()`を再実行せずに何度でも高速に
 * やり直せる(閾値調整ループのため、OCR実行=重い処理は1回に抑える)。
 *
 * 使い方:
 *   node scripts/run-xycut-detect.mjs --imagesDir <dir with manifest.json> --out <detections.json>
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
if (!args.out) throw new Error("--out <detections.json> is required");

const manifest = JSON.parse(readFileSync(path.join(args.imagesDir, "manifest.json"), "utf8"));

const DETECT_LONG_EDGE = 1200; // §16.1: パス1は長辺1200pxで検出専用実行

/** 長辺をtargetへ合わせて縮小したcanvasを作る(§16.1パス1相当)。 */
function drawScaledToLongEdge(image, targetLongEdge) {
  const scale = targetLongEdge / Math.max(image.width, image.height);
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return { canvas, scale };
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
  console.error("initializing PaddleOcrService (Node, onnxruntime-node)...");
  const t0 = Date.now();
  await service.initialize();
  console.error(`initialize() done in ${Date.now() - t0}ms`);

  const results = [];
  for (const entry of manifest) {
    const img = await loadImage(entry.path);
    const { canvas, scale } = drawScaledToLongEdge(img, DETECT_LONG_EDGE);

    const detectOptions = {};
    if (args.paddingVertical !== undefined) detectOptions.paddingVertical = Number(args.paddingVertical);
    if (args.paddingHorizontal !== undefined) detectOptions.paddingHorizontal = Number(args.paddingHorizontal);

    const tDetect0 = Date.now();
    const { boxes } = await service.detect(canvas, detectOptions);
    const detectMs = Date.now() - tDetect0;

    // 検出canvas座標 → 元写真ピクセル座標へスケールし戻す(以降の処理・比較は
    // 常に元解像度座標系で統一する)。
    const boxesOriginalSpace = boxes.map((b) => ({
      x: b.x / scale,
      y: b.y / scale,
      width: b.width / scale,
      height: b.height / scale,
    }));

    console.error(
      `${entry.file}: detect ${boxesOriginalSpace.length} boxes in ${detectMs}ms ` +
        `(detection canvas ${canvas.width}x${canvas.height}, expected regions=${entry.expectedRegionCount})`,
    );

    results.push({
      file: entry.file,
      layout: entry.layout,
      background: entry.background,
      originalWidth: entry.photoWidth,
      originalHeight: entry.photoHeight,
      detectionWidth: canvas.width,
      detectionHeight: canvas.height,
      detectMs,
      rawBoxCount: boxes.length,
      boxes: boxesOriginalSpace,
    });
  }

  await service.destroy();
  writeFileSync(args.out, JSON.stringify({ imagesDir: args.imagesDir, results }, null, 2));
  console.error(`wrote ${args.out} (${results.length} images)`);
}

main().catch((err) => {
  console.error("run-xycut-detect failed:", err);
  process.exitCode = 1;
});
