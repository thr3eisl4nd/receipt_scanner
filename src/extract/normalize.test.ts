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
