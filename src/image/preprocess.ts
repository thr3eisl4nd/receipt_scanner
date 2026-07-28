/**
 * decode前後の事前検証で使う上限値(Codexレビュー最終ゲート指摘I1)。
 *
 * - `MAX_FILE_SIZE_BYTES`: iPhoneの通常撮影(HEIC/JPEG、数MB程度)を大きく超える
 *   ファイルは、decode自体がメモリを圧迫する前に弾く。
 * - `MAX_DECODED_PIXELS`: iPhoneのProRAW最大級(48MP、8064×6048≈48.8M)を許容
 *   しつつ、パノラマ・破損データ等の異常に巨大な画像はdecode直後(まだ長辺縮小前)に弾く。
 */
export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;
export const MAX_DECODED_PIXELS = 60_000_000;

/** 画像デコードの失敗種別を`Row.failureKind`(Codexレビュー最終ゲート指摘I1)へ
 *  分類できるよう、`instanceof`で判別可能な専用エラーを用意する。 */
export class UnsupportedFormatError extends Error {
  constructor() {
    super("この画像形式には対応していません");
    this.name = "UnsupportedFormatError";
  }
}

export class ImageTooLargeError extends Error {
  constructor(message = "画像が大きすぎます") {
    super(message);
    this.name = "ImageTooLargeError";
  }
}

export class ImageDecodeError extends Error {
  constructor(options?: ErrorOptions) {
    super("画像の読み込みに失敗しました(createImageBitmap/Imageともに失敗)", options);
    this.name = "ImageDecodeError";
  }
}

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
    // 長辺縮小(drawScaled)より前、decode直後のピクセル数を検証する(Codexレビュー
    // 最終ゲート指摘I1)。ここで弾かないと、異常に巨大な画像のdecode結果を
    // そのままdrawImageへ渡すことになり、低メモリ端末でタブごとクラッシュしうる。
    if (bitmap.width * bitmap.height > MAX_DECODED_PIXELS) {
      throw new ImageTooLargeError();
    }
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
    // loadViaImageBitmapと同様、decode直後のピクセル数を検証する(Codexレビュー
    // 最終ゲート指摘I1)。
    if (image.naturalWidth * image.naturalHeight > MAX_DECODED_PIXELS) {
      throw new ImageTooLargeError();
    }
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
 *
 * decode前にファイル形式・サイズの事前検証を行い、decode後にはピクセル数を検証する
 * (Codexレビュー最終ゲート指摘I1)。それぞれ`UnsupportedFormatError`/
 * `ImageTooLargeError`として投げ分け、呼び出し側(`ocr/queue.ts`)が`Row.failureKind`
 * を原因別に分類できるようにする。`ImageTooLargeError`はどちらのdecode経路で
 * 発生しても同じ結論(画像が大きすぎる)になるため、フォールバックせずそのまま伝播する。
 */
export async function loadAsCanvas(file: File, maxEdge = 1600): Promise<HTMLCanvasElement> {
  // 事前検証1: ファイル形式。file.typeが空(一部端末のHEIC等でブラウザがMIMEを
  // 設定しない場合がある)なら判定を保留し、実際のdecode結果に委ねる。
  if (file.type !== "" && !file.type.startsWith("image/")) {
    throw new UnsupportedFormatError();
  }
  // 事前検証2: ファイルサイズ。decodeそのものが重くメモリを圧迫する前に弾く。
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new ImageTooLargeError(
      `画像のファイルサイズが大きすぎます(上限${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB)`,
    );
  }

  try {
    return await loadViaImageBitmap(file, maxEdge);
  } catch (bitmapError) {
    if (bitmapError instanceof ImageTooLargeError) throw bitmapError;
    try {
      return await loadViaImageElement(file, maxEdge);
    } catch (fallbackError) {
      if (fallbackError instanceof ImageTooLargeError) throw fallbackError;
      throw new ImageDecodeError({ cause: { bitmapError, fallbackError } });
    }
  }
}

/**
 * OCR用に既に縮小済みのcanvasから、指定した長辺・品質でJPEG Blobを生成する共通実装。
 * `toThumbnailBlob`(一覧表示用320px)と`toPreviewBlob`(拡大表示用1280px、
 * Codexレビュー最終ゲート指摘I2)の両方から使う。
 */
async function toScaledJpegBlob(src: HTMLCanvasElement, maxEdge: number, quality: number): Promise<Blob> {
  const scaled = drawScaled(src, src.width, src.height, maxEdge);
  try {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        scaled.toBlob((b) => resolve(b), "image/jpeg", quality);
      } catch (err) {
        reject(err);
      }
    });
    if (!blob) throw new Error("画像Blob生成に失敗しました(toBlobがnullを返却)");
    return blob;
  } finally {
    // 生成後は即座に解放する(queue.ts releaseCanvasと同じ方針)。
    scaled.width = 1;
    scaled.height = 1;
  }
}

/**
 * OCR用に既に縮小済みのcanvasから、表示用サムネイルのBlobを生成する
 * (長辺maxEdgeへ再縮小、JPEG)。元画像のフルサイズObject URLをApp側で持ち続ける
 * とメモリを圧迫するため(Codexレビュー指摘I1)、OCRキューが処理の過程で既に
 * 作った縮小canvasを再利用してサムネイルだけ別途生成する。
 */
export async function toThumbnailBlob(src: HTMLCanvasElement, maxEdge = 320): Promise<Blob> {
  return toScaledJpegBlob(src, maxEdge, 0.85);
}

/**
 * 拡大表示用のプレビューBlobを生成する(長辺1280px、JPEG品質0.85)。
 * 320pxサムネイルはRetina画面で拡大すると金額等の小さい文字が読めなくなるため
 * (Codexレビュー最終ゲート指摘I2)、サムネイルとは別に目視確認に耐える解像度で
 * もう1枚生成する。サムネイルと同じくOCRキューが処理済みcanvasから生成し、
 * best-effort(失敗してもOCR結果には影響しない)で扱う。
 */
export async function toPreviewBlob(src: HTMLCanvasElement, maxEdge = 1280): Promise<Blob> {
  return toScaledJpegBlob(src, maxEdge, 0.85);
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
