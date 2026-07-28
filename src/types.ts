export type VerificationStatus =
  | "auto-high"     // キーワード一致・高信頼で自動確定
  | "needs-review"  // 候補はあるが要確認
  | "confirmed"     // ユーザーが確認済み
  | "manual"        // 手入力
  | "failed";       // OCR失敗(金額空欄)

/**
 * 失敗行の原因種別(Codexレビュー最終ゲート指摘I1)。
 *
 * 従来は画像デコード失敗・未対応形式・巨大画像・OCR推論失敗のすべてが同一の
 * `status:"failed"`へ潰されており、UIも「読取失敗」の一律表示だった。原因ごとに
 * ユーザーが取れる回復行動が異なる(デコード失敗/未対応形式/巨大画像は同じFileを
 * 再試行しても無意味、OCR失敗は再試行に意味がある)ため、Row(表示専用・永続化対象外)
 * とキューのやり取りで原因を区別する。
 */
export type FailureKind =
  | "image-decode"        // 画像の読み込み自体に失敗(破損ファイル等)
  | "unsupported-format"  // 対応していない画像形式
  | "image-too-large"     // ファイルサイズ or デコード後ピクセル数が上限超過
  | "ocr";                // 画像は読めたがOCR推論(認識/抽出)に失敗

export type Payer = "husband" | "wife";

export type Row = {
  id: string;
  payer: Payer;
  amountYen: number | null;
  label: string;               // 手動行の名前 or "レシート 3" 等
  status: VerificationStatus;
  source: "ocr" | "manual";
  candidates: number[];        // needs-review時の候補(上位2〜3件)
  thumbnailUrl?: string;       // Object URL(一覧表示用、320px)。メモリ上のみ、永続化しない
  previewUrl?: string;         // Object URL(拡大表示用、1280px)。メモリ上のみ、永続化しない
  processing?: boolean;        // OCR処理中フラグ
  failureKind?: FailureKind;   // status:"failed"時の原因種別。メモリ上のみ、永続化しない
};

export type PersistedState = {
  version: 1;
  month: string;    // "2026-07"
  updatedAt: string; // ISO 8601
  rows: Array<Pick<Row, "id" | "payer" | "amountYen" | "label" | "status" | "source">>;
};
