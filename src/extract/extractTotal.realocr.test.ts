import { describe, expect, it } from "vitest";
import { extractTotal } from "./extractTotal";
import { realOcrSample } from "./fixtures/realOcrSample";

describe("extractTotal (実OCR出力での回帰確認)", () => {
  it("ppu-paddle-ocr(Node, PP-OCRv6 small)の実際の認識結果から合計金額をauto-highで抽出できる", () => {
    const result = extractTotal(realOcrSample);
    expect(result.status).toBe("auto-high");
    expect(result.amountYen).toBe(1332);
  });
});
