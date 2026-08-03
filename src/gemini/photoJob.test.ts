import { describe, expect, test, vi } from "vitest";
import { runGeminiPhotoJob, type GeminiPhotoJobDeps } from "./photoJob";
import { UnsupportedFormatError, ImageTooLargeError } from "../image/preprocess";
import type { GeminiExtractResult } from "./client";

function makeDeps(overrides: Partial<GeminiPhotoJobDeps> = {}): GeminiPhotoJobDeps {
  const canvas = {} as HTMLCanvasElement;
  return {
    loadAsCanvas: vi.fn().mockResolvedValue(canvas),
    toThumbnailBlob: vi.fn().mockResolvedValue(new Blob(["thumb"])),
    toPreviewBlob: vi.fn().mockResolvedValue(new Blob(["preview"])),
    canvasToJpegBase64: vi.fn().mockReturnValue("BASE64"),
    extractTotalsWithGemini: vi.fn(),
    ...overrides,
  };
}

const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" });

describe("gemini/photoJob: runGeminiPhotoJob", () => {
  test("画像デコード失敗: load-errorとfailureKindを返し、Gemini呼び出し自体は行わない", async () => {
    const deps = makeDeps({ loadAsCanvas: vi.fn().mockRejectedValue(new UnsupportedFormatError()) });
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "load-error", failureKind: "unsupported-format" });
    expect(deps.extractTotalsWithGemini).not.toHaveBeenCalled();
  });

  test("画像が大きすぎる場合: failureKind:image-too-large", async () => {
    const deps = makeDeps({ loadAsCanvas: vi.fn().mockRejectedValue(new ImageTooLargeError()) });
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "load-error", failureKind: "image-too-large" });
  });

  test("正体不明のデコードエラーはfailureKind:image-decodeに分類する", async () => {
    const deps = makeDeps({ loadAsCanvas: vi.fn().mockRejectedValue(new Error("boom")) });
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "load-error", failureKind: "image-decode" });
  });

  test("成功: サムネイル・プレビューをコールバックへ届け、totalsをそのまま返す", async () => {
    const success: GeminiExtractResult = { ok: true, totals: [1200, 800] };
    const deps = makeDeps({ extractTotalsWithGemini: vi.fn().mockResolvedValue(success) });
    const onThumbnail = vi.fn();
    const onPreview = vi.fn();
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail, onPreview }, deps);

    expect(result).toEqual({ kind: "success", totals: [1200, 800] });
    expect(onThumbnail).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(deps.extractTotalsWithGemini).toHaveBeenCalledWith("key", "BASE64");
  });

  test("Gemini呼び出し失敗(レート制限等): fallbackとreasonを返す", async () => {
    const failure: GeminiExtractResult = { ok: false, reason: "rate-limit" };
    const deps = makeDeps({ extractTotalsWithGemini: vi.fn().mockResolvedValue(failure) });
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "fallback", reason: "rate-limit" });
  });

  test("サムネイル生成の失敗はbest-effort(Gemini呼び出し自体は継続する)", async () => {
    const success: GeminiExtractResult = { ok: true, totals: [500] };
    const deps = makeDeps({
      toThumbnailBlob: vi.fn().mockRejectedValue(new Error("thumb failed")),
      extractTotalsWithGemini: vi.fn().mockResolvedValue(success),
    });
    const onThumbnail = vi.fn();
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail, onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "success", totals: [500] });
    expect(onThumbnail).not.toHaveBeenCalled();
  });

  test("Base64エンコード自体が例外を投げた場合: fallback(reason:encode-error)、Gemini呼び出しは行わない", async () => {
    const deps = makeDeps({
      canvasToJpegBase64: vi.fn(() => {
        throw new Error("encode failed");
      }),
    });
    const result = await runGeminiPhotoJob(file, "key", { onThumbnail: vi.fn(), onPreview: vi.fn() }, deps);
    expect(result).toEqual({ kind: "fallback", reason: "encode-error" });
    expect(deps.extractTotalsWithGemini).not.toHaveBeenCalled();
  });
});
