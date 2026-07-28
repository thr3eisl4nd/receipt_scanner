/** width/heightを長辺maxEdgeへ縮小したcanvasへimageを描画する。 */
function drawScaled(
  image: CanvasImageSource,
  width: number,
  height: number,
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  try {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (err) {
    // 生成後にthrowした場合、描画バッファを持つcanvasを取り残さないよう即座に解放する
    // (Codexレビュー指摘: queue.ts側は「正常に返されたcanvas」しか解放できない)。
    canvas.width = 1;
    canvas.height = 1;
    throw err;
  }
}

/** File→EXIF回転適用+長辺maxEdgeへ縮小したcanvas(createImageBitmap経路)。 */
async function loadViaImageBitmap(file: File, maxEdge: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return drawScaled(bitmap, bitmap.width, bitmap.height, maxEdge);
  } finally {
    bitmap.close();
  }
}

/**
 * File→EXIF回転適用+長辺maxEdgeへ縮小したcanvas(HTMLImageElement経路)。
 *
 * `createImageBitmap(file, { imageOrientation: "from-image" })` の失敗時フォールバック。
 * `<img>` はEXIF Orientationをブラウザが解釈して描画するため、回転適用の代替になる。
 */
async function loadViaImageElement(file: File, maxEdge: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    return drawScaled(image, image.naturalWidth, image.naturalHeight, maxEdge);
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

/**
 * File→EXIF回転適用+長辺maxEdgeへ縮小したcanvas。
 *
 * `createImageBitmap(..., { imageOrientation: "from-image" })` を優先するが、
 * 最低対応iOSバージョンが未定義のため(Safari 17.2より前は同等の挙動が別の
 * 列挙値で実装されていた)、失敗時は `HTMLImageElement` 経由のフォールバックに切り替える。
 */
export async function loadAsCanvas(file: File, maxEdge = 1600): Promise<HTMLCanvasElement> {
  try {
    return await loadViaImageBitmap(file, maxEdge);
  } catch (bitmapError) {
    try {
      return await loadViaImageElement(file, maxEdge);
    } catch (fallbackError) {
      throw new Error("画像の読み込みに失敗しました(createImageBitmap/Imageともに失敗)", {
        cause: { bitmapError, fallbackError },
      });
    }
  }
}

/** 低信頼時の再試行用: グレースケール+コントラストストレッチ。 */
export function enhanceContrast(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    let min = 255,
      max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.round(((g - min) / range) * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  } catch (err) {
    // drawImage/getImageData/putImageDataが生成後にthrowした場合の明示解放
    // (Codexレビュー指摘: queue.ts側からは解放できないため関数内で自己解放する)。
    canvas.width = 1;
    canvas.height = 1;
    throw err;
  }
}
