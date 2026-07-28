import { useRef } from "react";
import type { Payer } from "../types";

type Props = { onFiles(payer: Payer, files: File[]): void };

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
      <div className="payer-group">
        <h2>夫のレシート</h2>
        <button type="button" onClick={() => albumHusband.current?.click()}>アルバムから選ぶ</button>
        <button type="button" onClick={() => cameraHusband.current?.click()}>カメラで撮る</button>
      </div>
      <div className="payer-group">
        <h2>妻のレシート</h2>
        <button type="button" onClick={() => albumWife.current?.click()}>アルバムから選ぶ</button>
        <button type="button" onClick={() => cameraWife.current?.click()}>カメラで撮る</button>
      </div>
      <input ref={albumHusband} type="file" accept="image/*" multiple hidden onChange={handle("husband")} />
      <input ref={cameraHusband} type="file" accept="image/*" capture="environment" hidden onChange={handle("husband")} />
      <input ref={albumWife} type="file" accept="image/*" multiple hidden onChange={handle("wife")} />
      <input ref={cameraWife} type="file" accept="image/*" capture="environment" hidden onChange={handle("wife")} />
    </section>
  );
}
