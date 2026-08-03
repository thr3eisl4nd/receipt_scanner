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
  test("区切りなしの4桁以上の金額を分割しない", () => {
    expect(findMoneyTokens("合計 1332円")).toEqual([1332]);
    expect(findMoneyTokens("¥1234")).toEqual([1234]);
  });
  test("日付・電話番号など数値以外の文脈は境界チェックで除外する", () => {
    expect(findMoneyTokens("2026-07-27")).toEqual([]);
    expect(findMoneyTokens("TEL 03-1234-5678")).toEqual([]);
    expect(findMoneyTokens("No.12345678901")).toEqual([]); // 英数字隣接は不採用
  });
  test("空白区切りは¥/円が伴う場合のみ結合する", () => {
    expect(findMoneyTokens("合計 ¥1 332")).toEqual([1332]);
  });
  test("%除外は直後の空白を許容する", () => {
    expect(findMoneyTokens("10 %対象 550")).toEqual([550]);
  });
  test("個数の助数詞(点/個/本/枚/人/件/回)が直後にある裸の数字は金額として拾わない(Codexレビュー指摘、task-25: 「合計 3点」が¥3化けする穴)", () => {
    expect(findMoneyTokens("合計 3点")).toEqual([]);
    expect(findMoneyTokens("ねぎ 2個")).toEqual([]);
    expect(findMoneyTokens("ビール 6本")).toEqual([]);
    expect(findMoneyTokens("シャツ 1枚")).toEqual([]);
    expect(findMoneyTokens("大人 2人")).toEqual([]);
    expect(findMoneyTokens("3件 ¥500")).toEqual([500]); // 助数詞の後にある金額自体は引き続き拾う
    expect(findMoneyTokens("10 %対象 3 点")).toEqual([]); // 空白を挟んだ助数詞も除外する
  });
});
