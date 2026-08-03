/**
 * iPhone Live Text(写真アプリ「テキストをコピー」/ショートカット「画像からテキストを
 * 抽出」)を模したプレーンテキストのフィクスチャ(task-25)。
 *
 * `fixtures/synthetic.ts`(box座標モード用)と異なり、box/confidenceを持たない
 * 単純な複数行文字列。Live Textは実機観測上、レシートの各印字行をおおむね1行として
 * 改行区切りで返す(box座標モードのOCRのような複数box分割・崩れは相対的に少ない前提、
 * タスク仕様)。
 */

/** 標準的なスーパーのレシート: 小計・合計・お預り・お釣りが揃っている */
export const supermarket = `スーパーABC
ねぎ ¥98
たまご ¥298
小計 ¥1,234
合計 ¥1,332
お預り ¥2,000
お釣り ¥668`;

/** 税率別表記: 8%/10%対象が並ぶ */
export const taxBreakdown = `8%対象 ¥550
10%対象 ¥1,100
合計 ¥1,650`;

/** 合計キーワードなし(下部が切れた/レシートの一部だけコピーした) */
export const truncated = `ねぎ ¥98
たまご ¥298`;

/** ラベルと金額が別行(ラベル行の直後行)に出るケース */
export const totalOnNextLine = `ご請求額
¥3,980
お預り ¥5,000`;

/** 現計表記+全角末尾ハイフン。クレジット行(REJECT_LABELS)が別に金額を持つ */
export const genkei = `現計
￥１，６５０－
クレジット ￥１，６５０`;

/** 空文字列相当(空白のみ) */
export const blank = "   \n\n  ";

/** 敵対テスト: 合計の直後に「お預り」の金額行が続く(お預りの金額を誤って拾わない) */
export const totalFollowedByDeposit = `合計 ¥1,332
お預り ¥2,000`;

/** 敵対テスト: 電話番号(ハイフン区切り)が合計の近くにあっても金額として拾わない */
export const withPhoneNumber = `〇〇商店
電話 03-1234-5678
合計 ¥980
ありがとうございました`;

/** 敵対テスト: 強ラベルと除外語(内税)が同一行に同居 → auto-highにならない(needs-review) */
export const labelWithRejectSameLine = `合計 ¥1,100 内税 ¥100`;

/** 敵対テスト: 2つの異なる強ラベル行がそれぞれ異なる金額を主張(あいまい) */
export const ambiguousTwoTotals = `お会計 ¥6,980
合計 ¥7,000`;

/** 返金・返品(先頭に▲が付く負数)を合計として読み取れるケース */
export const refundTotal = `返品合計 ▲¥500`;

/** 崩れバリアント(「台計」)+金額。needs-reviewまで回復するがauto-highにはしない */
export const corruptedLabel = `台計 ¥1,332`;
