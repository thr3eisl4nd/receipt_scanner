import { useRef } from "react";
import type { Payer } from "../types";

type Props = { onFiles(payer: Payer, files: File[]): void };

const PAYER_LABEL: Record<Payer, string> = { husband: "夫", wife: "妻" };

export function AddReceiptButtons({ onFiles }: Props) {
  const albumHusband = useRef<HTMLInputElement>(null);
  const albumWife = useRef<HTMLInputElement>(null);
  const cameraHusband = useRef<HTMLInputElement>(null);
  const cameraWife = useRef<HTMLInputElement>(null);

  const handle = (payer: Payer) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) onFiles(payer, files);
    e.target.value = ""; // 同じファイルの再選択を可能に
  };

  return (
    <section className="add-buttons">
      {(["husband", "wife"] as const).map((payer) => (
        <div className="payer-group" key={payer}>
          <h2>{PAYER_LABEL[payer]}のレシート</h2>
          {/* 夫妻それぞれの「アルバムから選ぶ」「カメラで撮る」は視覚的なテキストが同一のため、
              スクリーンリーダーのボタン一覧で対象を判別できない(Codexレビュー指摘I9)。
              aria-labelで行き先を明示する(表示テキスト自体は変更しない)。 */}
          <button
            type="button"
            aria-label={`${PAYER_LABEL[payer]}のレシートをアルバムから選ぶ`}
            onClick={() => (payer === "husband" ? albumHusband : albumWife).current?.click()}
          >
            アルバムから選ぶ
          </button>
          <button
            type="button"
            aria-label={`${PAYER_LABEL[payer]}のレシートをカメラで撮る`}
            onClick={() => (payer === "husband" ? cameraHusband : cameraWife).current?.click()}
          >
            カメラで撮る
          </button>
        </div>
      ))}
      <input ref={albumHusband} type="file" accept="image/*" multiple hidden onChange={handle("husband")} />
      <input ref={cameraHusband} type="file" accept="image/*" capture="environment" hidden onChange={handle("husband")} />
      <input ref={albumWife} type="file" accept="image/*" multiple hidden onChange={handle("wife")} />
      <input ref={cameraWife} type="file" accept="image/*" capture="environment" hidden onChange={handle("wife")} />
    </section>
  );
}
