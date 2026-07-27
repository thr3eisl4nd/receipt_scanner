# レシート清算スキャナー 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レシート画像から合計金額をブラウザ内OCRで抽出し、夫婦それぞれの月間支払合計と差額を表示する完全クライアントサイドSPAを作り、GitHub Pagesにデプロイする。

**Architecture:** サーバー・DBなしの静的SPA。画像取り込み→前処理→OCR(ppu-paddle-ocr / WASM)→座標ベースの金額抽出→編集可能な一覧→集計、を全てスマホブラウザ内で実行。OCRエンジンは`OcrEngine`インターフェースで抽象化し差し替え可能にする。作業状態はlocalStorageに保存(画像は保存しない)。

**Tech Stack:** Vite / TypeScript / React / Vitest / ppu-paddle-ocr(検証中候補) / GitHub Pages + GitHub Actions

**Spec:** `docs/superpowers/specs/2026-07-27-receipt-scanner-design.md`(以下「スペック」)

## Global Constraints

- 依存は**完全固定バージョン**(`.npmrc`に`save-exact=true`)。外部CDN・外部フォント・分析タグ禁止
- OCRモデル・辞書・WASMは**自サイトに同梱**(実行時にGitHub等のリモートURLを参照しない)
- 金額は**円単位の整数**(`number`)。浮動小数・文字列金額での計算禁止
- OCRは**1枚ずつ直列処理**(並列禁止)。処理後に`URL.revokeObjectURL()`・一時canvas解放
- localStorageに画像・サムネイルを保存しない(金額・状態等のメタデータのみ)
- 金額最大値のフォールバック採用禁止(キーワード無し→候補提示 or 手入力)
- 状態は色+テキストで表現(色だけに頼らない)。進捗は`aria-live`、エラーは`role="alert"`
- UIテキストは日本語。コード識別子は英語
- 各タスク完了時に`npx vitest run`が全パスしていること
- コミットメッセージ末尾に`Co-Authored-By:`行(実装者のモデル名)を付ける

## 実装体制(スペック§12)

- 実装: Sonnet 5サブエージェント(タスク単位)
- レビューゲート: **Task 5(コア+スパイク後)とTask 11(全実装後)でCodexレビュー**(`codex exec --sandbox read-only`)。指摘はオーケストレーター(Fable 5)が検証して反映判断
- Task 5の実機検証はユーザー(人間)の協力が必要 — 実物レシートでの撮影・判定

## File Structure

```
receipt_scanner/
├── .npmrc                       # save-exact=true
├── index.html                   # 本番アプリのエントリ
├── spike.html                   # OCR検証スパイクページ(Task 4)
├── vite.config.ts
├── tsconfig.json
├── package.json
├── .github/workflows/deploy.yml # GitHub Pagesデプロイ
├── public/models/               # OCRモデル同梱置き場(Task 4で配置)
├── src/
│   ├── main.tsx                 # Reactエントリ
│   ├── App.tsx                  # 画面全体の組み立て
│   ├── index.css                # 全スタイル(1ファイル)
│   ├── types.ts                 # Row / VerificationStatus / Payer 等
│   ├── extract/
│   │   ├── normalize.ts         # normalizeMoneyToken
│   │   ├── normalize.test.ts
│   │   ├── extractTotal.ts      # 座標ベース候補スコアリング
│   │   ├── extractTotal.test.ts
│   │   └── fixtures/            # OcrLine[]フィクスチャ(合成→実機由来を追加)
│   ├── ocr/
│   │   ├── engine.ts            # OcrLine / OcrEngine インターフェース
│   │   ├── ppuPaddleEngine.ts   # ppu-paddle-ocrアダプタ
│   │   └── queue.ts             # 直列OCRキュー
│   ├── image/
│   │   └── preprocess.ts        # EXIF回転・リサイズ・コントラスト再試行用
│   ├── state/
│   │   ├── storage.ts           # localStorage保存/復元(バージョン付き)
│   │   ├── storage.test.ts
│   │   ├── reducer.ts           # アプリ状態reducer + computeTotals
│   │   └── reducer.test.ts
│   ├── spike/
│   │   └── main.ts              # スパイクページのスクリプト
│   └── components/
│       ├── AddReceiptButtons.tsx
│       ├── ReceiptRow.tsx
│       ├── ManualEntryForm.tsx
│       └── SummaryPanel.tsx
```

---

### Task 1: プロジェクト雛形とGitHub Pagesデプロイ

**Files:**
- Create: `.npmrc`, `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `.github/workflows/deploy.yml`, `.gitignore`

**Interfaces:**
- Produces: `npm run dev` / `npm run build` / `npx vitest run` が動く雛形。mainへのpushでGitHub Pagesへ自動デプロイされるパイプライン

- [ ] **Step 1: 雛形生成と依存導入**

```bash
cd /Users/thr3eisl4nd/git/receipt_scanner
printf 'save-exact=true\n' > .npmrc
npm create vite@latest . -- --template react-ts   # 既存ファイル保持を選ぶ(docs/がある)
npm install
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: vite.config.ts をGitHub Pages用に設定**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/receipt_scanner/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        spike: "spike.html", // Task 4で追加(それまで空のプレースホルダを置く)
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
```

`spike.html` はTask 4まで最小の中身にする:

```html
<!doctype html><html lang="ja"><head><meta charset="UTF-8"><title>OCR Spike</title></head><body>準備中</body></html>
```

- [ ] **Step 3: App.tsxを最小の骨組みに置き換え**

```tsx
export default function App() {
  return (
    <main>
      <h1>レシート清算スキャナー</h1>
      <p>準備中</p>
    </main>
  );
}
```

`index.html`の`<html lang="en">`を`lang="ja"`にし、`<title>レシート清算スキャナー</title>`、`<meta name="viewport" content="width=device-width, initial-scale=1" />`を確認。テンプレート付属の`App.css`・ロゴ類は削除し、`index.css`は空に近い状態から始める。

- [ ] **Step 4: ビルドとテストランナー動作確認**

```bash
npm run build        # 期待: dist/ 生成、エラーなし
npx vitest run       # 期待: "No test files found" ではなくパス(ダミーテスト1本を置く)
```

ダミーテスト `src/smoke.test.ts`:

```ts
import { expect, test } from "vitest";
test("test runner works", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: GitHub Actionsワークフロー作成**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx vitest run
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 6: コミットとリポジトリ作成(要ユーザー確認)**

```bash
git add -A && git commit -m "chore: Vite+React+TS雛形とPagesデプロイ設定"
# ↓ 実行前にオーケストレーター経由でユーザーに確認(publicリポジトリの新規作成)
gh repo create receipt_scanner --public --source=. --push
```

リポジトリ作成後、GitHub上で Settings → Pages → Source を「GitHub Actions」に設定(`gh api -X POST repos/{owner}/receipt_scanner/pages -f build_type=workflow` でも可)。Actionsが緑になり `https://<owner>.github.io/receipt_scanner/` が表示されることを確認。

---

### Task 2: 型定義と金額正規化 `normalizeMoneyToken`

**Files:**
- Create: `src/types.ts`, `src/extract/normalize.ts`, `src/extract/normalize.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `VerificationStatus`, `Payer`, `Row`, `PersistedState`(下記コード通り)
  - `normalize.ts`: `normalizeMoneyToken(token: string): number | null`、`findMoneyTokens(text: string): number[]`

- [ ] **Step 1: 型定義を書く**

`src/types.ts`:

```ts
export type VerificationStatus =
  | "auto-high"     // キーワード一致・高信頼で自動確定
  | "needs-review"  // 候補はあるが要確認
  | "confirmed"     // ユーザーが確認済み
  | "manual"        // 手入力
  | "failed";       // OCR失敗(金額空欄)

export type Payer = "husband" | "wife";

export type Row = {
  id: string;
  payer: Payer;
  amountYen: number | null;
  label: string;               // 手動行の名前 or "レシート 3" 等
  status: VerificationStatus;
  source: "ocr" | "manual";
  candidates: number[];        // needs-review時の候補(上位2〜3件)
  thumbnailUrl?: string;       // Object URL。メモリ上のみ、永続化しない
  processing?: boolean;        // OCR処理中フラグ
};

export type PersistedState = {
  version: 1;
  month: string;    // "2026-07"
  updatedAt: string; // ISO 8601
  rows: Array<Pick<Row, "id" | "payer" | "amountYen" | "label" | "status" | "source">>;
};
```

- [ ] **Step 2: normalizeの失敗するテストを書く**

`src/extract/normalize.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { normalizeMoneyToken, findMoneyTokens } from "./normalize";

describe("normalizeMoneyToken", () => {
  test.each([
    ["1,234", 1234],
    ["¥1,234", 1234],
    ["￥１，２３４", 1234],       // 全角
    ["１２３４円", 1234],
    ["￥1,234-", 1234],           // 末尾ハイフン(レジ慣習)
    ["￥１，２３４－", 1234],
    ["1 234", 1234],              // 空白混じり
    ["▲1,280", -1280],            // 返品・取消
    ["-1,280", -1280],
    ["l,O8O", 1080],              // OCR誤認: l→1, O→0
    ["8,888,888", 8888888],
  ])("%s → %d", (input, expected) => {
    expect(normalizeMoneyToken(input)).toBe(expected);
  });

  test.each([
    ["", null],
    ["abc", null],
    ["12.34", null],              // 小数は金額として扱わない
    ["20,000,000", null],         // 上限1,000万円超
    ["2026-07-27", null],         // 日付っぽいもの(ハイフン内包)は数値でない
  ])("%s → null", (input, expected) => {
    expect(normalizeMoneyToken(input)).toBe(expected);
  });
});

describe("findMoneyTokens", () => {
  test("行テキストから金額候補を全部拾う", () => {
    expect(findMoneyTokens("合計 ¥1,234")).toEqual([1234]);
    expect(findMoneyTokens("8%対象 550 10%対象 1,100")).toEqual([550, 1100]);
    expect(findMoneyTokens("お預り ￥２，０００－")).toEqual([2000]);
    expect(findMoneyTokens("電話番号は拾わない")).toEqual([]);
  });
  test("桁が少なすぎる断片も金額として拾う(1桁も可)", () => {
    expect(findMoneyTokens("合計 8円")).toEqual([8]);
  });
});
```

- [ ] **Step 3: 失敗確認**

```bash
npx vitest run src/extract/normalize.test.ts
# 期待: FAIL (Cannot find module './normalize')
```

- [ ] **Step 4: 実装**

`src/extract/normalize.ts`:

```ts
const MAX_YEN = 10_000_000;

/** 金額らしき1トークンを円整数へ。金額でなければnull。 */
export function normalizeMoneyToken(token: string): number | null {
  let s = token.normalize("NFKC");     // 全角→半角
  s = s
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[Il|ｌ]/g, "1")
    .replace(/^▲/, "-")
    .replace(/[¥￥円,\s]/g, "")
    .replace(/[-ー−]$/, "");           // 末尾ハイフン(¥1,234-)は除去
  if (!/^-?\d+$/.test(s)) return null;
  const value = Number(s);
  if (!Number.isSafeInteger(value)) return null;
  if (Math.abs(value) > MAX_YEN) return null;
  return value;
}

/** 行テキストから金額候補をすべて抽出する。 */
export function findMoneyTokens(text: string): number[] {
  const re = /[▲\-]?[¥￥]?[0-9０-９OoＯｏIl|ｌ][0-9０-９OoＯｏIl|ｌ,，\s]*(?:円)?[-ー−]?/g;
  const out: number[] = [];
  for (const m of text.normalize("NFKC").matchAll(re)) {
    const v = normalizeMoneyToken(m[0].trim());
    if (v !== null) out.push(v);
  }
  return out;
}
```

注意: `findMoneyTokens`は正規表現で貪欲に拾い`normalizeMoneyToken`で選別する2段構え。テストを通すことを最優先し、正規表現はテストケースで駆動して調整してよい(仕様はテスト)。

- [ ] **Step 5: パス確認とコミット**

```bash
npx vitest run   # 期待: 全PASS
git add -A && git commit -m "feat: 型定義と金額トークン正規化を追加"
```

---

### Task 3: 合計金額抽出 `extractTotal`(座標ベーススコアリング)

**Files:**
- Create: `src/ocr/engine.ts`, `src/extract/extractTotal.ts`, `src/extract/extractTotal.test.ts`, `src/extract/fixtures/synthetic.ts`

**Interfaces:**
- Consumes: `normalizeMoneyToken` / `findMoneyTokens`(Task 2)
- Produces:
  - `engine.ts`: `OcrLine`, `OcrEngine`(スペック§3.1のコード通り)
  - `extractTotal.ts`: `extractTotal(lines: OcrLine[]): ExtractResult` /
    `type ExtractResult = { amountYen: number | null; status: "auto-high" | "needs-review" | "failed"; candidates: number[] }`

- [ ] **Step 1: OcrEngineインターフェースを書く**

`src/ocr/engine.ts`:

```ts
export type OcrLine = {
  text: string;
  confidence: number; // 0..1
  box: { x: number; y: number; width: number; height: number };
};

export interface OcrEngine {
  initialize(): Promise<void>;
  recognize(image: HTMLCanvasElement): Promise<OcrLine[]>;
  destroy(): Promise<void>;
}
```

- [ ] **Step 2: 合成フィクスチャを書く**

`src/extract/fixtures/synthetic.ts` — 典型レシートを`OcrLine[]`で表現(y座標は上から下、höhe 20px刻み)。ヘルパで簡潔に:

```ts
import type { OcrLine } from "../../ocr/engine";

export function line(text: string, y: number, x = 0, confidence = 0.95): OcrLine {
  return { text, confidence, box: { x, y, width: text.length * 12, height: 20 } };
}

/** スーパーの標準的なレシート: 合計行が明確 */
export const supermarket: OcrLine[] = [
  line("スーパーABC", 0),
  line("ねぎ", 40), line("¥98", 40, 200),
  line("小計", 100), line("¥1,234", 100, 200),
  line("合計", 140), line("¥1,332", 140, 200),
  line("お預り", 180), line("¥2,000", 180, 200),
  line("お釣り", 220), line("¥668", 220, 200),
];

/** 税率別表記: 8%/10%対象が並ぶ */
export const taxBreakdown: OcrLine[] = [
  line("8%対象", 100), line("¥550", 100, 200),
  line("10%対象", 140), line("¥1,100", 140, 200),
  line("合計", 180), line("¥1,650", 180, 200),
];

/** 合計キーワードなし(下部が切れた) */
export const truncated: OcrLine[] = [
  line("ねぎ", 40), line("¥98", 40, 200),
  line("たまご", 80), line("¥298", 80, 200),
];

/** キーワードと金額が別行(1行下)に出るケース */
export const totalOnNextLine: OcrLine[] = [
  line("ご請求額", 140),
  line("¥3,980", 165),
  line("お預り", 210), line("¥5,000", 210, 200),
];

/** 現計表記+末尾ハイフン */
export const genkei: OcrLine[] = [
  line("現計", 140), line("￥１，６５０－", 140, 200),
  line("クレジット", 180), line("￥１，６５０", 180, 200),
];
```

- [ ] **Step 3: 失敗するテストを書く**

`src/extract/extractTotal.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { extractTotal } from "./extractTotal";
import * as fx from "./fixtures/synthetic";

describe("extractTotal", () => {
  test("標準レシート: 合計を採用し、お預り・お釣り・小計を選ばない", () => {
    const r = extractTotal(fx.supermarket);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
  });

  test("税率別表記: 8%/10%対象ではなく合計を採用", () => {
    const r = extractTotal(fx.taxBreakdown);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("キーワードなし: failed(最大値フォールバック禁止)", () => {
    const r = extractTotal(fx.truncated);
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.candidates).toEqual([]); // キーワード無しなら候補も出さない
  });

  test("キーワードの1行下の金額も拾う", () => {
    const r = extractTotal(fx.totalOnNextLine);
    expect(r.amountYen).toBe(3980);
    expect(r.status).toBe("auto-high");
  });

  test("現計+全角末尾ハイフン", () => {
    const r = extractTotal(fx.genkei);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("空入力はfailed", () => {
    expect(extractTotal([]).status).toBe("failed");
  });
});
```

- [ ] **Step 4: 失敗確認**

```bash
npx vitest run src/extract/extractTotal.test.ts
# 期待: FAIL (Cannot find module './extractTotal')
```

- [ ] **Step 5: 実装**

`src/extract/extractTotal.ts`:

```ts
import type { OcrLine } from "../ocr/engine";
import { findMoneyTokens } from "./normalize";

export type ExtractResult = {
  amountYen: number | null;
  status: "auto-high" | "needs-review" | "failed";
  candidates: number[];
};

const STRONG_LABELS = [
  /(?:税込|総)?合計/,
  /お?買上(?:げ)?(?:計|金額)/,
  /お会計/,
  /ご?請求(?:額|金額)/,
  /今回お支払額/,
  /現計/,
];

const REJECT_LABELS = [
  /小計/,
  /(?:8|10)\s*%対象/,
  /課税対象/,
  /消費税|内税|外税|税額|税率/,
  /預り|釣り?銭?|お釣/,
  /現金|クレジット|電子マネー|ポイント|残高/,
  /値引|割引/,
  /点数|電話|伝票/,
];

type Candidate = { amountYen: number; score: number };

/** 2行が視覚的に同一行か(Y中心の差が行高の6割未満) */
function sameRow(a: OcrLine, b: OcrLine): boolean {
  const ac = a.box.y + a.box.height / 2;
  const bc = b.box.y + b.box.height / 2;
  return Math.abs(ac - bc) < Math.max(a.box.height, b.box.height) * 0.6;
}

/** bがaの下方1〜2行分(行高の0.5〜2.5倍)にあるか */
function isJustBelow(a: OcrLine, b: OcrLine): boolean {
  const dy = b.box.y - a.box.y;
  const h = Math.max(a.box.height, 12);
  return dy > h * 0.5 && dy < h * 2.5;
}

export function extractTotal(lines: OcrLine[]): ExtractResult {
  if (lines.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  const maxY = Math.max(...lines.map((l) => l.box.y + l.box.height));
  const norm = (t: string) => t.normalize("NFKC");
  const strongLines = lines.filter((l) => STRONG_LABELS.some((re) => re.test(norm(l.text))));
  const rejectLines = lines.filter((l) => REJECT_LABELS.some((re) => re.test(norm(l.text))));

  const candidates: Candidate[] = [];
  for (const line of lines) {
    for (const amountYen of findMoneyTokens(line.text)) {
      let score = 0;
      const nearStrong = strongLines.some((s) => sameRow(s, line));
      const belowStrong = strongLines.some((s) => isJustBelow(s, line));
      const nearReject = rejectLines.some((r) => sameRow(r, line));
      if (nearStrong) score += 50;
      else if (belowStrong) score += 20;
      if (nearReject) score -= 100;
      if (line.box.y > maxY / 2) score += 5;                 // レシート下半分
      if (/[¥￥円]/.test(norm(line.text))) score += 10;
      score += Math.round(line.confidence * 10);
      if (score > 0 && (nearStrong || belowStrong)) {
        candidates.push({ amountYen, score });
      }
    }
  }

  if (candidates.length === 0) return { amountYen: null, status: "failed", candidates: [] };

  candidates.sort((a, b) => b.score - a.score);
  const unique = [...new Map(candidates.map((c) => [c.amountYen, c])).values()];
  const top = unique[0];
  const second = unique[1];
  const confident = top.score >= 60 && (second === undefined || top.score - second.score >= 20);

  return {
    amountYen: top.amountYen,
    status: confident ? "auto-high" : "needs-review",
    candidates: unique.slice(0, 3).map((c) => c.amountYen),
  };
}
```

- [ ] **Step 6: パス確認・スコア調整**

```bash
npx vitest run
# 期待: 全PASS。落ちる場合はスコア閾値でなくロジックのバグを疑う(テストが仕様)
```

- [ ] **Step 7: コミット**

```bash
git add -A && git commit -m "feat: 座標ベースの合計金額抽出ロジックを追加"
```

---

### Task 4: 画像前処理・ppu-paddle-ocrアダプタ・スパイクページ

**Files:**
- Create: `src/image/preprocess.ts`, `src/ocr/ppuPaddleEngine.ts`, `src/spike/main.ts`
- Modify: `spike.html`, `public/models/`(モデル配置)

**Interfaces:**
- Consumes: `OcrEngine` / `OcrLine`(Task 3)、`extractTotal`(Task 3)
- Produces:
  - `preprocess.ts`: `loadAsCanvas(file: File, maxEdge?: number): Promise<HTMLCanvasElement>`、`enhanceContrast(src: HTMLCanvasElement): HTMLCanvasElement`
  - `ppuPaddleEngine.ts`: `createPpuPaddleEngine(): OcrEngine`
  - スパイクページ: 画像を複数選択→各画像の生OCR行・抽出結果・処理時間を表示、結果JSONをコピー可能

- [ ] **Step 1: ppu-paddle-ocrを導入しAPIを確認する**

```bash
npm install ppu-paddle-ocr
```

`node_modules/ppu-paddle-ocr/README.md` と型定義(`dist/*.d.ts`)を読み、以下を確認して本タスク内コードを実APIに合わせて調整する:
- ブラウザ向けエントリ(`ppu-paddle-ocr/web` 等)のimport方法
- 初期化オプションでの**モデルURL指定方法**(自サイト同梱パスを渡すため)
- 認識結果の形(テキスト・confidence・box座標の取り出し方)
- WebGPU/WASMの自動フォールバック設定

モデルファイルはパッケージ同梱物 or READMEが示す取得先から`public/models/`へコピーし、**実行時は`import.meta.env.BASE_URL + "models/..."`のローカルパスのみ参照**させる。`git add public/models`で必ずコミットする(自サイト同梱の制約)。

- [ ] **Step 2: 前処理を書く**

`src/image/preprocess.ts`:

```ts
/** File→EXIF回転適用+長辺maxEdgeへ縮小したcanvas。 */
export async function loadAsCanvas(file: File, maxEdge = 1600): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** 低信頼時の再試行用: グレースケール+コントラストストレッチ。 */
export function enhanceContrast(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext("2d")!;
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
```

- [ ] **Step 3: アダプタを書く**

`src/ocr/ppuPaddleEngine.ts` — **以下はStep 1で確認した実APIに合わせて必ず調整**(構造だけ維持):

```ts
import type { OcrEngine, OcrLine } from "./engine";
// import先はStep 1で確認したブラウザ向けエントリに合わせる
// import { PaddleOcr } from "ppu-paddle-ocr/web";

export function createPpuPaddleEngine(): OcrEngine {
  let engine: unknown = null;
  return {
    async initialize() {
      // モデルは import.meta.env.BASE_URL + "models/..." のローカル同梱パスを指定
      // WebGPU利用可否はライブラリの自動判定に任せる(失敗時WASM)
    },
    async recognize(image: HTMLCanvasElement): Promise<OcrLine[]> {
      // ライブラリの結果を OcrLine[] へマッピング:
      // text / confidence(0..1に正規化) / box{x,y,width,height}
      return [];
    },
    async destroy() {
      // ライブラリのdispose APIを呼ぶ
    },
  };
}
```

- [ ] **Step 4: スパイクページを書く**

`spike.html`:

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OCR検証スパイク</title>
    <style>
      body { font-family: sans-serif; margin: 12px; }
      .result { border: 1px solid #ccc; margin: 8px 0; padding: 8px; }
      .ok { background: #e6ffe6; } .ng { background: #fff3e0; }
      pre { white-space: pre-wrap; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>OCR検証スパイク</h1>
    <p id="status" aria-live="polite">モデル未ロード</p>
    <input id="files" type="file" accept="image/*" multiple />
    <button id="copy">結果JSONをコピー</button>
    <div id="results"></div>
    <script type="module" src="/src/spike/main.ts"></script>
  </body>
</html>
```

`src/spike/main.ts`:

```ts
import { createPpuPaddleEngine } from "../ocr/ppuPaddleEngine";
import { loadAsCanvas, enhanceContrast } from "../image/preprocess";
import { extractTotal } from "../extract/extractTotal";

const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;
const engine = createPpuPaddleEngine();
const allResults: unknown[] = [];
let initialized = false;

document.getElementById("files")!.addEventListener("change", async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (!initialized) {
    statusEl.textContent = "モデルロード中…";
    const t0 = performance.now();
    await engine.initialize();
    initialized = true;
    statusEl.textContent = `モデルロード完了 (${Math.round(performance.now() - t0)}ms)`;
  }
  for (let i = 0; i < files.length; i++) {
    statusEl.textContent = `処理中 ${i + 1}/${files.length}`;
    const t0 = performance.now();
    try {
      const canvas = await loadAsCanvas(files[i]);
      let lines = await engine.recognize(canvas);
      let retried = false;
      let result = extractTotal(lines);
      if (result.status === "failed") {
        lines = await engine.recognize(enhanceContrast(canvas));
        result = extractTotal(lines);
        retried = true;
      }
      const ms = Math.round(performance.now() - t0);
      const entry = { file: files[i].name, ms, retried, result, lines };
      allResults.push(entry);
      const div = document.createElement("div");
      div.className = `result ${result.status === "failed" ? "ng" : "ok"}`;
      div.innerHTML = `<b>${files[i].name}</b> → ${result.amountYen ?? "抽出失敗"}円
        [${result.status}] ${ms}ms ${retried ? "(再試行あり)" : ""}
        <pre>${lines.map((l) => `${Math.round(l.confidence * 100)}% ${l.text}`).join("\n")}</pre>`;
      resultsEl.append(div);
    } catch (err) {
      allResults.push({ file: files[i].name, error: String(err) });
      const div = document.createElement("div");
      div.className = "result ng";
      div.textContent = `${files[i].name}: エラー ${String(err)}`;
      resultsEl.append(div);
    }
  }
  statusEl.textContent = `完了 (${files.length}枚)`;
  (e.target as HTMLInputElement).value = "";
});

document.getElementById("copy")!.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(allResults, null, 2));
  statusEl.textContent = "コピーしました";
});
```

- [ ] **Step 5: デスクトップで動作確認**

```bash
npm run dev
```

ブラウザで `http://localhost:5173/receipt_scanner/spike.html` を開き、手元のレシート画像(スマホで撮影したものをMacへ転送)を投入。生OCR行が出ること・`extractTotal`が動くことを確認。**ネットワークタブで外部ドメインへのリクエストが無いこと**(モデルが自サイト配信であること)を確認。

- [ ] **Step 6: コミットとデプロイ**

```bash
npx vitest run && npm run build   # 期待: PASS + ビルド成功
git add -A && git commit -m "feat: OCRアダプタ・前処理・検証スパイクページを追加"
git push   # → Pagesに spike.html が公開される
```

---

### Task 5: 【チェックポイント】Codexレビュー#1 + 実機検証スパイク

これはコード実装タスクではなく、オーケストレーター(Fable 5)とユーザーが行うゲート。

- [ ] **Step 1: Codexレビュー#1**

対象: Task 1〜4の全コード。

```bash
codex exec --sandbox read-only --cd /Users/thr3eisl4nd/git/receipt_scanner \
  "src/ 以下の実装をレビューしてください。特に extract/(金額抽出ロジック)と ocr/ppuPaddleEngine.ts(ライブラリアダプタ)の正しさ、スペック docs/superpowers/specs/2026-07-27-receipt-scanner-design.md との整合を確認してください。確認や質問は不要です。具体的な提案・修正案・コード例まで自主的に出力してください。"
```

指摘はオーケストレーターが検証し、妥当なもののみ修正タスクとしてSonnet 5に依頼。

- [ ] **Step 2: 実機検証(ユーザー協力)**

ユーザーのスマホ(可能なら奥様のスマホ)で `https://<owner>.github.io/receipt_scanner/spike.html` を開き、**過去2〜3ヶ月分・店舗や撮影条件の異なる実物レシート30枚以上**を撮影して投入。「結果JSONをコピー」でJSONを回収しリポジトリの `spike-results/`(gitignore対象)に保存。

- [ ] **Step 3: 合否判定(スペック§10.2の基準)**

- 合計金額の完全一致率 90%以上
- 自動確定(auto-high)の誤り 0件
- WASM時 p95 10秒/枚以下
- 30枚連続処理でタブクラッシュなし
- 失敗画像はすべて手入力へ復旧可能な情報が出ている

**合格** → Step 4へ。**不合格** → `@paddleocr/paddleocr-js`へ差し替えて再検証(アダプタ層のみ交換)。それでも不合格ならスペック§13のフォールバック(方式再検討)をユーザーと相談。

- [ ] **Step 4: 実機由来フィクスチャの追加**

回収したJSONから、誤抽出・needs-review・failedになった実例を最低5ケース選び、`src/extract/fixtures/`に追加してextractTotalのテストを拡充(期待値は画像を目視して決める)。スコアリングを調整して全テストPASSさせ、コミット。

```bash
git add -A && git commit -m "test: 実機レシート由来のフィクスチャで抽出テストを拡充"
```

---

### Task 6: localStorage永続化 `storage.ts`

**Files:**
- Create: `src/state/storage.ts`, `src/state/storage.test.ts`

**Interfaces:**
- Consumes: `PersistedState`, `Row`(Task 2)
- Produces: `saveState(state: PersistedState): boolean` / `loadState(): PersistedState | null` / `clearState(): void` / `currentMonth(): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/state/storage.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { saveState, loadState, clearState, currentMonth } from "./storage";
import type { PersistedState } from "../types";

const valid: PersistedState = {
  version: 1,
  month: "2026-07",
  updatedAt: "2026-07-27T10:00:00.000Z",
  rows: [
    { id: "a", payer: "husband", amountYen: 1332, label: "レシート 1", status: "auto-high", source: "ocr" },
  ],
};

beforeEach(() => localStorage.clear());

describe("storage", () => {
  test("save→loadで往復できる", () => {
    expect(saveState(valid)).toBe(true);
    expect(loadState()).toEqual(valid);
  });

  test("未保存ならnull", () => {
    expect(loadState()).toBeNull();
  });

  test("壊れたJSONはnull(例外を投げない)", () => {
    localStorage.setItem("receipt-scanner:state:v1", "{oops");
    expect(loadState()).toBeNull();
  });

  test("スキーマ不一致(versionなし・rowsが配列でない)はnull", () => {
    localStorage.setItem("receipt-scanner:state:v1", JSON.stringify({ version: 99 }));
    expect(loadState()).toBeNull();
    localStorage.setItem("receipt-scanner:state:v1", JSON.stringify({ version: 1, month: "x", updatedAt: "x", rows: "no" }));
    expect(loadState()).toBeNull();
  });

  test("clearStateで消える", () => {
    saveState(valid);
    clearState();
    expect(loadState()).toBeNull();
  });

  test("currentMonthはYYYY-MM形式", () => {
    expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
  });
});
```

- [ ] **Step 2: 失敗確認**

```bash
npx vitest run src/state/storage.test.ts
# 期待: FAIL (Cannot find module './storage')
```

- [ ] **Step 3: 実装**

`src/state/storage.ts`:

```ts
import type { PersistedState } from "../types";

const STORAGE_KEY = "receipt-scanner:state:v1";

const PAYERS = new Set(["husband", "wife"]);
const STATUSES = new Set(["auto-high", "needs-review", "confirmed", "manual", "failed"]);
const SOURCES = new Set(["ocr", "manual"]);

function isValid(v: unknown): v is PersistedState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (typeof s.month !== "string" || typeof s.updatedAt !== "string") return false;
  if (!Array.isArray(s.rows)) return false;
  return s.rows.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      PAYERS.has(row.payer as string) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

/** 保存。失敗(容量超過等)はfalseを返す — 呼び出し側でUI表示すること。 */
export function saveState(state: PersistedState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
```

- [ ] **Step 4: パス確認とコミット**

```bash
npx vitest run
git add -A && git commit -m "feat: バージョン付きlocalStorage永続化を追加"
```

---

### Task 7: アプリ状態reducerと集計 `reducer.ts`

**Files:**
- Create: `src/state/reducer.ts`, `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `Row`, `Payer`, `PersistedState`(Task 2)
- Produces:
  - `type AppState = { month: string; rows: Row[]; saveFailed: boolean }`
  - `reducer(state: AppState, action: Action): AppState`、`Action =`
    `{ type: "hydrate"; state: AppState } | { type: "addRows"; rows: Row[] } | { type: "updateRow"; id: string; patch: Partial<Row> } | { type: "removeRow"; id: string } | { type: "clearMonth"; month: string } | { type: "setSaveFailed"; value: boolean }`
  - `computeTotals(rows: Row[]): { husbandYen: number; wifeYen: number; deltaYen: number; unconfirmed: number }`
  - `toPersisted(state: AppState): PersistedState`、`fromPersisted(p: PersistedState): AppState`
  - `buildSummaryText(state: AppState): string`(コピー用サマリー)

- [ ] **Step 1: 失敗するテストを書く**

`src/state/reducer.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { reducer, computeTotals, buildSummaryText, type AppState } from "./reducer";
import type { Row } from "../types";

const row = (over: Partial<Row>): Row => ({
  id: Math.random().toString(36).slice(2),
  payer: "husband",
  amountYen: 1000,
  label: "レシート",
  status: "auto-high",
  source: "ocr",
  candidates: [],
  ...over,
});

const base: AppState = { month: "2026-07", rows: [], saveFailed: false };

describe("reducer", () => {
  test("addRows/updateRow/removeRow", () => {
    let s = reducer(base, { type: "addRows", rows: [row({ id: "a" }), row({ id: "b" })] });
    expect(s.rows).toHaveLength(2);
    s = reducer(s, { type: "updateRow", id: "a", patch: { amountYen: 500, status: "confirmed" } });
    expect(s.rows[0].amountYen).toBe(500);
    s = reducer(s, { type: "removeRow", id: "a" });
    expect(s.rows.map((r) => r.id)).toEqual(["b"]);
  });

  test("clearMonthで全行が消え月が変わる", () => {
    let s = reducer(base, { type: "addRows", rows: [row({})] });
    s = reducer(s, { type: "clearMonth", month: "2026-08" });
    expect(s.rows).toEqual([]);
    expect(s.month).toBe("2026-08");
  });
});

describe("computeTotals", () => {
  test("payer別合計と差額(夫-妻)。amountYen=nullは0扱い", () => {
    const t = computeTotals([
      row({ payer: "husband", amountYen: 100000 }),
      row({ payer: "wife", amountYen: 30000 }),
      row({ payer: "wife", amountYen: 10000 }),
      row({ payer: "wife", amountYen: null, status: "failed" }),
    ]);
    expect(t.husbandYen).toBe(100000);
    expect(t.wifeYen).toBe(40000);
    expect(t.deltaYen).toBe(60000);
  });

  test("負の金額(返品)も合算される", () => {
    const t = computeTotals([row({ amountYen: 1000 }), row({ amountYen: -300 })]);
    expect(t.husbandYen).toBe(700);
  });

  test("unconfirmedはneeds-reviewとfailedの件数", () => {
    const t = computeTotals([
      row({ status: "needs-review" }),
      row({ status: "failed", amountYen: null }),
      row({ status: "confirmed" }),
    ]);
    expect(t.unconfirmed).toBe(2);
  });
});

describe("buildSummaryText", () => {
  test("月・両者合計・差額方向を含む", () => {
    const s: AppState = {
      month: "2026-07",
      saveFailed: false,
      rows: [row({ payer: "husband", amountYen: 100000 }), row({ payer: "wife", amountYen: 40000 })],
    };
    const text = buildSummaryText(s);
    expect(text).toContain("2026-07");
    expect(text).toContain("100,000");
    expect(text).toContain("40,000");
    expect(text).toContain("夫が 60,000円 多く支払い");
  });

  test("未確認があれば警告行を含む", () => {
    const s: AppState = { month: "2026-07", saveFailed: false, rows: [row({ status: "failed", amountYen: null })] };
    expect(buildSummaryText(s)).toContain("未確認 1件");
  });
});
```

- [ ] **Step 2: 失敗確認**

```bash
npx vitest run src/state/reducer.test.ts
# 期待: FAIL
```

- [ ] **Step 3: 実装**

`src/state/reducer.ts`:

```ts
import type { PersistedState, Row } from "../types";

export type AppState = { month: string; rows: Row[]; saveFailed: boolean };

export type Action =
  | { type: "hydrate"; state: AppState }
  | { type: "addRows"; rows: Row[] }
  | { type: "updateRow"; id: string; patch: Partial<Row> }
  | { type: "removeRow"; id: string }
  | { type: "clearMonth"; month: string }
  | { type: "setSaveFailed"; value: boolean };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "addRows":
      return { ...state, rows: [...state.rows, ...action.rows] };
    case "updateRow":
      return {
        ...state,
        rows: state.rows.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r)),
      };
    case "removeRow":
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id) };
    case "clearMonth":
      return { month: action.month, rows: [], saveFailed: false };
    case "setSaveFailed":
      return { ...state, saveFailed: action.value };
  }
}

export function computeTotals(rows: Row[]) {
  const sum = (payer: string) =>
    rows.filter((r) => r.payer === payer).reduce((acc, r) => acc + (r.amountYen ?? 0), 0);
  const husbandYen = sum("husband");
  const wifeYen = sum("wife");
  return {
    husbandYen,
    wifeYen,
    deltaYen: husbandYen - wifeYen,
    unconfirmed: rows.filter((r) => r.status === "needs-review" || r.status === "failed").length,
  };
}

const yen = (n: number) => n.toLocaleString("ja-JP");

export function buildSummaryText(state: AppState): string {
  const t = computeTotals(state.rows);
  const direction =
    t.deltaYen > 0
      ? `夫が ${yen(t.deltaYen)}円 多く支払い`
      : t.deltaYen < 0
        ? `妻が ${yen(-t.deltaYen)}円 多く支払い`
        : "差額なし";
  const lines = [
    `${state.month} 清算`,
    `夫: ${yen(t.husbandYen)}円 (${state.rows.filter((r) => r.payer === "husband").length}件)`,
    `妻: ${yen(t.wifeYen)}円 (${state.rows.filter((r) => r.payer === "wife").length}件)`,
    `差額: ${direction}`,
  ];
  if (t.unconfirmed > 0) lines.push(`⚠ 未確認 ${t.unconfirmed}件`);
  return lines.join("\n");
}

export function toPersisted(state: AppState): PersistedState {
  return {
    version: 1,
    month: state.month,
    updatedAt: new Date().toISOString(),
    rows: state.rows.map(({ id, payer, amountYen, label, status, source }) => ({
      id, payer, amountYen, label, status, source,
    })),
  };
}

export function fromPersisted(p: PersistedState): AppState {
  return {
    month: p.month,
    saveFailed: false,
    rows: p.rows.map((r) => ({ ...r, candidates: [] })),
  };
}
```

- [ ] **Step 4: パス確認とコミット**

```bash
npx vitest run
git add -A && git commit -m "feat: アプリ状態reducerと集計・サマリー生成を追加"
```

---

### Task 8: 直列OCRキュー `queue.ts`

**Files:**
- Create: `src/ocr/queue.ts`

**Interfaces:**
- Consumes: `OcrEngine`(Task 3)、`loadAsCanvas`/`enhanceContrast`(Task 4)、`extractTotal`(Task 3)
- Produces:

```ts
type QueueCallbacks = {
  onStatus(text: string): void;                       // "モデル準備中" / "画像 3/12 処理中"
  onResult(id: string, patch: Partial<Row>): void;    // 行更新(amountYen/status/candidates/processing)
};
createOcrQueue(engine: OcrEngine, cb: QueueCallbacks): {
  enqueue(id: string, file: File): void;
  cancelAll(): void;   // 残りを全部キャンセル(処理済みは維持)
}
```

- [ ] **Step 1: 実装**

`src/ocr/queue.ts`:

```ts
import type { OcrEngine } from "./engine";
import type { Row } from "../types";
import { loadAsCanvas, enhanceContrast } from "../image/preprocess";
import { extractTotal } from "../extract/extractTotal";

type QueueCallbacks = {
  onStatus(text: string): void;
  onResult(id: string, patch: Partial<Row>): void;
};

type Item = { id: string; file: File };

export function createOcrQueue(engine: OcrEngine, cb: QueueCallbacks) {
  const pending: Item[] = [];
  let running = false;
  let initialized = false;
  let total = 0;
  let done = 0;

  async function run() {
    if (running) return;
    running = true;
    try {
      if (!initialized) {
        cb.onStatus("モデル準備中…");
        await engine.initialize();
        initialized = true;
      }
      while (pending.length > 0) {
        const item = pending.shift()!;
        done++;
        cb.onStatus(`画像 ${done}/${total} 処理中…`);
        try {
          const canvas = await loadAsCanvas(item.file);
          let lines = await engine.recognize(canvas);
          let result = extractTotal(lines);
          if (result.status === "failed") {
            // 二段階前処理: 失敗時のみコントラスト補正で再試行
            const enhanced = enhanceContrast(canvas);
            lines = await engine.recognize(enhanced);
            result = extractTotal(lines);
            enhanced.width = 0; // canvas解放のヒント
          }
          canvas.width = 0;
          cb.onResult(item.id, {
            amountYen: result.amountYen,
            status: result.status,
            candidates: result.candidates,
            processing: false,
          });
        } catch (err) {
          console.error("OCR failed:", item.file.name, err);
          cb.onResult(item.id, { amountYen: null, status: "failed", candidates: [], processing: false });
        }
      }
      cb.onStatus(total > 0 ? `完了 (${done}/${total})` : "");
    } finally {
      running = false;
      total = 0;
      done = 0;
    }
  }

  return {
    enqueue(id: string, file: File) {
      pending.push({ id, file });
      total++;
      void run();
    },
    cancelAll() {
      for (const item of pending.splice(0)) {
        cb.onResult(item.id, { amountYen: null, status: "failed", candidates: [], processing: false });
      }
    },
  };
}
```

注意: 直列処理(whileループ)が本質。`Promise.all`への「改善」は禁止(Global Constraints)。

- [ ] **Step 2: 型チェック・既存テスト確認とコミット**

```bash
npx tsc --noEmit && npx vitest run
git add -A && git commit -m "feat: 直列OCR処理キューを追加"
```

---

### Task 9: UI — 取り込みボタンとレシート一覧

**Files:**
- Create: `src/components/AddReceiptButtons.tsx`, `src/components/ReceiptRow.tsx`
- Modify: `src/App.tsx`, `src/index.css`

**Interfaces:**
- Consumes: Task 6-8 の全export
- Produces: 動くアプリの中核(取り込み→OCR→一覧編集)。`App.tsx`が`useReducer`+`createOcrQueue`を接続

- [ ] **Step 1: AddReceiptButtons**

`src/components/AddReceiptButtons.tsx`:

```tsx
import { useRef } from "react";
import type { Payer } from "../types";

type Props = { onFiles(payer: Payer, files: File[]): void };

export function AddReceiptButtons({ onFiles }: Props) {
  const albumHusband = useRef<HTMLInputElement>(null);
  const albumWife = useRef<HTMLInputElement>(null);
  const cameraHusband = useRef<HTMLInputElement>(null);
  const cameraWife = useRef<HTMLInputElement>(null);

  const handle = (payer: Payer) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) onFiles(payer, files);
    e.target.value = ""; // 同じファイルの再選択を可能に
  };

  return (
    <section className="add-buttons">
      <div className="payer-group">
        <h2>夫のレシート</h2>
        <button type="button" onClick={() => albumHusband.current?.click()}>アルバムから選ぶ</button>
        <button type="button" onClick={() => cameraHusband.current?.click()}>カメラで撮る</button>
      </div>
      <div className="payer-group">
        <h2>妻のレシート</h2>
        <button type="button" onClick={() => albumWife.current?.click()}>アルバムから選ぶ</button>
        <button type="button" onClick={() => cameraWife.current?.click()}>カメラで撮る</button>
      </div>
      <input ref={albumHusband} type="file" accept="image/*" multiple hidden onChange={handle("husband")} />
      <input ref={cameraHusband} type="file" accept="image/*" capture="environment" hidden onChange={handle("husband")} />
      <input ref={albumWife} type="file" accept="image/*" multiple hidden onChange={handle("wife")} />
      <input ref={cameraWife} type="file" accept="image/*" capture="environment" hidden onChange={handle("wife")} />
    </section>
  );
}
```

- [ ] **Step 2: ReceiptRow**

`src/components/ReceiptRow.tsx`:

```tsx
import { useState } from "react";
import type { Row } from "../types";

const STATUS_LABEL: Record<Row["status"], string> = {
  "auto-high": "自動読取",
  "needs-review": "要確認",
  confirmed: "確認済",
  manual: "手入力",
  failed: "読取失敗",
};

type Props = {
  row: Row;
  onPatch(id: string, patch: Partial<Row>): void;
  onRemove(id: string): void;
};

export function ReceiptRow({ row, onPatch, onRemove }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [zoomed, setZoomed] = useState(false);

  const startEdit = () => {
    setDraft(row.amountYen === null ? "" : String(row.amountYen));
    setEditing(true);
  };
  const commitEdit = () => {
    const v = draft.trim() === "" ? null : Number(draft.replace(/[^-\d]/g, ""));
    if (v !== null && Number.isSafeInteger(v)) {
      onPatch(row.id, { amountYen: v, status: row.source === "manual" ? "manual" : "confirmed", candidates: [] });
    }
    setEditing(false);
  };

  return (
    <li className={`receipt-row status-${row.status}`}>
      {row.thumbnailUrl && (
        <img
          src={row.thumbnailUrl}
          alt={`${row.label}のサムネイル`}
          className={zoomed ? "thumb zoomed" : "thumb"}
          onClick={() => setZoomed(!zoomed)}
        />
      )}
      <div className="row-main">
        <span className="row-label">{row.label}</span>
        <span className={`badge badge-${row.status}`}>
          {row.processing ? "処理中…" : STATUS_LABEL[row.status]}
        </span>
        {editing ? (
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => e.key === "Enter" && commitEdit()}
            aria-label="金額(円)"
          />
        ) : (
          <button type="button" className="amount" onClick={startEdit}>
            {row.amountYen === null ? "金額を入力" : `${row.amountYen.toLocaleString("ja-JP")}円`}
          </button>
        )}
        {row.status === "needs-review" && row.candidates.length > 1 && (
          <div className="candidates">
            候補:
            {row.candidates.map((c) => (
              <button key={c} type="button" onClick={() => onPatch(row.id, { amountYen: c, status: "confirmed", candidates: [] })}>
                {c.toLocaleString("ja-JP")}円
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => onPatch(row.id, { payer: row.payer === "husband" ? "wife" : "husband" })}>
          {row.payer === "husband" ? "→妻へ" : "→夫へ"}
        </button>
        <button type="button" onClick={() => onRemove(row.id)}>削除</button>
      </div>
    </li>
  );
}
```

- [ ] **Step 3: App.tsxで接続**

`src/App.tsx`:

```tsx
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AddReceiptButtons } from "./components/AddReceiptButtons";
import { ReceiptRow } from "./components/ReceiptRow";
import { createOcrQueue } from "./ocr/queue";
import { createPpuPaddleEngine } from "./ocr/ppuPaddleEngine";
import { reducer, toPersisted, fromPersisted, type AppState } from "./state/reducer";
import { saveState, loadState, currentMonth } from "./state/storage";
import type { Payer, Row } from "./types";

const initialState = (): AppState => {
  const persisted = loadState();
  return persisted ? fromPersisted(persisted) : { month: currentMonth(), rows: [], saveFailed: false };
};

let nextReceiptNumber = 1;

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [ocrStatus, setOcrStatus] = useState("");
  const seenFiles = useRef(new Set<string>());

  const queue = useMemo(() => {
    const engine = createPpuPaddleEngine();
    return createOcrQueue(engine, {
      onStatus: setOcrStatus,
      onResult: (id, patch) => dispatch({ type: "updateRow", id, patch }),
    });
  }, []);

  // 自動保存(画像以外)。失敗はUI表示
  useEffect(() => {
    dispatch({ type: "setSaveFailed", value: !saveState(toPersisted(state)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.month, state.rows]);

  const onFiles = (payer: Payer, files: File[]) => {
    const rows: Row[] = [];
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seenFiles.current.has(key) && !window.confirm(`「${file.name}」は追加済みのようです。もう一度追加しますか?`)) {
        continue;
      }
      seenFiles.current.add(key);
      const id = crypto.randomUUID();
      rows.push({
        id,
        payer,
        amountYen: null,
        label: `レシート ${nextReceiptNumber++}`,
        status: "failed",
        source: "ocr",
        candidates: [],
        thumbnailUrl: URL.createObjectURL(file),
        processing: true,
      });
      queue.enqueue(id, file);
    }
    if (rows.length > 0) dispatch({ type: "addRows", rows });
  };

  const onRemove = (id: string) => {
    const row = state.rows.find((r) => r.id === id);
    if (row?.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
    dispatch({ type: "removeRow", id });
  };

  return (
    <main>
      <h1>レシート清算スキャナー <span className="month">{state.month}</span></h1>
      <AddReceiptButtons onFiles={onFiles} />
      <p aria-live="polite" className="ocr-status">{ocrStatus}</p>
      {state.saveFailed && <p role="alert" className="error">自動保存できません(端末の空き容量を確認してください)</p>}
      <ul className="receipt-list">
        {state.rows.map((row) => (
          <ReceiptRow key={row.id} row={row} onPatch={(id, patch) => dispatch({ type: "updateRow", id, patch })} onRemove={onRemove} />
        ))}
      </ul>
      {/* SummaryPanel・ManualEntryForm・新しい月 はTask 10 */}
    </main>
  );
}
```

- [ ] **Step 4: スタイル**

`src/index.css` — モバイルファースト最小限。ポイントのみ:

```css
* { box-sizing: border-box; }
body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 0; }
main { padding: 12px; padding-bottom: calc(140px + env(safe-area-inset-bottom)); max-width: 640px; margin: 0 auto; }
.add-buttons { display: flex; gap: 8px; }
.payer-group { flex: 1; border: 1px solid #ccc; border-radius: 8px; padding: 8px; }
.payer-group button { display: block; width: 100%; margin-top: 6px; padding: 10px; font-size: 15px; }
.receipt-list { list-style: none; padding: 0; }
.receipt-row { display: flex; gap: 8px; align-items: flex-start; border-bottom: 1px solid #eee; padding: 8px 0; }
.thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; }
.thumb.zoomed { width: 100%; height: auto; object-fit: contain; }
.row-main { flex: 1; }
.amount { font-size: 18px; font-weight: 700; background: none; border: 1px dashed #999; border-radius: 4px; padding: 4px 8px; }
.badge { font-size: 12px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
.badge-needs-review, .badge-failed { background: #fff3cd; border: 1px solid #b8860b; }
.badge-auto-high, .badge-confirmed, .badge-manual { background: #e6f4ea; border: 1px solid #2e7d32; }
.status-needs-review, .status-failed { background: #fffbea; }
.error { color: #b00020; }
.summary-panel { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 2px solid #333;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); max-width: 640px; margin: 0 auto; }
```

- [ ] **Step 5: 手動確認・型チェック・コミット**

```bash
npx tsc --noEmit && npx vitest run && npm run dev
```

ブラウザで画像を数枚投入→行が即座に現れ「処理中…」→金額が入ること、金額タップ編集・夫⇄妻移動・削除・重複警告が動くことを確認。

```bash
git add -A && git commit -m "feat: 取り込みUI・レシート一覧・OCR接続を実装"
```

---

### Task 10: UI — 手動追加・集計パネル・新しい月

**Files:**
- Create: `src/components/ManualEntryForm.tsx`, `src/components/SummaryPanel.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `computeTotals` / `buildSummaryText` / `clearState` / `currentMonth`(Task 6-7)

- [ ] **Step 1: ManualEntryForm**

`src/components/ManualEntryForm.tsx`:

```tsx
import { useState } from "react";
import type { Payer, Row } from "../types";

type Props = { onAdd(row: Row): void };

export function ManualEntryForm({ onAdd }: Props) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState<Payer>("husband");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = Number(amount.replace(/[^-\d]/g, ""));
    if (label.trim() === "" || !Number.isSafeInteger(v)) return;
    onAdd({
      id: crypto.randomUUID(),
      payer,
      amountYen: v,
      label: label.trim(),
      status: "manual",
      source: "manual",
      candidates: [],
    });
    setLabel("");
    setAmount("");
  };

  return (
    <form className="manual-entry" onSubmit={submit}>
      <h2>レシート以外の支出を追加(家賃・光熱費など)</h2>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名前(例: 家賃)" aria-label="支出の名前" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="金額(円)" aria-label="金額(円)" />
      <select value={payer} onChange={(e) => setPayer(e.target.value as Payer)} aria-label="支払った人">
        <option value="husband">夫が支払い</option>
        <option value="wife">妻が支払い</option>
      </select>
      <button type="submit">追加</button>
    </form>
  );
}
```

- [ ] **Step 2: SummaryPanel**

`src/components/SummaryPanel.tsx`:

```tsx
import { useState } from "react";
import { buildSummaryText, computeTotals, type AppState } from "../state/reducer";

type Props = { state: AppState; onNewMonth(): void };

const yen = (n: number) => n.toLocaleString("ja-JP");

export function SummaryPanel({ state, onNewMonth }: Props) {
  const [copied, setCopied] = useState(false);
  const t = computeTotals(state.rows);
  const direction =
    t.deltaYen > 0 ? `夫が ${yen(t.deltaYen)}円 多く支払い`
    : t.deltaYen < 0 ? `妻が ${yen(-t.deltaYen)}円 多く支払い`
    : "差額なし";

  const copy = async () => {
    if (t.unconfirmed > 0 && !window.confirm(`未確認が ${t.unconfirmed}件 あります。このままコピーしますか?`)) return;
    try {
      await navigator.clipboard.writeText(buildSummaryText(state));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.alert("コピーできませんでした");
    }
  };

  return (
    <section className="summary-panel" aria-label="集計">
      <div>夫: <b>{yen(t.husbandYen)}円</b> / 妻: <b>{yen(t.wifeYen)}円</b></div>
      <div className="delta">{direction}</div>
      {t.unconfirmed > 0 && <div className="warn">⚠ 未確認 {t.unconfirmed}件</div>}
      <div className="panel-actions">
        <button type="button" onClick={copy}>{copied ? "コピーしました" : "結果をコピー"}</button>
        <button type="button" onClick={onNewMonth}>新しい月を始める</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: App.tsxへ組み込み**

`App.tsx`のreturn内、`{/* SummaryPanel・ManualEntryForm・新しい月 はTask 10 */}`を置換:

```tsx
      <ManualEntryForm onAdd={(row) => dispatch({ type: "addRows", rows: [row] })} />
      <SummaryPanel state={state} onNewMonth={onNewMonth} />
```

`App`関数内に追加:

```tsx
  const onNewMonth = () => {
    const t = computeTotals(state.rows);
    const ok = window.confirm(
      `${state.month} のデータ(夫 ${t.husbandYen.toLocaleString("ja-JP")}円 / 妻 ${t.wifeYen.toLocaleString("ja-JP")}円)を消去して新しい月を始めますか?`,
    );
    if (!ok) return;
    for (const r of state.rows) if (r.thumbnailUrl) URL.revokeObjectURL(r.thumbnailUrl);
    seenFiles.current.clear();
    clearState();
    dispatch({ type: "clearMonth", month: currentMonth() });
  };
```

import追加: `computeTotals`(reducer)、`clearState`(storage)、`ManualEntryForm`、`SummaryPanel`。

- [ ] **Step 4: 手動確認・コミット**

```bash
npx tsc --noEmit && npx vitest run && npm run dev
```

確認: 手動行追加→集計反映、コピー(未確認ありの警告含む)、新しい月(確認ダイアログ→全消去)、リロードで金額・状態が復元(サムネイルは消えてよい)。

```bash
git add -A && git commit -m "feat: 手動追加・集計パネル・月次リセットを実装"
git push
```

---

### Task 11: 【チェックポイント】Codexレビュー#2 + 実機最終確認

- [ ] **Step 1: Codexレビュー#2**

```bash
codex exec --sandbox read-only --cd /Users/thr3eisl4nd/git/receipt_scanner \
  "全実装(src/以下とspike以外)をスペック docs/superpowers/specs/2026-07-27-receipt-scanner-design.md と突き合わせてレビューしてください。バグ・スペック逸脱・モバイルSafariで壊れる箇所・アクセシビリティ欠落を優先度付きで指摘してください。確認や質問は不要です。具体的な提案・修正案・コード例まで自主的に出力してください。"
```

指摘はオーケストレーターが検証→妥当なもののみ修正タスク化→修正→`npx vitest run`全PASS→コミット。

- [ ] **Step 2: 実機最終確認(スペック§10.3)**

妻のスマホ実機で本番URL(`https://<owner>.github.io/receipt_scanner/`)を開き、実際の月末フローを通す:
- 30枚前後の連続処理(クラッシュなし)
- 途中でバックグラウンド移行・画面ロック→復帰
- 金額修正・夫⇄妻移動・手動行追加・コピー・新しい月
- リロード後の状態復元

- [ ] **Step 3: 完了処理**

問題なければ`superpowers:finishing-a-development-branch`スキルに従って完了(このプロジェクトはmain直コミット運用なので、最終push+動作URLの共有で完了)。

---

## Self-Review結果(計画作成時)

- スペック§5.1〜5.5・§6〜§10の各要件はTask 2-4(抽出・OCR)、Task 6-7(状態・集計)、Task 8-10(UI・キュー)でカバー。§10.2の実機スパイクはTask 5、§10.3はTask 11
- ppu-paddle-ocrの正確なAPIは実装時確認が必須のため、Task 4に「READMEと型定義を読んで調整」を明示(捏造APIをコピペさせないため)
- 型・関数名はタスク間で一貫(`OcrLine`/`OcrEngine`/`Row`/`AppState`/`computeTotals`等)
