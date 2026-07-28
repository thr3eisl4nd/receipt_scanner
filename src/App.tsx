import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AddReceiptButtons } from "./components/AddReceiptButtons";
import { ReceiptRow } from "./components/ReceiptRow";
import { createOcrQueue } from "./ocr/queue";
import { createPpuPaddleEngine } from "./ocr/ppuPaddleEngine";
import { reducer, toPersisted, fromPersisted, type AppState } from "./state/reducer";
import { saveState, loadState, currentMonth } from "./state/storage";
import type { Payer, Row } from "./types";

const initialState = (): AppState => {
  const persisted = loadState();
  return persisted ? fromPersisted(persisted) : { month: currentMonth(), rows: [], saveFailed: false };
};

const RECEIPT_LABEL_RE = /^レシート (\d+)$/;

/**
 * 次の自動採番ラベルの番号を、現在の行(=永続化済み+今のセッションで追加した分)の
 * ラベルから導出する。モジュールスコープの可変カウンタ(let nextReceiptNumber = 1)だと
 * ページ再読み込みのたびに1へリセットされ、保存済みの「レシート 3」等と新規行が
 * 番号衝突する(Codexレビュー指摘)。state.rowsから毎回導出すれば再読み込み後も
 * 継続した採番になる。
 */
function nextReceiptLabel(rows: Row[]): (offset: number) => string {
  const max = rows.reduce((acc, r) => {
    const m = RECEIPT_LABEL_RE.exec(r.label);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return (offset: number) => `レシート ${max + offset}`;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [ocrStatus, setOcrStatus] = useState("");
  const seenFiles = useRef(new Set<string>());
  // アンマウント時のクリーンアップ(サムネイルURL解放)用に最新のrowsを参照できるようにする。
  const rowsRef = useRef(state.rows);
  rowsRef.current = state.rows;

  const { queue, engine } = useMemo(() => {
    const engine = createPpuPaddleEngine();
    const queue = createOcrQueue(engine, {
      onStatus: setOcrStatus,
      onResult: (id, patch) => dispatch({ type: "updateRow", id, patch }),
    });
    return { queue, engine };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自動保存(画像以外)。失敗はUI表示
  useEffect(() => {
    dispatch({ type: "setSaveFailed", value: !saveState(toPersisted(state)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.month, state.rows]);

  // アンマウント時のリソース解放: 未処理OCRのキャンセル・engine破棄・
  // 表示中サムネイルのObject URL全解放(Codexレビュー指摘。行削除時以外は
  // 解放されていなかった)。このSPAは現状ルーティング等で実際にアンマウント
  // しないが、テスト環境やFast Refresh下でのリーク防止として備える。
  useEffect(() => {
    return () => {
      queue.cancelAll();
      void engine.destroy();
      for (const row of rowsRef.current) {
        if (row.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
      }
    };
  }, [queue, engine]);

  const onFiles = (payer: Payer, files: File[]) => {
    const rows: Row[] = [];
    const labelFor = nextReceiptLabel(state.rows);
    let offset = 1;
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seenFiles.current.has(key) && !window.confirm(`「${file.name}」は追加済みのようです。もう一度追加しますか?`)) {
        continue;
      }
      seenFiles.current.add(key);
      const id = crypto.randomUUID();
      rows.push({
        id,
        payer,
        amountYen: null,
        label: labelFor(offset++),
        status: "failed",
        source: "ocr",
        candidates: [],
        thumbnailUrl: URL.createObjectURL(file),
        processing: true,
      });
      queue.enqueue(id, file);
    }
    if (rows.length > 0) dispatch({ type: "addRows", rows });
  };

  const onRemove = (id: string) => {
    const row = state.rows.find((r) => r.id === id);
    if (row?.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
    dispatch({ type: "removeRow", id });
  };

  return (
    <main>
      <h1>レシート清算スキャナー <span className="month">{state.month}</span></h1>
      <AddReceiptButtons onFiles={onFiles} />
      <p aria-live="polite" className="ocr-status">{ocrStatus}</p>
      {state.saveFailed && <p role="alert" className="error">自動保存できません(端末の空き容量を確認してください)</p>}
      <ul className="receipt-list">
        {state.rows.map((row) => (
          <ReceiptRow key={row.id} row={row} onPatch={(id, patch) => dispatch({ type: "updateRow", id, patch })} onRemove={onRemove} />
        ))}
      </ul>
      {/* SummaryPanel・ManualEntryForm・新しい月 はTask 10 */}
    </main>
  );
}
