#!/usr/bin/env node
/**
 * v1.3検証スパイク用: 1枚の写真に複数レシートを並べた模擬画像の生成器
 * (使い捨て、CIには組み込まない、本番コードは変更しない)。
 *
 * `scripts/generate-degraded-receipt.mjs`(単一レシート・劣化シミュレーション)を
 * 拡張し、§16(複数レシートの自動分割)の検証スパイク用に、1枚の写真(3024×4032相当)
 * へ複数レシート(2/4/6/8枚のグリッド・互い違い5枚・上段横長1+下段2)を配置する。
 * 各レシートは内容(行数・金額)を変え、木目風/白テーブル風の2背景、軽い回転(±2度)・
 * 軽い影を付ける。
 *
 * 出力: --outDir 配下に <layout>-<background>.jpg を書き出し、
 * manifest.json に各画像のレイアウト名・背景・各レシートの正解矩形(回転前、
 * 最終写真ピクセル座標)・回転角・内容バリアント番号・正解合計金額を記録する
 * (精度計測・per-region OCR比較のground truthとして使う)。
 *
 * 使い方: node scripts/generate-multi-receipt.mjs --outDir <dir> [--seed 1]
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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
const outDir = args.outDir ?? (() => { throw new Error("--outDir <dir> is required"); })();
const seedBase = Number(args.seed ?? 1);
mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fontFamily = GlobalFonts.families.some((f) => f.family === "Hiragino Sans") ? "Hiragino Sans" : "sans-serif";

const PHOTO_W = 3024;
const PHOTO_H = 4032;

// ---------------------------------------------------------------------------
// コンテンツバリアント(店名・行数・金額を変えた8種。互いに合計金額が異なる
// ことがper-region OCR比較(仮説5)の正解判定に必要)。
// ---------------------------------------------------------------------------
const CONTENT_VARIANTS = [
  { store: "コンビニあおぞら", date: "2026/07/27 18:23", items: [["おにぎり", 150], ["お茶", 138], ["サンドイッチ", 320], ["コーヒー", 180]], tender: 1000 },
  { store: "スーパーやまと", date: "2026/07/20 11:05", items: [["弁当", 480], ["からあげ", 258], ["サラダ", 180], ["お茶", 150], ["プリン", 220], ["ガム", 120]], tender: 1500 },
  { store: "カフェことり", date: "2026/07/22 14:40", items: [["コーヒー", 320], ["ケーキ", 480], ["水", 108]], tender: 1000 },
  { store: "定食屋ふたば", date: "2026/07/15 12:30", items: [["牛乳", 198], ["食パン", 158], ["卵", 228], ["バター", 398], ["ヨーグルト", 168]], tender: 2000 },
  { store: "ドラッグストアみどり", date: "2026/07/18 19:10", items: [["ラーメン", 780], ["餃子", 320], ["ビール", 480], ["お通し", 300]], tender: 2000 },
  { store: "文具の店つばめ", date: "2026/07/25 10:15", items: [["文房具A", 120], ["文房具B", 98], ["ノート", 150], ["消しゴム", 68], ["定規", 108], ["クリップ", 88], ["付箋", 198]], tender: 1000 },
  { store: "ベーカリーひかり", date: "2026/07/26 09:00", items: [["コーヒー", 280], ["ドーナツ", 180], ["ジュース", 150]], tender: 700 },
  { store: "やおやたけした", date: "2026/07/19 16:45", items: [["洗剤", 398], ["柔軟剤", 328], ["スポンジ", 128], ["ラップ", 258], ["ゴミ袋", 198]], tender: 1500 },
];

/**
 * 横長(h/w<1)スロット専用の短いバリアント(品目2点)。横長スロットは高さの余裕が
 * 小さいため、通常バリアントのまま幅基準フォントサイズを使うと内容が高さに収まらない
 * (フォントサイズを大幅に縮小する必要がある)。品目数自体を減らすことで、フォント
 * サイズの縮小幅を抑えつつ実際の短いレシート(数点だけ購入)らしい見た目にする。
 */
const SHORT_VARIANT = { store: "ベーカリーひかり", date: "2026/07/26 09:00", items: [["コーヒー", 280], ["ドーナツ", 180]], tender: 500 };

function totalOf(variant) {
  return variant.items.reduce((sum, [, amount]) => sum + amount, 0);
}

/**
 * レシートの内容行数(店名・日付・区切り線・品目N行・小計・合計・お預り・お釣り・
 * 挨拶)からおおよその総行ユニット数を見積もる(フォントサイズの高さ制約算出用)。
 */
function estimateTotalLineUnits(itemCount) {
  return itemCount + 11;
}

/** レシート本体を、指定した見かけサイズ(width×height)で直接描画する。 */
function renderReceiptContent(width, height, textColor, variant, rand) {
  const canvas = createCanvas(Math.round(width), Math.round(height));
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f2ecd9";
  ctx.fillRect(0, 0, width, height);

  const paperNoise = ctx.getImageData(0, 0, Math.round(width), Math.round(height));
  const pd = paperNoise.data;
  for (let i = 0; i < pd.length; i += 4) {
    const n = (rand() - 0.5) * 10;
    pd[i] = Math.max(0, Math.min(255, pd[i] + n));
    pd[i + 1] = Math.max(0, Math.min(255, pd[i + 1] + n));
    pd[i + 2] = Math.max(0, Math.min(255, pd[i + 2] + n));
  }
  ctx.putImageData(paperNoise, 0, 0);

  ctx.fillStyle = textColor;
  ctx.textBaseline = "alphabetic";

  const marginX = width * 0.08;
  const amountX = width * 0.55;
  // フォントサイズは通常「幅」基準(既存の単一レシート生成器と同じ見た目を維持)だが、
  // 横長スロット(上段横長1枚)では幅基準のサイズだと内容が高さに収まらずクリップされる
  // ため、「この行数がheight内に収まる」最大サイズでも制約し、小さいほうを採用する。
  const totalLineUnits = estimateTotalLineUnits(variant.items.length);
  const bodySizeByWidth = width * 0.048;
  const bodySizeByHeight = (height * 0.92) / (1.55 * totalLineUnits + 2);
  const bodySize = Math.max(10, Math.round(Math.min(bodySizeByWidth, bodySizeByHeight)));
  const headerSize = Math.round(bodySize * 1.29);
  let y = height * 0.05 + headerSize;

  ctx.font = `bold ${headerSize}px "${fontFamily}"`;
  ctx.fillText(variant.store, marginX, y);
  y += headerSize * 1.5;

  ctx.font = `${Math.round(bodySize * 0.85)}px "${fontFamily}"`;
  ctx.fillText(variant.date, marginX, y);
  y += bodySize * 1.7;

  ctx.font = `${bodySize}px "${fontFamily}"`;
  const dashLine = () => {
    ctx.save();
    ctx.strokeStyle = textColor;
    ctx.lineWidth = Math.max(1, width * 0.002);
    ctx.setLineDash([width * 0.01, width * 0.01]);
    ctx.beginPath();
    ctx.moveTo(marginX, y - bodySize * 0.5);
    ctx.lineTo(width - marginX, y - bodySize * 0.5);
    ctx.stroke();
    ctx.restore();
    y += bodySize * 1.45;
  };
  const row = (label, amount, bold = false) => {
    ctx.font = `${bold ? "bold " : ""}${bold ? Math.round(bodySize * 1.05) : bodySize}px "${fontFamily}"`;
    ctx.fillText(label, marginX, y);
    if (amount !== undefined) ctx.fillText(amount, amountX, y);
    y += bodySize * 1.5;
  };

  dashLine();
  for (const [label, amount] of variant.items) row(label, `¥${amount}`);
  const total = totalOf(variant);
  dashLine();
  row("小計", `¥${total}`);
  dashLine();
  row("合計", `¥${total}`, true);
  const change = variant.tender - total;
  row("お預り", `¥${variant.tender}`);
  row("お釣り", `¥${Math.max(0, change)}`);
  dashLine();
  ctx.font = `${Math.round(bodySize * 0.85)}px "${fontFamily}"`;
  ctx.fillText("ありがとうございました", marginX, y);

  return { canvas, total };
}

/** 木目/白テーブル風の背景を生成する。 */
function renderBackground(width, height, kind, rand) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  if (kind === "wood") {
    ctx.fillStyle = "#8a6a48";
    ctx.fillRect(0, 0, width, height);
    for (let x = 0; x < width; x += 3) {
      const grain = Math.sin(x * 0.02) * 10 + Math.sin(x * 0.005 + 3) * 14;
      ctx.fillStyle = `rgba(${60 + grain},${40 + grain * 0.7},${20 + grain * 0.4},0.35)`;
      ctx.fillRect(x, 0, 3, height);
    }
  } else {
    // table: 白テーブル風(淡いオフホワイト、木目より低振幅のうっすらした縞)。
    ctx.fillStyle = "#e9e7e0";
    ctx.fillRect(0, 0, width, height);
    for (let y = 0; y < height; y += 4) {
      const streak = Math.sin(y * 0.01) * 4 + Math.sin(y * 0.003 + 1.5) * 3;
      ctx.fillStyle = `rgba(${200 + streak},${198 + streak},${190 + streak},0.25)`;
      ctx.fillRect(0, y, width, 4);
    }
  }

  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const noiseAmp = kind === "wood" ? 28 : 14;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * noiseAmp;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** rows×colsのグリッド矩形群(中心cx,cy・幅w・高さh、写真ピクセル座標)を計算する。 */
function gridSlots(rows, cols, { marginXFrac, marginYFrac, gutterXFrac, gutterYFrac, aspect, slack = 0.9 }) {
  const marginX = PHOTO_W * marginXFrac;
  const marginY = PHOTO_H * marginYFrac;
  const gutterX = PHOTO_W * gutterXFrac;
  const gutterY = PHOTO_H * gutterYFrac;
  const cellW = (PHOTO_W - 2 * marginX - (cols - 1) * gutterX) / cols;
  const cellH = (PHOTO_H - 2 * marginY - (rows - 1) * gutterY) / rows;
  let w = cellW * slack;
  let h = w * aspect;
  if (h > cellH * slack) {
    h = cellH * slack;
    w = h / aspect;
  }
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = marginX + c * (cellW + gutterX) + cellW / 2;
      const cy = marginY + r * (cellH + gutterY) + cellH / 2;
      slots.push({ cx, cy, w, h });
    }
  }
  return slots;
}

function staggered5Slots() {
  // 左3枚(縦に3段)・右2枚(左の段間を埋めるように互い違いに配置)。
  const marginXFrac = 0.05, marginYFrac = 0.04, gutterXFrac = 0.08, gutterYFrac = 0.03;
  const marginX = PHOTO_W * marginXFrac, marginY = PHOTO_H * marginYFrac;
  const gutterX = PHOTO_W * gutterXFrac, gutterY = PHOTO_H * gutterYFrac;
  const cellW = (PHOTO_W - 2 * marginX - gutterX) / 2;
  const cellH = (PHOTO_H - 2 * marginY - 2 * gutterY) / 3;
  const aspect = 1.45, slack = 0.85;
  let w = cellW * slack;
  let h = w * aspect;
  if (h > cellH * slack) { h = cellH * slack; w = h / aspect; }

  const leftCx = marginX + cellW / 2;
  const rightCx = marginX + cellW + gutterX + cellW / 2;
  const leftCy = [0, 1, 2].map((r) => marginY + r * (cellH + gutterY) + cellH / 2);
  const rightCy = [(leftCy[0] + leftCy[1]) / 2, (leftCy[1] + leftCy[2]) / 2];

  return [
    { cx: leftCx, cy: leftCy[0], w, h },
    { cx: leftCx, cy: leftCy[1], w, h },
    { cx: leftCx, cy: leftCy[2], w, h },
    { cx: rightCx, cy: rightCy[0], w, h },
    { cx: rightCx, cy: rightCy[1], w, h },
  ];
}

function wideTopSlots() {
  // 上段: 横長1枚(ほぼ全幅)。下段: 通常の縦長2枚(横並び)。
  const marginXFrac = 0.06, topMarginYFrac = 0.05, gutterYFrac = 0.05, bottomMarginYFrac = 0.05;
  const marginX = PHOTO_W * marginXFrac;
  const topMarginY = PHOTO_H * topMarginYFrac;
  const gutterY = PHOTO_H * gutterYFrac;
  const bottomMarginY = PHOTO_H * bottomMarginYFrac;

  const topW = PHOTO_W - 2 * marginX;
  const topAspect = 0.5; // 横長(h/w<1)
  const topH = topW * topAspect;
  const topCx = PHOTO_W / 2;
  const topCy = topMarginY + topH / 2;

  const bottomAreaTop = topMarginY + topH + gutterY;
  const bottomAreaHeight = PHOTO_H - bottomAreaTop - bottomMarginY;

  const bottomMarginXFrac = 0.08, bottomGutterXFrac = 0.1;
  const bMarginX = PHOTO_W * bottomMarginXFrac, bGutterX = PHOTO_W * bottomGutterXFrac;
  const bCellW = (PHOTO_W - 2 * bMarginX - bGutterX) / 2;
  const bottomAspect = 1.8, slack = 0.9;
  let bw = bCellW * slack;
  let bh = bw * bottomAspect;
  if (bh > bottomAreaHeight * slack) { bh = bottomAreaHeight * slack; bw = bh / bottomAspect; }
  const bCy = bottomAreaTop + bottomAreaHeight / 2;
  const bCxLeft = bMarginX + bCellW / 2;
  const bCxRight = bMarginX + bCellW + bGutterX + bCellW / 2;

  return [
    { cx: topCx, cy: topCy, w: topW, h: topH },
    { cx: bCxLeft, cy: bCy, w: bw, h: bh },
    { cx: bCxRight, cy: bCy, w: bw, h: bh },
  ];
}

const LAYOUTS = {
  "pair-2": { slots: () => gridSlots(1, 2, { marginXFrac: 0.08, marginYFrac: 0.12, gutterXFrac: 0.1, gutterYFrac: 0, aspect: 1.8 }), shortSlots: [] },
  "grid-2x2": { slots: () => gridSlots(2, 2, { marginXFrac: 0.05, marginYFrac: 0.05, gutterXFrac: 0.07, gutterYFrac: 0.05, aspect: 1.6 }), shortSlots: [] },
  "grid-2x3": { slots: () => gridSlots(3, 2, { marginXFrac: 0.05, marginYFrac: 0.04, gutterXFrac: 0.07, gutterYFrac: 0.035, aspect: 1.35 }), shortSlots: [] },
  "grid-2x4": { slots: () => gridSlots(4, 2, { marginXFrac: 0.05, marginYFrac: 0.04, gutterXFrac: 0.06, gutterYFrac: 0.025, aspect: 1.05 }), shortSlots: [] },
  "staggered-5": { slots: staggered5Slots, shortSlots: [] },
  // slot 0 = 上段の横長1枚。高さの余裕が小さいためSHORT_VARIANT(品目2点)を使う。
  "wide-top-2": { slots: wideTopSlots, shortSlots: [0] },
};

/** ground truth用: 任意2矩形の最小ギャップ(px、負なら重なり)を計算する。 */
function minGap(a, b) {
  const ax0 = a.cx - a.w / 2, ax1 = a.cx + a.w / 2, ay0 = a.cy - a.h / 2, ay1 = a.cy + a.h / 2;
  const bx0 = b.cx - b.w / 2, bx1 = b.cx + b.w / 2, by0 = b.cy - b.h / 2, by1 = b.cy + b.h / 2;
  const gapX = Math.max(ax0 - bx1, bx0 - ax1);
  const gapY = Math.max(ay0 - by1, by0 - ay1);
  // 矩形同士がX方向かY方向のどちらかで完全に分離していればそちらのgapが実効ギャップ。
  return Math.max(gapX, gapY);
}

function composeImage(layoutName, background, seed) {
  const rand = mulberry32(seed);
  const { slots: slotsFn, shortSlots } = LAYOUTS[layoutName];
  const slots = slotsFn();

  // sanity check: すべての矩形ペアが正のギャップを持つこと(レイアウト定義のバグ検知用)。
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const gap = minGap(slots[i], slots[j]);
      if (gap <= 0) {
        throw new Error(`layout ${layoutName}: slots ${i},${j} overlap or touch (gap=${gap.toFixed(1)}px)`);
      }
    }
  }

  const bg = renderBackground(PHOTO_W, PHOTO_H, background, rand);
  const composed = createCanvas(PHOTO_W, PHOTO_H);
  const ctx = composed.getContext("2d");
  ctx.drawImage(bg, 0, 0);

  const receipts = [];
  slots.forEach((slot, i) => {
    const variant = shortSlots.includes(i) ? SHORT_VARIANT : CONTENT_VARIANTS[i % CONTENT_VARIANTS.length];
    const { canvas: receiptCanvas, total } = renderReceiptContent(slot.w, slot.h, "#3d3d3d", variant, rand);
    const rotationDeg = (rand() - 0.5) * 4; // ±2度

    ctx.save();
    ctx.translate(slot.cx, slot.cy);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    // 軽い影
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.filter = "blur(10px)";
    ctx.fillRect(-slot.w / 2 + 5, -slot.h / 2 + 7, slot.w, slot.h);
    ctx.restore();
    ctx.drawImage(receiptCanvas, -slot.w / 2, -slot.h / 2, slot.w, slot.h);
    ctx.restore();

    receipts.push({
      // ground truth(回転前、写真ピクセル座標)
      x: slot.cx - slot.w / 2,
      y: slot.cy - slot.h / 2,
      width: slot.w,
      height: slot.h,
      rotationDeg,
      variantIndex: i % CONTENT_VARIANTS.length,
      store: variant.store,
      expectedTotal: total,
    });
  });

  // 全体に軽いブラー(手ブレ相当)。
  const finalCanvas = createCanvas(PHOTO_W, PHOTO_H);
  const fctx = finalCanvas.getContext("2d");
  fctx.filter = "blur(1.0px)";
  fctx.drawImage(composed, 0, 0);

  return { canvas: finalCanvas, receipts };
}

function main() {
  const manifest = [];
  const backgrounds = ["wood", "table"];
  let seed = seedBase;
  for (const layoutName of Object.keys(LAYOUTS)) {
    for (const background of backgrounds) {
      seed += 1;
      const { canvas, receipts } = composeImage(layoutName, background, seed);
      const fileName = `${layoutName}-${background}.jpg`;
      const filePath = path.join(outDir, fileName);
      const buf = canvas.toBuffer("image/jpeg", 0.85);
      writeFileSync(filePath, buf);
      manifest.push({
        file: fileName,
        path: filePath,
        layout: layoutName,
        background,
        seed,
        photoWidth: PHOTO_W,
        photoHeight: PHOTO_H,
        expectedRegionCount: receipts.length,
        receipts,
      });
      console.log(`wrote ${fileName} (${receipts.length} receipts, ${buf.length} bytes)`);
    }
  }
  const manifestPath = path.join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`wrote ${manifestPath} (${manifest.length} images)`);
}

main();
