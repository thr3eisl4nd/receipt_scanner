export type VerificationStatus =
  | "auto-high"     // キーワード一致・高信頼で自動確定
  | "needs-review"  // 候補はあるが要確認
  | "confirmed"     // ユーザーが確認済み
  | "manual"        // 手入力
  | "failed";       // OCR失敗(金額空欄)

export type Payer = "husband" | "wife";

export type Row = {
  id: string;
  payer: Payer;
  amountYen: number | null;
  label: string;               // 手動行の名前 or "レシート 3" 等
  status: VerificationStatus;
  source: "ocr" | "manual";
  candidates: number[];        // needs-review時の候補(上位2〜3件)
  thumbnailUrl?: string;       // Object URL。メモリ上のみ、永続化しない
  processing?: boolean;        // OCR処理中フラグ
};

export type PersistedState = {
  version: 1;
  month: string;    // "2026-07"
  updatedAt: string; // ISO 8601
  rows: Array<Pick<Row, "id" | "payer" | "amountYen" | "label" | "status" | "source">>;
};
