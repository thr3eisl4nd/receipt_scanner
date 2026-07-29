#!/usr/bin/env node
/**
 * OCR失敗調査用: 生成した劣化レシート画像を「本番と同じ経路」でNode実行する
 * ハーネス(使い捨て、CIには組み込まない)。
 *
 * 経路: loadAsCanvas相当(長辺maxEdgeへ縮小) → ppu-paddle-ocr(PP-OCRv6 small,
 * onnxruntime-node) → mapToOcrLines → extractTotal。needs-review/failed時は
 * src/ocr/queue.ts と同じ二段階再試行(enhanceContrast→再認識)も行う。
 *
 * extractTotal.ts/normalize.ts/mapRecognitionResult.ts はバンドラ前提の
 * 拡張子なしimportを使っており素のNode ESMでは解決できないため、事前に
 * `tsc --ignoreConfig` でプレーンJSへ変換したものをスクラッチパスから読み込む
 * (このリポジトリを変更せず済むよう、コンパイル成果物はscratchpad配下に置く)。
 *
 * 実行前提:
 *   npm install --no-save onnxruntime-node@1.23.2   (package.json/lock不変更)
 *   node scripts/run-degraded-ocr.mjs --manifest <manifest.json> --out <results.json>
 *
 * manifest.json の形:
 *   [{ "label": "baseline-1600", "image": "/path/to/img.jpg", "maxEdge": 1600 }, ...]
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

// コンパイル済みの純粋関数群(コンパイル手順は task-4-report.md 参照 + 本調査で追加)。
// COMPILED_DIR 環境変数でscratchpad配下の場所を指定する。
const compiledDir = process.env.COMPILED_DIR;
if (!compiledDir) throw new Error("COMPILED_DIR env var (scratchpad compiled output) is required");
const { extractTotal } = await import(path.join(compiledDir, "extract/extract/extractTotal.js"));
const { mapToOcrLines } = await import(path.join(compiledDir, "ocr/mapRecognitionResult.js"));

/** src/image/preprocess.ts の drawScaled 相当(長辺maxEdgeへの縮小)。 */
function drawScaled(image, width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

/** src/image/preprocess.ts の enhanceContrast を素のNode Canvas APIへ移植したもの(同一アルゴリズム)。 */
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

function summarizeLines(lines) {
  if (lines.length === 0) return { count: 0, avgConfidence: null, minConfidence: null, maxConfidence: null };
  const confs = lines.map((l) => l.confidence);
  return {
    count: lines.length,
    avgConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
    minConfidence: Math.min(...confs),
    maxConfidence: Math.max(...confs),
  };
}

/**
 * Phase 3 仮説C(コントラスト再試行の条件を絞る)用のゲート判定。
 * 「1回目の認識行数が閾値未満 or 全行confidenceが低い場合のみ」再試行する。
 * `retryGate`未指定(null)なら本番と同じ「auto-high以外は常に再試行」を維持する。
 */
function shouldRetry(result1, lineSummary1, retryGate) {
  if (result1.status === "auto-high") return false; // 本番と同じ: 既に成功なら再試行しない
  if (!retryGate) return true; // ゲートなし = 本番と同じ常時再試行
  const sparse = lineSummary1.count < retryGate.lineThreshold;
  // 「全行confidenceが低い」の代理指標。confStat="max"なら「最良の1行すら低い」、
  // confStat="avg"(デフォルト)なら「平均的に低い」で判定する。footer等の
  // 読みやすい行が1つでもあると最良行のconfidenceは高くなりがちなため、
  // 平均のほうが「全体的に読みにくい」という意図に近いと考えられる。
  const stat = retryGate.confStat === "max" ? lineSummary1.maxConfidence : lineSummary1.avgConfidence;
  const uniformlyLow = (stat ?? 0) < retryGate.maxConfThreshold;
  return sparse || uniformlyLow;
}

async function runOne(service, entry, retryGate) {
  const { label, image: imagePath, maxEdge } = entry;
  const img = await loadImage(imagePath);
  const t0 = Date.now();
  const canvas = drawScaled(img, img.width, img.height, maxEdge ?? 1600);
  const resizeMs = Date.now() - t0;

  const t1 = Date.now();
  const raw1 = await service.recognize(canvas, { flatten: true, noCache: true });
  const ocrMs1 = Date.now() - t1;
  const lines1 = mapToOcrLines(raw1.results, { width: canvas.width, height: canvas.height });
  const result1 = extractTotal(lines1);
  const lineSummary1 = summarizeLines(lines1);
  const maxConfidence1 = lineSummary1.maxConfidence ?? 0;

  let finalResult = result1;
  let attempt2 = null;
  const retried = shouldRetry(result1, lineSummary1, retryGate);
  if (retried) {
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
    maxConfidence1,
    retried,
    originalSize: { width: img.width, height: img.height },
    resizedSize: { width: canvas.width, height: canvas.height },
    resizeMs,
    attempt1: {
      ocrMs: ocrMs1,
      lineSummary: summarizeLines(lines1),
      lines: lines1,
      result: result1,
    },
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

  console.error("initializing PaddleOcrService (Node, onnxruntime-node)...");
  const initT0 = Date.now();
  await service.initialize();
  const initMs = Date.now() - initT0;
  console.error(`initialize() done in ${initMs}ms`);

  // Phase 3 仮説C: --lineThreshold/--maxConfThreshold のどちらかが指定されたら
  // 再試行ゲートを有効化する(未指定なら本番と同じ常時再試行、後方互換)。
  const retryGate =
    args.lineThreshold !== undefined || args.maxConfThreshold !== undefined
      ? {
          lineThreshold: Number(args.lineThreshold ?? 15),
          maxConfThreshold: Number(args.maxConfThreshold ?? 0.85),
          confStat: args.confStat ?? "avg",
        }
      : null;
  if (retryGate) console.error(`retry gate enabled: ${JSON.stringify(retryGate)}`);

  const results = [];
  for (const entry of manifest) {
    console.error(`running: ${entry.label} (maxEdge=${entry.maxEdge ?? 1600})...`);
    const r = await runOne(service, entry, retryGate);
    console.error(
      `  -> lines=${r.attempt1.lineSummary.count} avgConf=${r.attempt1.lineSummary.avgConfidence?.toFixed(3)} ` +
        `maxConf=${r.maxConfidence1.toFixed(3)} retried=${r.retried} ` +
        `status(1st)=${r.attempt1.result.status} amount(1st)=${r.attempt1.result.amountYen} ` +
        `final status=${r.finalResult.status} final amount=${r.finalResult.amountYen} totalMs=${r.totalMs}`,
    );
    results.push(r);
  }

  await service.destroy();

  const out = { initMs, retryGate, results };
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.error(`wrote ${args.out}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err) => {
  console.error("run-degraded-ocr failed:", err);
  process.exitCode = 1;
});
