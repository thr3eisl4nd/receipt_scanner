export type OcrLine = {
  text: string;
  confidence: number; // 0..1
  box: { x: number; y: number; width: number; height: number };
};

export interface OcrEngine {
  initialize(): Promise<void>;
  recognize(image: HTMLCanvasElement): Promise<OcrLine[]>;
  destroy(): Promise<void>;
}
