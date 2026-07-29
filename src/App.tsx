import { useEffect, useReducer, useRef, useState } from "react";
import { AddReceiptButtons } from "./components/AddReceiptButtons";
import { PeopleManager } from "./components/PeopleManager";
import { ReceiptRow } from "./components/ReceiptRow";
import { ManualEntryForm } from "./components/ManualEntryForm";
import { SummaryPanel } from "./components/SummaryPanel";
import { createOcrQueue, type OcrQueue, type QueueStatusEvent } from "./ocr/queue";
import { createPpuPaddleEngine } from "./ocr/ppuPaddleEngine";
import { reducer, toPersisted, fromPersisted, computeTotals, type AppState, type RowPatch } from "./state/reducer";
import { saveState, loadState, currentMonth, clearState } from "./state/storage";
import type { Row } from "./types";

const yen = (n: number) => n.toLocaleString("ja-JP");

// 初回起動(永続化データが無い)時のデフォルト状態は人1人・初期名「わたし」(設計ドキュメント§14.1)。
const initialState = (): AppState => {
  const persisted = loadState();
  return persisted
    ? fromPersisted(persisted)
    : {
        month: currentMonth(),
        people: [{ id: crypto.randomUUID(), name: "わたし", colorIndex: 0 }],
        rows: [],
        saveFailed: false,
      };
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
  const [ocrEvent, setOcrEvent] = useState<QueueStatusEvent | null>(null);
  const seenFiles = useRef(new Set<string>());
  // アンマウント時のクリーンアップ(サムネイルURL解放)用に最新のrowsを参照できるようにする。
  const rowsRef = useRef(state.rows);
  rowsRef.current = state.rows;
  // OCRキューはuseEffect内(useMemoではなく)で生成する(Codexレビュー指摘I2)。
  // StrictModeの開発時二重effect実行(mount→cleanup→mount)でも、cleanupのたびに
  // 新しいengine/queueが作られ直すため、「dispose済みの古いqueueを実運用でも
  // 使い続けてしまう」事故が起きない。onFiles等からは常にqueueRef経由で参照する。
  const queueRef = useRef<OcrQueue | null>(null);
  // 失敗行の再試行(I8)用に、追加時のFileをid別に保持する。行削除時にクリアする。
  const retryFilesRef = useRef(new Map<string, File>());
  // 行(row)とOCR「試行(job)」を分離して追跡する(Codexレビュー再指摘C1)。
  // queue.enqueue()に渡すidを行idそのものにしていると、「OCR-A実行中→ユーザーが
  // 空欄確定(processing:false)→再試行でprocessing:trueに戻しOCR-Bをenqueue→
  // 古いOCR-Aの結果が遅れて到着」という順序で、`row.processing===true`だけを見る
  // ガードが世代を区別できず、Bではなく古いAの結果が適用されてしまう。
  // enqueueのたびに新しいjobIdを発行し、「行に対して今アクティブなjobId」と
  // 一致する結果だけを適用する。
  const activeJobRef = useRef(new Map<string, string>()); // rowId -> 現在アクティブなjobId
  const jobRowRef = useRef(new Map<string, string>()); // jobId -> rowId

  /**
   * 行(rowId)に紐づく現在アクティブなjobをすべてのMapから外す(Codexレビュー再指摘・
   * Minor: `activeJobRef`を上書きするだけだと`jobRowRef`側に逆引きエントリが残り、
   * 再試行を繰り返すたびに解放されないエントリが積み上がる)。
   */
  function invalidateJobForRow(rowId: string): void {
    const jobId = activeJobRef.current.get(rowId);
    activeJobRef.current.delete(rowId);
    if (jobId) jobRowRef.current.delete(jobId);
  }

  /**
   * 行の状態が「もうfailedではない」(=成功して確定した、または手修正で確定した)へ
   * 遷移した際、再試行用に保持していた元Fileを解放する(Codexレビュー再指摘Important:
   * `retryFilesRef`が成功済み行のFileまでセッション終了まで保持し続けており、
   * サムネイルを320pxへ縮小した効果を大量取り込み時に無効化していた)。
   */
  function releaseRetryFileIfResolved(rowId: string, patch: RowPatch): void {
    if (patch.status !== undefined && patch.status !== "failed") {
      retryFilesRef.current.delete(rowId);
    }
  }

  useEffect(() => {
    const engine = createPpuPaddleEngine();

    function resolveActiveRow(jobId: string): { rowId: string; row: Row } | null {
      const rowId = jobRowRef.current.get(jobId);
      if (!rowId) return null;
      if (activeJobRef.current.get(rowId) !== jobId) return null; // 再試行等で無効化された古いjob
      const row = rowsRef.current.find((r) => r.id === rowId);
      if (!row) return null; // 削除済み行
      return { rowId, row };
    }

    const queue = createOcrQueue(engine, {
      onStatus: (event) => setOcrEvent(event),
      onThumbnail: (jobId, blob) => {
        const resolved = resolveActiveRow(jobId);
        // 削除済み行、または既に無効化された古いjobへの遅着Blobは表示先が無いので、
        // Object URLすら作らず即終了する(Codexレビュー指摘I1)。
        if (!resolved) return;
        const { rowId, row } = resolved;
        const url = URL.createObjectURL(blob);
        if (row.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl); // 置換時は旧URLを解放
        dispatch({ type: "updateRow", id: rowId, patch: { thumbnailUrl: url } });
      },
      // 拡大表示用プレビュー(Codexレビュー最終ゲート指摘I2)。onThumbnailと全く同じ
      // 差し戻し・解放パターンを`previewUrl`側にも適用する。
      onPreview: (jobId, blob) => {
        const resolved = resolveActiveRow(jobId);
        if (!resolved) return;
        const { rowId, row } = resolved;
        const url = URL.createObjectURL(blob);
        if (row.previewUrl) URL.revokeObjectURL(row.previewUrl); // 置換時は旧URLを解放
        dispatch({ type: "updateRow", id: rowId, patch: { previewUrl: url } });
      },
      // OCR結果はapplyOcrResultで反映する。updateRowと違い、ユーザーが既に手修正して
      // processing:falseになった行には適用されない(Codexレビュー指摘C1: 遅延OCR結果に
      // よる手修正の無警告上書き防止)。加えて、jobIdが「この行の現在アクティブなjob」と
      // 一致しない場合(=再試行で置き換えられた古い結果)も無視する。
      onResult: (jobId, patch) => {
        const rowId = jobRowRef.current.get(jobId);
        jobRowRef.current.delete(jobId);
        if (!rowId || activeJobRef.current.get(rowId) !== jobId) return;
        activeJobRef.current.delete(rowId);
        // 結果が実際に適用され、かつ成功(failed以外)した場合のみ再試行用Fileを解放する。
        // stale判定でreturn済みの場合はここへ来ないため、再試行中のFileを誤って
        // 消すことはない。
        releaseRetryFileIfResolved(rowId, patch);
        dispatch({ type: "applyOcrResult", id: rowId, patch });
      },
    });
    queueRef.current = queue;
    return () => {
      queueRef.current = null;
      // アンマウント時、表示中サムネイル・プレビューのObject URLを全解放する
      // (Codexレビュー指摘I1・最終ゲート指摘I2)。
      for (const row of rowsRef.current) {
        if (row.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
        if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
      }
      // 新規enqueue拒否→pending破棄→コールバック停止→実行中ジョブの完了待ち、を経てから
      // engineを破棄する(Codexレビュー指摘I2: cancelAll()は未処理分しか止めないため、
      // 実行中のONNXセッションと競合したまま破棄していた)。dispose/destroyそれぞれの
      // rejectを個別にcatchする(`void queue.dispose().finally(() => void engine.destroy())`
      // は`engine.destroy()`のrejectがどこにも捕まらず未処理rejectionになる、という
      // Codexレビュー再指摘M2の回帰防止)。
      void (async () => {
        try {
          await queue.dispose();
        } catch (err) {
          console.error("OCR queue disposal failed:", err);
        }
        try {
          await engine.destroy();
        } catch (err) {
          console.error("OCR engine destruction failed:", err);
        }
      })();
    };
  }, []);

  // 自動保存(画像以外)。失敗はUI表示。people変更(追加/改名/削除)も保存対象なので
  // 依存配列に含める(v1.1で人が永続化データの一部になったため)。
  useEffect(() => {
    dispatch({ type: "setSaveFailed", value: !saveState(toPersisted(state)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.month, state.rows, state.people]);

  // 行(rowId)に対して新しい試行(jobId)を発行してenqueueする。以前その行に紐づいて
  // いたjobId(あれば)はここで置き換えられ、以後は「アクティブでない」ため、後から
  // 遅れて届く結果は無視される(Codexレビュー再指摘C1)。
  const enqueueForRow = (rowId: string, file: File) => {
    invalidateJobForRow(rowId); // 前のjob(あれば)の逆引きエントリも解放してから差し替える
    const jobId = crypto.randomUUID();
    activeJobRef.current.set(rowId, jobId);
    jobRowRef.current.set(jobId, rowId);
    queueRef.current?.enqueue(jobId, file);
  };

  const onFiles = (payerId: string, files: File[]) => {
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
        payerId,
        amountYen: null,
        label: labelFor(offset++),
        status: "failed",
        source: "ocr",
        candidates: [],
        // フル画像のObject URLはここでは作らない(Codexレビュー指摘I1)。
        // サムネイルはOCRキューが処理済み縮小canvasから生成し、onThumbnailで届く。
        processing: true,
      });
      retryFilesRef.current.set(id, file);
      enqueueForRow(id, file);
    }
    if (rows.length > 0) dispatch({ type: "addRows", rows });
  };

  const onRemove = (id: string) => {
    const row = state.rows.find((r) => r.id === id);
    if (row?.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
    if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
    retryFilesRef.current.delete(id);
    invalidateJobForRow(id);
    dispatch({ type: "removeRow", id });
  };

  // 失敗行の再試行(Codexレビュー指摘I8)。Appが保持しているFileで再enqueueする。
  const onRetry = (id: string) => {
    const file = retryFilesRef.current.get(id);
    if (!file) return;
    dispatch({ type: "updateRow", id, patch: { processing: true, status: "failed" } });
    enqueueForRow(id, file);
  };

  // モデル初期化失敗時の一括リトライ。現在failedかつFileを保持している行をまとめて再試行する。
  const onRetryModelError = () => {
    for (const row of state.rows) {
      if (row.status === "failed" && !row.processing && retryFilesRef.current.has(row.id)) {
        onRetry(row.id);
      }
    }
  };

  // 一括キャンセル(Codexレビュー再指摘I2)。`queue.cancelAll()`はキュー内の未処理
  // (pending)分しか止められず、実行中(itemInFlight)の1件はONNX推論を実際には
  // 中断できない。そのため実行中かどうかに関わらず、現在processing中の行はここで
  // 即座に論理キャンセル(failed/processing:false)し、activeJobを無効化して以後
  // 届く結果を無視できるようにする。`queue.cancelAll()`はpending分の実処理(無駄な
  // recognize呼び出し)を止めるために引き続き呼ぶ。
  const onCancelAll = () => {
    for (const row of state.rows) {
      if (row.processing) {
        invalidateJobForRow(row.id);
        dispatch({
          type: "updateRow",
          id: row.id,
          patch: { processing: false, status: "failed", amountYen: null, candidates: [] },
        });
      }
    }
    queueRef.current?.cancelAll();
  };

  // 「新しい月を始める」(設計ドキュメント§4・§5.5)。確認ダイアログで現在の集計を
  // 提示してから、表示中サムネイルのObject URLを全解放し、再試行用File(retryFilesRef)・
  // 重複検出用Set(seenFiles)をクリアし、localStorageを消去してからclearMonthをdispatch
  // する(Task 9レポートで予告済みの統合ポイント)。onRemove/アンマウント時クリーンアップと
  // 同様のURL解放パターンを流用する。
  //
  // 実行順序はCodexレビュー指摘を反映して当初案から調整した:
  // 1) `clearState()`を最初に行い、失敗(例外)時はそこで中断する。先にサムネイルURLや
  //    retryFilesRef/seenFilesを消してしまうと、永続化の削除に失敗した場合に「画面上には
  //    旧月のデータが残っているのに再試行・重複検出の手段だけ失われる」中途半端な状態に
  //    なる(Codexレビュー指摘)。
  // 2) `queueRef.current?.cancelAll()`でpending中のOCRジョブを破棄する。これを呼ばないと
  //    月次リセット後も旧月の画像がバックグラウンドでOCR処理され続け、新しい月に追加した
  //    画像の処理がその後ろに並んでしまう(Codexレビュー指摘。行自体は既に無くなるため
  //    結果が反映されて実害が出ることはないが、無駄な処理・待ち時間を発生させる)。
  const onNewMonth = () => {
    const t = computeTotals(state.people, state.rows);
    const totalsText = t.totals.map((p) => `${p.name} ${yen(p.amountYen)}円`).join(" / ");
    const ok = window.confirm(`${state.month} のデータ(${totalsText})を消去して新しい月を始めますか?`);
    if (!ok) return;
    if (!clearState()) {
      window.alert("保存データを削除できませんでした。時間をおいて再試行してください。");
      return;
    }
    queueRef.current?.cancelAll();
    for (const r of state.rows) {
      if (r.thumbnailUrl) URL.revokeObjectURL(r.thumbnailUrl);
      if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
    }
    retryFilesRef.current.clear();
    seenFiles.current.clear();
    dispatch({ type: "clearMonth", month: currentMonth() });
  };

  const hasPendingWork = state.rows.some((r) => r.processing);
  // OCR完了後にneeds-review/failed行が残っている場合、ステータス領域(aria-live)に
  // 「金額確認待ち N件」を表示する(Codexレビュー最終ゲート指摘Minor#3・設計ドキュメント
  // §5.2)。固定パネル側の「⚠ 未確認 N件」(SummaryPanel)は常時表示の非ライブ領域だが、
  // こちらはOCR完了の一連の流れ(準備中→処理中→…)の続きとしてライブ領域で通知する。
  const reviewPendingCount = computeTotals(state.people, state.rows).unconfirmed;
  const ocrStatusText = !hasPendingWork && reviewPendingCount > 0
    ? `金額確認待ち ${reviewPendingCount}件`
    : ocrEvent?.kind === "preparing"
      ? "モデル準備中…"
      : ocrEvent?.kind === "processing"
        ? `画像 ${ocrEvent.current}/${ocrEvent.total} 処理中…`
        : ocrEvent?.kind === "complete" && ocrEvent.total > 0
          ? `完了 (${ocrEvent.done}/${ocrEvent.total})`
          : "";

  return (
    <main>
      <h1>レシート清算スキャナー <span className="month">{state.month}</span></h1>
      <PeopleManager
        people={state.people}
        rows={state.rows}
        onAdd={() => dispatch({ type: "addPerson" })}
        onRename={(id, name) => dispatch({ type: "renamePerson", id, name })}
        onRemove={(id) => dispatch({ type: "removePerson", id })}
      />
      <AddReceiptButtons people={state.people} onFiles={onFiles} />

      {ocrEvent?.kind === "model-error" ? (
        <div role="alert" className="error ocr-model-error">
          <p>{ocrEvent.message}</p>
          <button type="button" onClick={onRetryModelError}>再試行</button>
        </div>
      ) : (
        <p role="status" aria-live="polite" aria-atomic="true" className="ocr-status">
          {ocrStatusText}
        </p>
      )}
      {hasPendingWork && (
        <button type="button" className="cancel-all" onClick={onCancelAll}>すべてキャンセル</button>
      )}

      {state.saveFailed && <p role="alert" className="error">自動保存できません(端末の空き容量を確認してください)</p>}
      <ul className="receipt-list">
        {state.rows.map((row, index) => (
          <ReceiptRow
            key={row.id}
            row={row}
            people={state.people}
            rowNumber={index + 1}
            canRetry={retryFilesRef.current.has(row.id)}
            onPatch={(id, patch) => {
              releaseRetryFileIfResolved(id, patch);
              dispatch({ type: "updateRow", id, patch });
            }}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </ul>
      <ManualEntryForm people={state.people} onAdd={(row) => dispatch({ type: "addRows", rows: [row] })} />
      <SummaryPanel state={state} onNewMonth={onNewMonth} />
    </main>
  );
}
