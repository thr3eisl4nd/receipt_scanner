import { Fragment, useRef, useState } from "react";
import type { Person } from "../types";
import { personColorClass } from "../personColor";

type Props = {
  people: Person[];
  onFiles(payerId: string, files: File[]): void;
  /**
   * 「テキストを貼り付けて追加」(task-25、iPhone Live Text連携)。選択中の支払者と
   * 貼り付けられたテキストをそのまま渡す。抽出(`extractTotalFromText`)・行の構築・
   * 集計への反映は呼び出し側(App)の責務にする(`onFiles`と同じ分担: このコンポーネントは
   * 入力の取得と選択中の支払者の管理だけを担う)。
   */
  onAddFromText(payerId: string, text: string): void;
};

/**
 * 取り込み導線(設計ドキュメント§17.7)。v1.3までの「人×(アルバム/カメラ)ボタン
 * グリッド」を、①支払者セグメント選択(コンパクト・選択中を明示) ②主CTA
 * 「レシートを撮る」(画面で最も強い) ③サブ導線「アルバムから選ぶ」(控えめ)へ
 * 再構成する。task-25でさらに④サブ導線「テキストを貼り付けて追加」(§18)を追加した。
 * iPhone純正のLive Text(写真アプリの「テキストをコピー」/ショートカットの「画像から
 * テキストを抽出」)で得たテキストを貼り付けると、ブラウザ内OCRより高速・高精度に
 * 合計金額を抽出できる。
 *
 * hidden file input方式・複数選択・capture属性・重複検出等の既存機能は完全に維持する。
 * 各人ごとのhidden inputは従来どおり人リストから動的生成し(`handle(person.id)`の
 * クロージャで対象人物を固定するため、どの支払者が画面上で選択中でも、その人物の
 * input要素へ直接change イベントが来れば必ずその人物へ帰属する)、画面上に見える
 * CTAボタン1組だけを「現在選択中の人」のinput参照へ紐づける。テキスト貼り付けも
 * 同じ選択中の支払者(`selectedPayerId`)に紐づく。
 */
export function AddReceiptButtons({ people, onFiles, onAddFromText }: Props) {
  const albumRefs = useRef(new Map<string, HTMLInputElement>());
  const cameraRefs = useRef(new Map<string, HTMLInputElement>());
  const [selectedId, setSelectedId] = useState<string>(() => people[0]?.id ?? "");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  // 選択中の人が削除された場合のフォールバック(ManualEntryFormと同じ方針)。
  const selectedPayerId = people.some((p) => p.id === selectedId) ? selectedId : (people[0]?.id ?? "");
  const selectedPerson = people.find((p) => p.id === selectedPayerId);

  const handle = (payerId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) onFiles(payerId, files);
    e.target.value = ""; // 同じファイルの再選択を可能に
  };

  // 「テキストを貼り付けて追加」の送信(task-25)。空欄(空白のみ含む)は追加ボタンを
  // disabledにして送信自体を防ぐが、念のためハンドラ側でも同じ判定を行う。
  // 追加後はtextareaだけをクリアし、パネルは開いたままにする(1レシート=1行の運用で、
  // 続けて次のレシートのテキストを貼り付けやすくするため)。
  const submitPaste = () => {
    const trimmed = pasteText.trim();
    if (trimmed === "") return;
    onAddFromText(selectedPayerId, trimmed);
    setPasteText("");
  };

  return (
    <section className="add-buttons" aria-label="レシートを追加">
      {/* 支払者セグメント選択(人が1人だけの場合は選ぶ意味が無いため、既存の
          「→次の人へ」非表示等と同じ方針で非表示にする)。 */}
      {people.length > 1 && (
        <div className="payer-select" role="group" aria-label="支払った人を選択">
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              className={`payer-chip ${personColorClass(person.colorIndex)}`}
              aria-pressed={person.id === selectedPayerId}
              onClick={() => setSelectedId(person.id)}
            >
              <span className="person-dot" aria-hidden="true" />
              {person.name}
            </button>
          ))}
        </div>
      )}
      <div className="capture-actions">
        <button
          type="button"
          className="capture-primary"
          /* 表示ラベル「レシートを撮る」が完全な文字列としてアクセシブルネームに含まれる
             よう、補足(誰の分か・カメラ経由か)は前後に配置する(Codexレビュー v1.4指摘
             I5: WCAG 2.5.3 Label in Name。旧「◯◯のレシートをカメラで撮る」は「カメラで」が
             「レシートを」と「撮る」の間に割り込み、表示ラベルの完全一致部分文字列を
             含んでいなかった)。 */
          aria-label={`${selectedPerson?.name ?? ""}のレシートを撮る（カメラ）`}
          onClick={() => cameraRefs.current.get(selectedPayerId)?.click()}
        >
          レシートを撮る
        </button>
        <button
          type="button"
          className="capture-secondary"
          aria-label={`${selectedPerson?.name ?? ""}のレシートをアルバムから選ぶ`}
          onClick={() => albumRefs.current.get(selectedPayerId)?.click()}
        >
          アルバムから選ぶ
        </button>
      </div>
      {/* サブ導線④「テキストを貼り付けて追加」(task-25、設計ドキュメント§18)。
          iPhone純正Live Text(写真アプリ「テキストをコピー」/ショートカット「画像から
          テキストを抽出」)由来のテキストを貼り付けると、選択中の支払者(selectedPayerId)
          へ紐づけて1レシート=1行を追加する。カメラ/アルバムの2大CTAより控えめな
          テキストボタンにし、既定は折りたたみ(タップで展開)。 */}
      <button
        type="button"
        className="paste-text-toggle"
        aria-expanded={pasteOpen}
        aria-controls="paste-text-panel"
        onClick={() => setPasteOpen((v) => !v)}
      >
        テキストを貼り付けて追加
      </button>
      {pasteOpen && (
        <div className="paste-text-panel" id="paste-text-panel">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            name="receipt-text"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${selectedPerson?.name ?? ""}のレシートのテキストを貼り付け`}
            placeholder="レシートのテキストをここに貼り付け"
            rows={4}
          />
          <div className="paste-text-actions">
            <button
              type="button"
              className="paste-text-submit"
              // App内に手動追加フォーム(ManualEntryForm)の「追加」submitボタンが常時
              // 存在するため、表示テキストは仕様通り「追加」のまま、アクセシブルネームだけ
              // aria-labelで一意にする(WCAG 2.5.3 Label in Name: 表示テキスト「追加」を
              // 末尾にそのまま含むため適合)。
              aria-label="貼り付けたテキストから追加"
              disabled={pasteText.trim() === ""}
              onClick={submitPaste}
            >
              追加
            </button>
          </div>
          {/* 使い方ガイド(折りたたみ、設計ドキュメント§18)。<details>のネイティブ
              セマンティクスを使い、JS側の開閉状態管理を持たない。 */}
          <details className="paste-text-guide">
            <summary>iPhoneで速く読み取るには</summary>
            <p>
              写真アプリでレシート写真を長押し→テキストをコピー→ここに貼り付け。
              ショートカットアプリで「画像からテキストを抽出」を使うと更に速い。
            </p>
          </details>
        </div>
      )}
      {/* hidden inputは人ごとに(アルバム→カメラの順で)まとめて生成する。DOM順序を
          人単位でまとめておくことで、複数人時のfile input一覧を「先頭からN人分ずつ」
          という単純な位置関係のまま保てる(既存テストの構造的前提)。 */}
      {people.map((person) => (
        <Fragment key={person.id}>
          <input
            ref={(el) => {
              if (el) albumRefs.current.set(person.id, el);
              else albumRefs.current.delete(person.id);
            }}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handle(person.id)}
          />
          <input
            ref={(el) => {
              if (el) cameraRefs.current.set(person.id, el);
              else cameraRefs.current.delete(person.id);
            }}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={handle(person.id)}
          />
        </Fragment>
      ))}
    </section>
  );
}
