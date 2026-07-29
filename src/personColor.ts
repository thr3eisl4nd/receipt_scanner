/**
 * 人(Person)ごとのテーマカラー(設計ドキュメント§14.1・§14.4)。
 *
 * `Person.colorIndex`は削除・再追加を経ても一意性が保証されない単なる連番のため
 * (`src/types.ts`のPersonの定義コメント参照)、そのまま`n番目のCSS変数`に対応させると
 * パレット長を超えた際に存在しないクラス名を生成してしまう。`personColorClass`で
 * パレット長(8色)へ丸め込み、`src/index.css`側の`.person-color-0`〜`.person-color-7`
 * のいずれかに必ず収まるようにする。
 *
 * 色はソフトグリーンの背景と調和する落ち着いたパレット(グリーン/テラコッタ/
 * ブルーグレー/マスタード/プラム/ティール/ダスティローズ/スレート)。色の実際の値は
 * `src/index.css`の`:root`で定義する(このモジュールはクラス名の算出のみを担う)。
 * 色だけに頼らず名前テキストを必ず併記する(既存a11y方針、§14.1)ため、ここで生成する
 * クラスは装飾用の色分けであり、識別の唯一の手段にはしない。
 */
export const PERSON_COLOR_COUNT = 8;

export function personColorClass(colorIndex: number): string {
  const normalized = ((colorIndex % PERSON_COLOR_COUNT) + PERSON_COLOR_COUNT) % PERSON_COLOR_COUNT;
  return `person-color-${normalized}`;
}
