export type OcrLine = {
  text: string;
  confidence: number; // 0..1
  box: { x: number; y: number; width: number; height: number };
};

/**
 * 検出専用API(`OcrEngine.detect()`)が返す文字box(v1.3、設計ドキュメント§16.1)。
 * 認識(recognize)を伴わない検出専用実行の結果で、テキスト・confidenceは含まない
 * (`ppu-paddle-ocr`の`DetectResult.boxes`に相当)。
 */
export type OcrBox = { x: number; y: number; width: number; height: number };

export interface OcrEngine {
  initialize(): Promise<void>;
  recognize(image: HTMLCanvasElement): Promise<OcrLine[]>;
  /**
   * 検出専用実行(認識なし・文字boxのみ)。§16.1パス1(複数レシート自動分割の領域検出)で使う。
   * 返るboxは`image`と同じ座標系(=渡したcanvasのピクセル座標)。
   */
  detect(image: HTMLCanvasElement): Promise<OcrBox[]>;
  destroy(): Promise<void>;
}
