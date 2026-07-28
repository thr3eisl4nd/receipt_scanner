import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAsCanvas,
  MAX_FILE_SIZE_BYTES,
  UnsupportedFormatError,
  ImageTooLargeError,
} from "./preprocess";

/**
 * `loadAsCanvas`のdecode前後の事前検証(Codexレビュー最終ゲート指摘I1)の単体テスト。
 *
 * jsdomには実Canvas描画(`getContext("2d")`)や`createImageBitmap`が無いため
 * (`src/ocr/queue.test.ts`と同様の制約)、ここで検証できるのは実decode(happy path)へ
 * 到達する前に判定が完了する経路(ファイル形式・ファイルサイズの事前検証、および
 * `createImageBitmap`をスタブしたうえでのdecode直後ピクセル数検証)に限る。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadAsCanvas: decode前の事前検証", () => {
  it("file.typeがimage/*以外の場合、decodeを試みずUnsupportedFormatErrorを投げる", async () => {
    const createImageBitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapSpy);

    const file = new File(["not-an-image"], "receipt.pdf", { type: "application/pdf" });
    await expect(loadAsCanvas(file)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
  });

  it("ファイルサイズがMAX_FILE_SIZE_BYTESを超える場合、decodeを試みずImageTooLargeErrorを投げる", async () => {
    const createImageBitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapSpy);

    const file = new File(["x"], "huge.jpg", { type: "image/jpeg" });
    // 実際に巨大なバッファを確保せず、sizeプロパティだけ上限超過値に差し替える
    Object.defineProperty(file, "size", { value: MAX_FILE_SIZE_BYTES + 1 });

    await expect(loadAsCanvas(file)).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
  });

  it("file.typeが空文字列の場合は事前検証で拒否せず、decode経路(createImageBitmap)まで進む", async () => {
    // 一部端末のHEIC等でブラウザがMIMEを設定しないケースを想定。事前検証では
    // 保留し、実際のdecode結果に委ねる(=ここでは早期rejectしないことだけを確認する)。
    const createImageBitmapSpy = vi.fn(async () => {
      throw new Error("decode boom");
    });
    vi.stubGlobal("createImageBitmap", createImageBitmapSpy);

    const file = new File(["x"], "photo.heic", { type: "" });
    await expect(loadAsCanvas(file)).rejects.toThrow();
    expect(createImageBitmapSpy).toHaveBeenCalled();
  });

  it("decode後のピクセル数がMAX_DECODED_PIXELSを超える場合、ImageTooLargeErrorを投げ、bitmapを解放する(long-edge縮小より前に弾く)", async () => {
    const closeSpy = vi.fn();
    const hugeBitmap = { width: 20000, height: 20000, close: closeSpy };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => hugeBitmap),
    );

    const file = new File(["x"], "huge.jpg", { type: "image/jpeg" });
    await expect(loadAsCanvas(file)).rejects.toBeInstanceOf(ImageTooLargeError);
    // 巨大画像判定でも、decode結果(bitmap)は確実に解放される
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("decode後のピクセル数が上限以下ならImageTooLargeErrorにはならない(サイズ超過とは別経路のエラーになる)", async () => {
    // canvas.getContext("2d")がjsdomでは使えないため実際の成功パスまでは検証できないが、
    // 「ピクセル数チェック自体は通過し、その後のdrawScaled(2D context unavailable)で
    // 失敗する」ことをもって、ImageTooLargeErrorが誤って発生しないことを確認する。
    const smallBitmap = { width: 800, height: 600, close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => smallBitmap),
    );

    const file = new File(["x"], "small.jpg", { type: "image/jpeg" });
    await expect(loadAsCanvas(file)).rejects.not.toBeInstanceOf(ImageTooLargeError);
  });
});
