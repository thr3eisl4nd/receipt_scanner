import { describe, expect, test } from "vitest";
import { parseYen } from "./ReceiptRow";

/**
 * `parseYen`単体のエッジケーステスト(Codexレビュー指摘I3・I4)。
 *
 * 旧実装は「数字/マイナス以外を除去してから`Number()`で解釈する」方式だったため、
 * `1.5`→`15`、`12abc34`→`1234`、`１２３４`(全角)→空扱いのように、入力ミスが
 * 黙って別の金額として確定してしまう危険があった。ここでは許可する表記を
 * NFKC正規化で整えたうえで文字列全体を検証する新実装の境界値を直接検証する。
 * DOM経由の統合テスト(App.test.tsx)より軽量に多くのケースを網羅できる。
 */
describe("parseYen", () => {
  test("空文字列・空白のみはnull(未入力)を返す", () => {
    expect(parseYen("")).toBeNull();
    expect(parseYen("   ")).toBeNull();
  });

  test("半角数字はそのまま数値になる", () => {
    expect(parseYen("1234")).toBe(1234);
    expect(parseYen("0")).toBe(0);
  });

  test("全角数字はNFKC正規化で受理される(Codexレビュー指摘I4)", () => {
    expect(parseYen("１２３４")).toBe(1234);
  });

  test("カンマ・円記号・¥・全角カンマ・空白は除去して解釈する", () => {
    expect(parseYen("1,234")).toBe(1234);
    expect(parseYen("1,234円")).toBe(1234);
    expect(parseYen("￥1,234")).toBe(1234);
    expect(parseYen("¥ 1,234")).toBe(1234);
    expect(parseYen("１，２３４円")).toBe(1234);
  });

  test("先頭のマイナスは負数として解釈する(返品・取消)", () => {
    expect(parseYen("-1280")).toBe(-1280);
    expect(parseYen("-500")).toBe(-500);
  });

  test("非数字が混じる入力は黙って除去せず'invalid'を返す(旧実装の回帰: '12abc34'→1234は誤り)", () => {
    expect(parseYen("12abc34")).toBe("invalid");
    expect(parseYen("abc")).toBe("invalid");
    expect(parseYen("12-34")).toBe("invalid");
  });

  test("小数点混じりは'invalid'を返す(旧実装の回帰: '1.5'→15は誤り)", () => {
    expect(parseYen("1.5")).toBe("invalid");
    expect(parseYen("1234.")).toBe("invalid");
  });

  test("安全整数を超える値は'invalid'を返す", () => {
    expect(parseYen("99999999999999999999")).toBe("invalid");
  });

  test("安全整数の境界値(Number.MAX_SAFE_INTEGER)ちょうどは有効、+1は'invalid'(Codexレビュー再指摘M3)", () => {
    expect(parseYen(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseYen(String(Number.MAX_SAFE_INTEGER + 1))).toBe("invalid");
  });

  test("マイナス記号のみ・符号の重複は'invalid'を返す", () => {
    expect(parseYen("-")).toBe("invalid");
    expect(parseYen("--1234")).toBe("invalid");
  });

  test("'円'単体・カンマだけ・桁区切りの誤り・数字中の空白混入は部分除去せず'invalid'を返す(Codexレビュー再指摘I3: 除去してから解釈する方式だと'円'→null、'1,00'→100、'1 2'→12のように誤解釈されていた)", () => {
    expect(parseYen("円")).toBe("invalid");
    expect(parseYen(",,,")).toBe("invalid");
    expect(parseYen("1,00")).toBe("invalid");
    expect(parseYen("1 2")).toBe("invalid");
    expect(parseYen("1円2")).toBe("invalid");
  });
});
