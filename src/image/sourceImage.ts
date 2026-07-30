/**
 * v1.3(複数レシート自動分割、設計ドキュメント§16.1/§16.2 point5)向けの画像ソース。
 *
 * `src/image/preprocess.ts`の`loadAsCanvas`は「EXIF回転補正+長辺maxEdgeへ縮小した
 * 1枚のcanvas」を返す(1枚レシート運用との後方互換のため、単一領域の場合はそのまま
 * 使い続ける)。これに対し本モジュールは、複数レシート写真を領域ごとに分割する際に
 * 必要な「元解像度からの軸平行クロップ(再拡大はしない)」を提供する。
 *
 * ImageBitmapを保持し続け、複数回のクロップ(領域の数だけ)に使い回してから
 * 明示的に`close()`する(§16.4: 「ImageBitmapは写真のN領域処理完了でclose()」)。
 */
import { UnsupportedFormatError, ImageTooLargeError, ImageDecodeError, MAX_FILE_SIZE_BYTES, MAX_DECODED_PIXELS } from "./preprocess";

/** 0..1の正規化座標(画像自身のwidth/heightに対する比率)で表した矩形。
 *  再試行(`RetrySource`)時にも同じFileへ対して再適用できるよう、絶対px座標ではなく
 *  正規化座標で保持する。 */
export type NormalizedRect = { x: number; y: number; width: number; height: number };

export type SourceImage = {
  readonly width: number;
  readonly height: number;
  /**
   * 正規化座標(0..1)を元解像度へ展開してクロップし、長辺`maxEdge`へ正規化する
   * (§16.2 point5「クロップは縮小前の元解像度から行う」。再拡大はしない)。
   */
  cropToCanvas(rect: NormalizedRect, maxEdge: number): HTMLCanvasElement;
  /** ImageBitmap(またはフォールバック経路の内部リソース)を解放する。複数回呼んでも安全。 */
  close(): void;
};

/** `cropToCanvas`が計算する幾何(クロップ元矩形sx/sy/sw/sh、出力先寸法dw/dh)。
 *  canvas描画を伴わない純粋計算として切り出すことでユニットテスト可能にする。 */
export type CropGeometry = { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number };

/**
 * 正規化座標(0..1)を元解像度(`sourceWidth`×`sourceHeight`)へ展開し、`maxEdge`へ
 * 正規化した出力寸法を計算する(§16.2 point5・§16.4「再拡大はしない」)。
 */
export function computeCropGeometry(
  rect: NormalizedRect,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
): CropGeometry {
  const sx = Math.max(0, Math.min(sourceWidth, Math.round(rect.x * sourceWidth)));
  const sy = Math.max(0, Math.min(sourceHeight, Math.round(rect.y * sourceHeight)));
  const sw = Math.max(1, Math.min(sourceWidth - sx, Math.round(rect.width * sourceWidth)));
  const sh = Math.max(1, Math.min(sourceHeight - sy, Math.round(rect.height * sourceHeight)));

  // 再拡大はしない(§16.2 point5・§16.4)。
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  return { sx, sy, sw, sh, dw, dh };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

async function decodeViaImageBitmap(file: File): Promise<Decoded> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

/**
 * `createImageBitmap(file, {imageOrientation:"from-image"})`失敗時のフォールバック
 * (`src/image/preprocess.ts`の`loadViaImageElement`と同じ考え方)。
 */
async function decodeViaImageElement(file: File): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = "";
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * File→デコード(ImageBitmap保持、失敗時はHTMLImageElementへフォールバック)。
 *
 * decode前後の検証(ファイル形式・サイズ・デコード後ピクセル数)は`preprocess.ts`の
 * `loadAsCanvas`と同じ上限値・エラー種別を再利用する(Codexレビュー方針:
 * 「既存loadAsCanvasは1枚経路との互換のため維持しつつ内部を共通化してよい」)。
 */
export async function loadSourceImage(file: File): Promise<SourceImage> {
  if (file.type !== "" && !file.type.startsWith("image/")) {
    throw new UnsupportedFormatError();
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new ImageTooLargeError(
      `画像のファイルサイズが大きすぎます(上限${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`,
    );
  }

  let decoded: Decoded;
  try {
    decoded = await decodeViaImageBitmap(file);
  } catch (bitmapError) {
    try {
      decoded = await decodeViaImageElement(file);
    } catch (fallbackError) {
      throw new ImageDecodeError({ cause: { bitmapError, fallbackError } });
    }
  }

  if (decoded.width * decoded.height > MAX_DECODED_PIXELS) {
    decoded.release();
    throw new ImageTooLargeError();
  }

  const { source, width, height, release } = decoded;
  let closed = false;

  return {
    width,
    height,
    cropToCanvas(rect: NormalizedRect, maxEdge: number): HTMLCanvasElement {
      const { sx, sy, sw, sh, dw, dh } = computeCropGeometry(rect, width, height, maxEdge);

      const canvas = document.createElement("canvas");
      try {
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D context unavailable");
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
        return canvas;
      } catch (err) {
        canvas.width = 1;
        canvas.height = 1;
        throw err;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      release();
    },
  };
}
