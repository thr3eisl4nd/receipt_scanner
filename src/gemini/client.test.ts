import { describe, expect, test, vi } from "vitest";
import {
  GEMINI_MODEL,
  buildGeminiRequestBody,
  extractTotalsWithGemini,
  parseGeminiResponseBody,
} from "./client";

/** `candidates[0].content.parts[0].text`にJSON配列文字列を積んだ、実レスポンスを模したbody。 */
function bodyWithText(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("gemini/client: buildGeminiRequestBody", () => {
  test("contents/parts(text+inline_data)とgenerationConfig.responseSchemaを持つ", () => {
    const body = buildGeminiRequestBody("BASE64DATA") as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseMimeType: string; responseSchema: unknown };
    };
    expect(body.contents).toHaveLength(1);
    const parts = body.contents[0].parts;
    expect(parts[0]).toMatchObject({ text: expect.any(String) });
    expect(parts[1]).toEqual({ inline_data: { mime_type: "image/jpeg", data: "BASE64DATA" } });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toMatchObject({
      type: "array",
      items: { type: "object", properties: { total: { type: "integer" } }, required: ["total"] },
    });
  });

  test("プロンプトは合計金額の抽出のみを指示し、画像内テキストからの指示介入を無視するよう明示する(プロンプトインジェクション対策)", () => {
    const body = buildGeminiRequestBody("x") as { contents: Array<{ parts: Array<{ text?: string }> }> };
    const prompt = body.contents[0].parts[0].text ?? "";
    expect(prompt).toContain("合計");
    expect(prompt.length).toBeGreaterThan(0);
    // 画像内容に埋め込まれた指示文へ従わないよう明示していること
    expect(prompt).toMatch(/指示|無視/);
  });
});

describe("gemini/client: parseGeminiResponseBody", () => {
  test("[{total:1234}]形式の1件を数値配列へ変換する", () => {
    const body = bodyWithText(JSON.stringify([{ total: 1234 }]));
    expect(parseGeminiResponseBody(body)).toEqual([1234]);
  });

  test("複数レシート(複数要素)をそのままの順序で返す(1レシート=1行)", () => {
    const body = bodyWithText(JSON.stringify([{ total: 500 }, { total: 1980 }, { total: 300 }]));
    expect(parseGeminiResponseBody(body)).toEqual([500, 1980, 300]);
  });

  test("負の値・小数・非数は要素ごとに除外する(有効な値が1件でも残れば採用)", () => {
    const body = bodyWithText(JSON.stringify([{ total: 1000 }, { total: -50 }, { total: 12.5 }, { total: "1000" }]));
    expect(parseGeminiResponseBody(body)).toEqual([1000]);
  });

  test("空配列はnull(呼び出し側でフォールバック対象にする)", () => {
    expect(parseGeminiResponseBody(bodyWithText("[]"))).toBeNull();
  });

  test("全要素が無効な場合もnull", () => {
    expect(parseGeminiResponseBody(bodyWithText(JSON.stringify([{ total: -1 }, { total: null }])))).toBeNull();
  });

  test("JSONとして壊れているtextはnull", () => {
    expect(parseGeminiResponseBody(bodyWithText("not json"))).toBeNull();
  });

  test("配列でないtext(オブジェクト単体等)はnull", () => {
    expect(parseGeminiResponseBody(bodyWithText(JSON.stringify({ total: 1000 })))).toBeNull();
  });

  test("candidates/content/parts/textの経路自体が欠けているレスポンスはnull", () => {
    expect(parseGeminiResponseBody({})).toBeNull();
    expect(parseGeminiResponseBody(null)).toBeNull();
    expect(parseGeminiResponseBody({ candidates: [] })).toBeNull();
  });
});

describe("gemini/client: extractTotalsWithGemini", () => {
  test("200成功: totalsを返す", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, bodyWithText(JSON.stringify([{ total: 800 }]))));
    const result = await extractTotalsWithGemini("test-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: true, totals: [800] });

    // リクエスト先・ヘッダ(x-goog-api-key)の検証
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("429: rate-limit失敗", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" }));
    const result = await extractTotalsWithGemini("test-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "rate-limit" });
  });

  test("401/500等の非2xx: http-error失敗", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const result = await extractTotalsWithGemini("bad-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "http-error" });
  });

  test("fetch自体が例外(オフライン等): network失敗", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await extractTotalsWithGemini("test-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "network" });
  });

  test("200だがJSONとして壊れている/解釈できない: parse-error失敗", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const result = await extractTotalsWithGemini("test-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "parse-error" });
  });

  test("200だが合計が1件も抽出できない(空配列等): parse-error失敗", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, bodyWithText("[]")));
    const result = await extractTotalsWithGemini("test-key", "BASE64", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "parse-error" });
  });
});
