#!/usr/bin/env node
/**
 * OCR失敗調査用: スマホ写真を模した劣化レシート画像の生成器(使い捨て、CIには組み込まない)。
 *
 * 目的: 合成レシート画像(400×560px、クリーンな文字)ではOCRが成功するのに、
 * ユーザーの実機(スマホ)で実物レシートを撮影すると失敗する、という報告を
 * 再現するための劣化画像を生成する。実際のスマホ撮影で典型的に起きる要因を
 * 個別にON/OFFできるパラメータとして用意し、切り分け実験に使う。
 *
 * 実行前提: `@napi-rs/canvas` は本プロジェクトの間接依存として既に
 * node_modules に存在するため追加インストール不要(package.json/lockには
 * 記載されていないが、既存の @napi-rs/canvas を直接requireして使う)。
 *
 * 使い方:
 *   node scripts/generate-degraded-receipt.mjs --out <path.jpg> [options]
 *
 * オプション(すべて省略可、括弧内はデフォルト):
 *   --outW <px>            出力画像の幅 (3024)
 *   --outH <px>             出力画像の高さ (4032)
 *   --occupancy <0..1>      レシートが画面幅に占める割合 (0.6)
 *   --rotationDeg <deg>     レシートの回転角度 (2)
 *   --shadow <0|1>          片側グラデーション影のON/OFF (1)
 *   --textColor <#hex>      レシート文字色、感熱紙の低コントラストを模す (#3d3d3d)
 *   --blurPx <px>           仕上げの軽いブラー半径 (1.2)
 *   --background <wood|fabric> 背景の種類 (wood)
 *   --jpegQuality <0..1>    JPEG書き出し品質 (0.8)
 *   --seed <int>            ノイズの乱数シード (1)
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      out[key] = value;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OPTS = {
  out: args.out ?? (() => { throw new Error("--out <path.jpg> is required"); })(),
  outW: Number(args.outW ?? 3024),
  outH: Number(args.outH ?? 4032),
  occupancy: Number(args.occupancy ?? 0.6),
  rotationDeg: Number(args.rotationDeg ?? 2),
  shadow: (args.shadow ?? "1") !== "0",
  textColor: args.textColor ?? "#3d3d3d",
  blurPx: Number(args.blurPx ?? 1.2),
  background: args.background ?? "wood",
  jpegQuality: Number(args.jpegQuality ?? 0.8),
  seed: Number(args.seed ?? 1),
};

// 決定論的な擬似乱数(シード固定で実験の再現性を確保する)。
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
const rand = mulberry32(OPTS.seed);

const fontFamily = GlobalFonts.families.some((f) => f.family === "Hiragino Sans")
  ? "Hiragino Sans"
  : "sans-serif";
const fontFamilyBold = GlobalFonts.families.some((f) => f.family === "Hiragino Sans")
  ? "Hiragino Sans"
  : "sans-serif";

/**
 * レシート本体の内容を描画する(実際の解像度=最終合成画像上での見かけサイズで直接描画する。
 * 一度小さく描いてから拡大すると本来ないブロックノイズが乗り、逆に高解像度で描いてから
 * 縮小すると実際より鮮明になりすぎるため、フレーム内で見える最終サイズで描くことで
 * 「スマホのその他フレーム部分にレシートが小さく写り込む」実写の解像度不足を素直に再現する)。
 */
function renderReceiptContent(width, height, textColor) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 感熱紙は純白ではなくやや黄味がかったオフホワイト。
  ctx.fillStyle = "#f2ecd9";
  ctx.fillRect(0, 0, width, height);

  // 紙のうっすらとした繊維ノイズ(低振幅)。
  const paperNoise = ctx.getImageData(0, 0, width, height);
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
  const headerSize = Math.round(width * 0.062);
  const bodySize = Math.round(width * 0.048);
  let y = height * 0.06 + headerSize;

  ctx.font = `bold ${headerSize}px "${fontFamilyBold}"`;
  ctx.fillText("コンビニあおぞら", marginX, y);
  y += headerSize * 1.6;

  ctx.font = `${Math.round(bodySize * 0.85)}px "${fontFamily}"`;
  ctx.fillText("2026/07/27  18:23", marginX, y);
  y += bodySize * 1.8;

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
    y += bodySize * 1.5;
  };

  const row = (label, amount) => {
    ctx.fillText(label, marginX, y);
    if (amount !== undefined) ctx.fillText(amount, amountX, y);
    y += bodySize * 1.55;
  };

  dashLine();
  row("おにぎり", "¥150");
  row("お茶", "¥138");
  row("サンドイッチ", "¥320");
  row("コーヒー", "¥180");
  dashLine();
  row("小計", "¥788");
  row("8%対象", "¥788");
  row("内消費税", "¥58");
  dashLine();
  ctx.font = `bold ${Math.round(bodySize * 1.1)}px "${fontFamilyBold}"`;
  row("合計", "¥788");
  ctx.font = `${bodySize}px "${fontFamily}"`;
  row("お預り", "¥1,000");
  row("お釣り", "¥212");
  dashLine();
  ctx.font = `${Math.round(bodySize * 0.85)}px "${fontFamily}"`;
  ctx.fillText("ありがとうございました", marginX, y);

  return canvas;
}

/** 木目/布っぽい単色+ノイズの背景を生成する。 */
function renderBackground(width, height, kind) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  if (kind === "wood") {
    ctx.fillStyle = "#8a6a48";
    ctx.fillRect(0, 0, width, height);
    // 木目の帯(縦方向のサイン波で明暗の縞を作る)。
    for (let x = 0; x < width; x += 3) {
      const grain = Math.sin(x * 0.02) * 10 + Math.sin(x * 0.005 + 3) * 14;
      ctx.fillStyle = `rgba(${60 + grain},${40 + grain * 0.7},${20 + grain * 0.4},0.35)`;
      ctx.fillRect(x, 0, 3, height);
    }
  } else {
    // fabric: 落ち着いたグレーブルーの単色地。
    ctx.fillStyle = "#6b6f74";
    ctx.fillRect(0, 0, width, height);
  }

  // 粒状ノイズ(テーブル/布の質感)。
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 28;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function main() {
  const { outW, outH, occupancy, rotationDeg, shadow, textColor, blurPx, background, jpegQuality } = OPTS;

  // レシートの縦横比(典型的な細長いレシート)。
  const receiptAspect = 1.85; // height / width
  let receiptW = outW * occupancy;
  let receiptH = receiptW * receiptAspect;
  const maxH = outH * 0.95;
  if (receiptH > maxH) {
    receiptH = maxH;
    receiptW = receiptH / receiptAspect;
  }

  const bg = renderBackground(outW, outH, background);
  const receipt = renderReceiptContent(Math.round(receiptW), Math.round(receiptH), textColor);

  const composed = createCanvas(outW, outH);
  const ctx = composed.getContext("2d");
  ctx.drawImage(bg, 0, 0);

  // レシートをフレーム中央に、指定角度だけ回転して配置する。
  const cx = outW / 2;
  const cy = outH / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotationDeg * Math.PI) / 180);
  // 軽いドロップシャドウ(卓上に置かれた紙らしさ)。
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.filter = "blur(12px)";
  ctx.fillRect(-receiptW / 2 + 6, -receiptH / 2 + 8, receiptW, receiptH);
  ctx.restore();
  ctx.drawImage(receipt, -receiptW / 2, -receiptH / 2, receiptW, receiptH);
  ctx.restore();

  // 明暗ムラ: 片側から緩いグラデーションで暗くする(斜め光源/影を模す)。
  if (shadow) {
    const grad = ctx.createLinearGradient(0, 0, outW, outH * 0.6);
    grad.addColorStop(0, "rgba(0,0,0,0.38)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.08)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, outW, outH);
  }

  // 仕上げの軽いブラー(手ブレ/ピント甘さを模す)。新規canvasへblurフィルタ付きで
  // 描き直すことで、canvas全体に一様なガウシアンブラーを適用する。
  let finalCanvas = composed;
  if (blurPx > 0) {
    finalCanvas = createCanvas(outW, outH);
    const fctx = finalCanvas.getContext("2d");
    fctx.filter = `blur(${blurPx}px)`;
    fctx.drawImage(composed, 0, 0);
  }

  const buf = finalCanvas.toBuffer("image/jpeg", jpegQuality);
  mkdirSync(path.dirname(OPTS.out), { recursive: true });
  writeFileSync(OPTS.out, buf);
  console.log(
    `wrote ${OPTS.out} (${outW}x${outH}, receipt ${Math.round(receiptW)}x${Math.round(receiptH)}, ` +
      `occupancy=${occupancy}, rotation=${rotationDeg}deg, shadow=${shadow}, textColor=${textColor}, ` +
      `blur=${blurPx}px, background=${background}, jpegQuality=${jpegQuality}) -- ${buf.length} bytes`,
  );
}

main();
