import { describe, expect, test } from "vitest";
import { extractTotalFromText } from "./extractTotalFromText";
import * as fx from "./fixtures/liveText";

describe("extractTotalFromText(iPhone Live Text連携のテキスト行モード抽出、task-25)", () => {
  test("標準レシート: 合計を採用し、お預り・お釣り・小計を選ばない", () => {
    const r = extractTotalFromText(fx.supermarket);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
  });

  test("税率別表記: 8%/10%対象ではなく合計を採用", () => {
    const r = extractTotalFromText(fx.taxBreakdown);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("キーワードなし: failed(手入力導線へ委ねる。最大値フォールバック禁止)", () => {
    const r = extractTotalFromText(fx.truncated);
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.candidates).toEqual([]);
  });

  test("ラベル行の直後行の金額を拾う(同一行に金額がない場合)", () => {
    const r = extractTotalFromText(fx.totalOnNextLine);
    expect(r.amountYen).toBe(3980);
    expect(r.status).toBe("auto-high");
  });

  test("現計+全角末尾ハイフン(直後行) + 別の除外語行(クレジット)には惑わされない", () => {
    const r = extractTotalFromText(fx.genkei);
    expect(r.amountYen).toBe(1650);
    expect(r.status).toBe("auto-high");
  });

  test("空文字列/空白のみはfailed", () => {
    expect(extractTotalFromText("").status).toBe("failed");
    expect(extractTotalFromText(fx.blank).status).toBe("failed");
    expect(extractTotalFromText(fx.blank).amountYen).toBeNull();
  });

  // --- 敵対テスト(タスク仕様: 小計/お預り/電話番号) ---

  test("敵対テスト(小計): 小計行自身の金額が合計として誤検出されない(標準レシートに内包済みだが単体でも確認)", () => {
    const r = extractTotalFromText("小計 ¥1,234\n合計 ¥1,332");
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
    expect(r.candidates).not.toContain(1234);
  });

  test("敵対テスト(お預り): 合計の直後行がお預りの金額でも、お預りの金額を合計として拾わない", () => {
    const r = extractTotalFromText(fx.totalFollowedByDeposit);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("auto-high");
    expect(r.candidates).not.toContain(2000);
  });

  test("敵対テスト(電話番号): ハイフン区切りの電話番号を金額として拾わない", () => {
    const r = extractTotalFromText(fx.withPhoneNumber);
    expect(r.amountYen).toBe(980);
    expect(r.status).toBe("auto-high");
    expect(r.candidates.some((c) => String(c).includes("31234") || c > 10_000_000)).toBe(false);
  });

  test("敵対テスト(電話番号・桁区切りなし): 電話ラベル自身の行はどんな金額表現でも候補にならない", () => {
    const r = extractTotalFromText("電話0312345678\n合計 ¥500");
    expect(r.amountYen).toBe(500);
    expect(r.status).toBe("auto-high");
  });

  // --- 曖昧なケース(needs-review) ---

  test("強ラベルと除外語(内税)が同一行に同居 → needs-review。金額自体は候補に残る", () => {
    const r = extractTotalFromText(fx.labelWithRejectSameLine);
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toContain(1100);
    expect(r.amountYen).toBe(1100);
  });

  test("異なる2つの強ラベルがそれぞれ異なる金額を主張(あいまい) → needs-review", () => {
    const r = extractTotalFromText(fx.ambiguousTwoTotals);
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toContain(7000);
    expect(r.candidates).toContain(6980);
  });

  test("崩れバリアント(台計)はneeds-reviewまで回復するがauto-highにはならない", () => {
    const r = extractTotalFromText(fx.corruptedLabel);
    expect(r.amountYen).toBe(1332);
    expect(r.status).toBe("needs-review");
  });

  test("1行に複数の金額トークンがあるとauto-high不可(needs-review)", () => {
    const r = extractTotalFromText("合計 ¥1,100 ¥100");
    expect(r.status).toBe("needs-review");
    expect(r.candidates).toEqual([1100, 100]);
  });

  // --- 円整数・上限・負数ルールの継承確認 ---

  test("返品(先頭▲)の負数を合計として読み取れる", () => {
    const r = extractTotalFromText(fx.refundTotal);
    expect(r.amountYen).toBe(-500);
    expect(r.status).toBe("auto-high");
  });

  test("上限(MAX_YEN=1000万円)を超える金額は候補にならない(normalize.tsのルールを継承)", () => {
    const r = extractTotalFromText("合計 ¥99,000,000");
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
  });

  test("safe integerを超える桁数の値は候補にならない(normalizeMoneyToken既存ルール)", () => {
    // 20桁の連続数字はNumber.isSafeIntegerで弾かれる
    const r = extractTotalFromText("合計 12345678901234567890");
    expect(r.amountYen).toBeNull();
    expect(r.status).toBe("failed");
  });

  // --- Codexレビュー指摘の回帰テスト(task-25) ---
  // 実際にcodex execで3件のauto-high誤判定を再現・検証したうえで反映した修正。

  test("Codexレビュー指摘: ラベル直後の明細行(商品名+金額)まで合計として自動確定しない", () => {
    // 「合計」の直後行が金額だけでなく品目名も含む場合、直後行経由の安全化
    // (isStandaloneMoneyLine)がないと誤ってauto-highになっていた(修正前に再現済み)。
    const r = extractTotalFromText("合計\n商品A ¥100");
    expect(r.status).not.toBe("auto-high");
    expect(r.amountYen).toBe(100); // 候補としては残る(needs-reviewでユーザーが確認できる)
  });

  test("Codexレビュー指摘: 異なる強ラベルが異なる金額を主張する場合、スコア差だけでauto-high確定しない", () => {
    // 「合計 ¥1,000」(同一行、スコア60)と「ご請求額」の直後行「900」(スコア40)の
    // ように、スコア差(20点)があっても2つの異なる強ラベル由来の異なる金額が競合する
    // 場合はauto-highにしない(修正前は上位候補のスコアが閾値を満たせば自動確定していた)。
    const r = extractTotalFromText("合計 ¥1,000\nご請求額\n900");
    expect(r.status).not.toBe("auto-high");
    expect(r.candidates).toContain(1000);
    expect(r.candidates).toContain(900);
  });

  test("Codexレビュー指摘: ラベル単独行の直後が除外語行(お預り等)の場合は候補にすらならない(failed)", () => {
    // 「合計」自身には金額がなく、直後行が除外語(お預り)行の場合、お預りの金額を
    // 直後行経由の候補にしない(isRejectLine(t)による全面除外、既存の設計通り)。
    const r = extractTotalFromText("合計\nお預り ¥2,000");
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  test("Codexレビュー指摘: 強ラベルと除外語の同一行同居は、単一金額でもneeds-review(isRejectLine(sourceText)単体のガードを検証)", () => {
    // 既存の「合計 ¥1,100 内税 ¥100」テストは複数トークン(1100/100)でも同時に
    // ブロックされるため、除外語同居単体のガード(tokens.length>1に依存しない経路)を
    // 検証できていなかった(Codexレビュー指摘)。ここでは金額を1つだけにして分離する。
    const r = extractTotalFromText("合計 ¥1,100 (内税)");
    expect(r.status).toBe("needs-review");
    expect(r.amountYen).toBe(1100);
  });

  test("Codexレビュー指摘: 通貨記号のない直後行の金額はauto-highにならない(スコア閾値未達)", () => {
    const r = extractTotalFromText("ご請求額\n3980");
    expect(r.status).not.toBe("auto-high");
    expect(r.amountYen).toBe(3980);
  });

  test("Codexレビュー指摘: 「合計 3点」のような個数表記を¥3として自動確定しない(normalize.tsの助数詞除外を継承)", () => {
    const r = extractTotalFromText("合計 3点");
    expect(r.status).toBe("failed");
    expect(r.amountYen).toBeNull();
  });
});
