import { Fragment, useRef, useState } from "react";
import type { Person } from "../types";
import { personColorClass } from "../personColor";

type Props = { people: Person[]; onFiles(payerId: string, files: File[]): void };

/**
 * 取り込み導線(設計ドキュメント§17.7)。v1.3までの「人×(アルバム/カメラ)ボタン
 * グリッド」を、①支払者セグメント選択(コンパクト・選択中を明示) ②主CTA
 * 「レシートを撮る」(画面で最も強い) ③サブ導線「アルバムから選ぶ」(控えめ)へ
 * 再構成する。
 *
 * hidden file input方式・複数選択・capture属性・重複検出等の既存機能は完全に維持する。
 * 各人ごとのhidden inputは従来どおり人リストから動的生成し(`handle(person.id)`の
 * クロージャで対象人物を固定するため、どの支払者が画面上で選択中でも、その人物の
 * input要素へ直接change イベントが来れば必ずその人物へ帰属する)、画面上に見える
 * CTAボタン1組だけを「現在選択中の人」のinput参照へ紐づける。
 */
export function AddReceiptButtons({ people, onFiles }: Props) {
  const albumRefs = useRef(new Map<string, HTMLInputElement>());
  const cameraRefs = useRef(new Map<string, HTMLInputElement>());
  const [selectedId, setSelectedId] = useState<string>(() => people[0]?.id ?? "");

  // 選択中の人が削除された場合のフォールバック(ManualEntryFormと同じ方針)。
  const selectedPayerId = people.some((p) => p.id === selectedId) ? selectedId : (people[0]?.id ?? "");
  const selectedPerson = people.find((p) => p.id === selectedPayerId);

  const handle = (payerId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) onFiles(payerId, files);
    e.target.value = ""; // 同じファイルの再選択を可能に
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
          aria-label={`${selectedPerson?.name ?? ""}のレシートをカメラで撮る`}
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
