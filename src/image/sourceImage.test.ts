import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSourceImage, computeCropGeometry } from "./sourceImage";
import { UnsupportedFormatError, ImageTooLargeError, MAX_FILE_SIZE_BYTES } from "./preprocess";

/**
 * `loadSourceImage`のdecode前後の事前検証・`computeCropGeometry`の純粋計算を検証する。
 * jsdomには実Canvas描画(`getContext("2d")`)や`createImageBitmap`が無いため
 * (`src/ocr/queue.test.ts`・`src/image/preprocess.test.ts`と同様の制約)、
 * 実際のcanvas描画(cropToCanvas内部のdrawImage)は検証できない。そのため、
 * クロップ矩形・出力寸法の計算ロジックは`computeCropGeometry`として切り出し、
 * canvasを介さずに直接ユニットテストする。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSourceImage: decode前の事前検証", () => {
  it("file.typeがimage/*以外の場合、decodeを試みずUnsupportedFormatErrorを投げる", async () => {
    const createImageBitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapSpy);

    const file = new File(["x"], "receipt.pdf", { type: "application/pdf" });
    await expect(loadSourceImage(file)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
  });

  it("ファイルサイズがMAX_FILE_SIZE_BYTESを超える場合、decodeを試みずImageTooLargeErrorを投げる", async () => {
    const createImageBitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapSpy);

    const file = new File(["x"], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: MAX_FILE_SIZE_BYTES + 1 });

    await expect(loadSourceImage(file)).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
  });

  it("decode後のピクセル数がMAX_DECODED_PIXELSを超える場合、ImageTooLargeErrorを投げ、bitmapを解放する", async () => {
    const closeSpy = vi.fn();
    const hugeBitmap = { width: 20000, height: 20000, close: closeSpy };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => hugeBitmap),
    );

    const file = new File(["x"], "huge.jpg", { type: "image/jpeg" });
    await expect(loadSourceImage(file)).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("decode成功時はwidth/heightを公開し、close()はbitmap.close()へ委譲する(複数回呼んでも安全)", async () => {
    const closeSpy = vi.fn();
    const bitmap = { width: 3000, height: 4000, close: closeSpy };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );

    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    const source = await loadSourceImage(file);
    expect(source.width).toBe(3000);
    expect(source.height).toBe(4000);

    source.close();
    source.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("computeCropGeometry: 正規化座標→元解像度クロップ矩形+再拡大なしの出力寸法", () => {
  it("正規化矩形を元解像度へ展開する", () => {
    const geom = computeCropGeometry({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 }, 4000, 8000, 1600);
    expect(geom.sx).toBe(1000);
    expect(geom.sy).toBe(4000);
    expect(geom.sw).toBe(1000);
    expect(geom.sh).toBe(2000);
  });

  it("長辺がmaxEdgeを超える場合は縮小し、アスペクト比を維持する", () => {
    const geom = computeCropGeometry({ x: 0, y: 0, width: 1, height: 1 }, 4000, 2000, 1600);
    // 長辺(4000)を1600へ縮小 → scale=0.4 → dw=1600, dh=800
    expect(geom.dw).toBe(1600);
    expect(geom.dh).toBe(800);
  });

  it("クロップ後の寸法がmaxEdge以下の場合は再拡大しない(scaleは1でクランプ)", () => {
    const geom = computeCropGeometry({ x: 0, y: 0, width: 0.1, height: 0.1 }, 4000, 4000, 1600);
    // sw=sh=400、maxEdge(1600)より小さいので等倍のまま
    expect(geom.dw).toBe(400);
    expect(geom.dh).toBe(400);
  });

  it("画像範囲を超える矩形は範囲内にクランプする", () => {
    const geom = computeCropGeometry({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 1000, 1600);
    expect(geom.sx).toBe(900);
    expect(geom.sy).toBe(900);
    expect(geom.sw).toBe(100); // 1000-900に切り詰め
    expect(geom.sh).toBe(100);
  });

  it("幅・高さは最小1にクランプする(0除算・0サイズcanvas回避)", () => {
    const geom = computeCropGeometry({ x: 0, y: 0, width: 0, height: 0 }, 1000, 1000, 1600);
    expect(geom.sw).toBeGreaterThanOrEqual(1);
    expect(geom.sh).toBeGreaterThanOrEqual(1);
    expect(geom.dw).toBeGreaterThanOrEqual(1);
    expect(geom.dh).toBeGreaterThanOrEqual(1);
  });
});
