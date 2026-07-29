import { useRef } from "react";
import type { Person } from "../types";

type Props = { people: Person[]; onFiles(payerId: string, files: File[]): void };

export function AddReceiptButtons({ people, onFiles }: Props) {
  // 人数が可変になったため、人ごとに固定refを持つのではなくid→要素のMapで管理する
  // (設計ドキュメント§14.1: 取り込みボタン群は人リストから動的生成)。
  const albumRefs = useRef(new Map<string, HTMLInputElement>());
  const cameraRefs = useRef(new Map<string, HTMLInputElement>());

  const handle = (payerId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) onFiles(payerId, files);
    e.target.value = ""; // 同じファイルの再選択を可能に
  };

  return (
    <section className="add-buttons">
      {people.map((person) => (
        <div className="payer-group" key={person.id}>
          <h2>{person.name}のレシート</h2>
          {/* 人ごとの「アルバムから選ぶ」「カメラで撮る」は視覚的なテキストが同一のため、
              スクリーンリーダーのボタン一覧で対象を判別できない(Codexレビュー指摘I9)。
              aria-labelで行き先を明示する(表示テキスト自体は変更しない)。 */}
          <button
            type="button"
            aria-label={`${person.name}のレシートをアルバムから選ぶ`}
            onClick={() => albumRefs.current.get(person.id)?.click()}
          >
            アルバムから選ぶ
          </button>
          <button
            type="button"
            aria-label={`${person.name}のレシートをカメラで撮る`}
            onClick={() => cameraRefs.current.get(person.id)?.click()}
          >
            カメラで撮る
          </button>
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
        </div>
      ))}
    </section>
  );
}
