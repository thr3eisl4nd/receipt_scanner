#!/usr/bin/env node
/**
 * v1.3検証スパイク用: `scripts/run-xycut-detect.mjs` が出力した検出box群
 * (detections.json)に対して再帰XY-cut(scripts/xycut.ts、コンパイル済み)を実行し、
 * 模擬マルチレシート写真の正解領域数(manifest.json のground truth)と突き合わせて
 * 精度(検出領域数の正解率・誤分割・誤結合)を計測する。
 *
 * OCRの`detect()`(重い処理)を再実行せず、閾値だけを変えて何度でも再計測できるように
 * detect()実行(run-xycut-detect.mjs)とグレーディング(本スクリプト)を分離してある
 * (§16.2「閾値は検証スパイク+実写真で調整」への対応)。
 *
 * 使い方:
 *   node scripts/measure-xycut-accuracy.mjs --detections <detections.json> \
 *     --xycutModule <compiled xycut.js path> [--thresholds <overrides.json>] [--verbose]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = argv[i + 1];
        i++;
      }
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.detections) throw new Error("--detections <detections.json> is required");
if (!args.xycutModule) throw new Error("--xycutModule <compiled xycut.js path> is required");

const { buildLayoutDecision, DEFAULT_THRESHOLDS } = await import(path.resolve(args.xycutModule));

const detectionsFile = JSON.parse(readFileSync(args.detections, "utf8"));
const manifest = JSON.parse(readFileSync(path.join(detectionsFile.imagesDir, "manifest.json"), "utf8"));
const manifestByFile = new Map(manifest.map((m) => [m.file, m]));

const thresholds = args.thresholds
  ? { ...DEFAULT_THRESHOLDS, ...JSON.parse(readFileSync(args.thresholds, "utf8")) }
  : DEFAULT_THRESHOLDS;

// 正解レシート矩形の面積のうち、検出領域と重なる割合がこれ以上なら「この領域はこの
// レシートを実質的にカバーしている」とみなす(誤結合の検知に使う: 1領域が複数の
// レシートをこの割合以上カバーしていれば誤結合)。
const GT_COVERAGE_THRESHOLD = 0.3;
// 検出領域の面積のうち、そのレシート矩形内にある割合がこれ以上なら「この領域は
// 実質的にこのレシートの断片」とみなす(誤分割の検知に使う: 小さい断片領域は
// レシート面積に対しては小さい割合しかカバーしないが、断片自身はほぼ全部が
// そのレシート内に収まっているはず)。
const REGION_CONTAINMENT_THRESHOLD = 0.5;

function rectArea(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}
function intersectionArea(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function gradeImage(det, manifestEntry, thresholds, verbose) {
  const decision = buildLayoutDecision(det.boxes, det.originalWidth, det.originalHeight, thresholds);
  let regions;
  let ambiguous = false;
  if (decision.kind === "single") regions = [decision.region];
  else if (decision.kind === "multiple") regions = decision.regions;
  else {
    regions = [decision.fallbackRegion];
    ambiguous = true;
  }

  const groundTruth = manifestEntry.receipts;
  // matched[i] = このregionが実質的に対応するground truthのインデックス群。
  // 「レシート面積の30%以上をこの領域がカバー」または「この領域自身の50%以上が
  // このレシート内に収まる」のどちらかを満たせば対応ありとみなす(前者は巨大な
  // 誤結合領域の検知、後者は小さい誤分割断片の検知に効く)。
  const matched = regions.map((region) => {
    const regionArea = Math.max(1, rectArea(region));
    const hits = [];
    groundTruth.forEach((gt, gi) => {
      const inter = intersectionArea(region, gt);
      const coverageOfReceipt = inter / Math.max(1, rectArea(gt));
      const containmentOfRegion = inter / regionArea;
      if (coverageOfReceipt >= GT_COVERAGE_THRESHOLD || containmentOfRegion >= REGION_CONTAINMENT_THRESHOLD) hits.push(gi);
    });
    return hits;
  });

  const cleanRegionsPerReceipt = groundTruth.map(() => 0);
  const mergeGroups = [];
  const unmatchedRegions = [];
  matched.forEach((hits, ri) => {
    if (hits.length === 0) unmatchedRegions.push(ri);
    else if (hits.length === 1) cleanRegionsPerReceipt[hits[0]]++;
    else mergeGroups.push(hits);
  });

  // missing: どの領域からも実質的な対応を得られなかった(matched配列のどこにも
  // 現れない)レシート。誤結合グループに含まれていれば「merge」側で説明済みなので
  // missingには含めない。
  const coveredReceipts = new Set(matched.flat());
  const overSplitReceipts = groundTruth.map((_, gi) => gi).filter((gi) => cleanRegionsPerReceipt[gi] >= 2);
  const missingReceipts = groundTruth.map((_, gi) => gi).filter((gi) => !coveredReceipts.has(gi));

  const correct =
    !ambiguous &&
    regions.length === manifestEntry.expectedRegionCount &&
    overSplitReceipts.length === 0 &&
    mergeGroups.length === 0 &&
    missingReceipts.length === 0 &&
    unmatchedRegions.length === 0;

  if (verbose) {
    console.error(
      `${det.file}: kind=${decision.kind} detected=${regions.length} expected=${manifestEntry.expectedRegionCount} ` +
        `correct=${correct} overSplit=${JSON.stringify(overSplitReceipts)} merge=${JSON.stringify(mergeGroups)} ` +
        `missing=${JSON.stringify(missingReceipts)} unmatchedRegions=${JSON.stringify(unmatchedRegions)}`,
    );
  }

  return {
    file: det.file,
    layout: det.layout,
    background: det.background,
    kind: decision.kind,
    ambiguous,
    expected: manifestEntry.expectedRegionCount,
    detected: regions.length,
    correct,
    overSplitReceipts,
    mergeGroups,
    missingReceipts,
    unmatchedRegions,
  };
}

function main() {
  const verbose = !!args.verbose;
  const graded = detectionsFile.results.map((det) => gradeImage(det, manifestByFile.get(det.file), thresholds, verbose));

  const total = graded.length;
  const correctCount = graded.filter((g) => g.correct).length;
  const overSplitCount = graded.reduce((sum, g) => sum + g.overSplitReceipts.length, 0);
  const misMergeCount = graded.reduce((sum, g) => sum + g.mergeGroups.length, 0);
  const missingCount = graded.reduce((sum, g) => sum + g.missingReceipts.length, 0);
  const ambiguousCount = graded.filter((g) => g.ambiguous).length;

  console.log("\n=== per-image ===");
  console.log(
    "file".padEnd(24) + "expected".padEnd(10) + "detected".padEnd(10) + "kind".padEnd(11) + "correct".padEnd(9) + "issues",
  );
  for (const g of graded) {
    const issues = [];
    if (g.overSplitReceipts.length) issues.push(`overSplit=${g.overSplitReceipts.length}`);
    if (g.mergeGroups.length) issues.push(`merge=${g.mergeGroups.length}`);
    if (g.missingReceipts.length) issues.push(`missing=${g.missingReceipts.length}`);
    if (g.unmatchedRegions.length) issues.push(`unmatchedRegion=${g.unmatchedRegions.length}`);
    console.log(
      g.file.padEnd(24) +
        String(g.expected).padEnd(10) +
        String(g.detected).padEnd(10) +
        g.kind.padEnd(11) +
        String(g.correct).padEnd(9) +
        issues.join(","),
    );
  }

  console.log("\n=== summary ===");
  console.log(`images: ${total}`);
  console.log(`correct (region count + 1:1 mapping): ${correctCount}/${total} (${((correctCount / total) * 100).toFixed(1)}%)`);
  console.log(`ambiguous fallback triggered: ${ambiguousCount}/${total}`);
  console.log(`total over-split receipts (1 receipt -> 2+ regions): ${overSplitCount}`);
  console.log(`total mis-merge events (2+ receipts -> 1 region): ${misMergeCount}`);
  console.log(`total missing receipts (not detected at all): ${missingCount}`);

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify({ thresholds, graded, summary: { total, correctCount, overSplitCount, misMergeCount, missingCount, ambiguousCount } }, null, 2),
    );
    console.error(`wrote ${args.out}`);
  }
}

main();
