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

/**
 * 動的な「人」モデル(v1.1、設計ドキュメント§14)。v1.0の夫/妻固定を廃止し、
 * 任意人数の人を扱えるようにする。colorIndexはUI側のカラーパレット(フェーズ2で決定)への
 * 単なる連番インデックスで、削除・再追加を経ても一意性は保証しない(重複しても実害はない)。
 */
export type Person = {
  id: string;
  name: string;
  colorIndex: number;
};

export type Row = {
  id: string;
  payerId: string;              // Person.id を参照
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

/** v1.0(夫/妻固定)が書き出していたスキーマ。`src/state/storage.ts`が読み込み時に
 *  v2へ自動移行する(設計ドキュメント§14.2)。新規に書き出すことはない。 */
export type LegacyPayer = "husband" | "wife";

export type PersistedStateV1 = {
  version: 1;
  month: string;    // "2026-07"
  updatedAt: string; // ISO 8601
  rows: Array<{
    id: string;
    payer: LegacyPayer;
    amountYen: number | null;
    label: string;
    status: VerificationStatus;
    source: "ocr" | "manual";
  }>;
};

export type PersistedStateV2 = {
  version: 2;
  month: string;    // "2026-07"
  updatedAt: string; // ISO 8601
  people: Person[]; // 1人以上
  rows: Array<{
    id: string;
    payerId: string;
    amountYen: number | null;
    label: string;
    status: VerificationStatus;
    source: "ocr" | "manual";
  }>;
};

/** アプリが現在読み書きする最新スキーマ。旧バージョン(PersistedStateV1)は
 *  `src/state/storage.ts`のloadStateが読み込み時に自動移行する。 */
export type PersistedState = PersistedStateV2;
