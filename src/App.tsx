import { useEffect, useReducer, useRef, useState } from "react";
import { AddReceiptButtons } from "./components/AddReceiptButtons";
import { PeopleManager } from "./components/PeopleManager";
import { ReceiptRow } from "./components/ReceiptRow";
import { ManualEntryForm } from "./components/ManualEntryForm";
import { SummaryPanel } from "./components/SummaryPanel";
import {
  createOcrQueue,
  type OcrQueue,
  type QueueStatusEvent,
  type NormalizedRect,
  type RegionGroupFlags,
} from "./ocr/queue";
import { createPpuPaddleEngine } from "./ocr/ppuPaddleEngine";
import { reducer, toPersisted, fromPersisted, computeTotals, nextReceiptLabel, type AppState, type RowPatch } from "./state/reducer";
import { saveState, loadState, currentMonth } from "./state/storage";
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

/**
 * 失敗行の再試行(Codexレビュー指摘I8)・v1.3(§16.4)の領域再試行の両方を表す再試行元。
 * - `crop`未指定: 写真全体を新規写真として検出からやり直す(従来の再試行、および
 *   §16.5「写真全体を1枚として読み直す」)。
 * - `crop`指定: 特定の1領域だけを元解像度から再クロップする(分割された1行の再試行)。
 * - `forceSingle`指定: 検出をスキップし、写真全体を1領域として強制的に読み直す
 *   (§16.5の回復導線専用。誤って2分割された場合の回復)。
 */
type RetrySource = { file: File; crop?: NormalizedRect; forceSingle?: boolean };

/**
 * 写真単位のグループ管理(v1.3 §16.5)。photoIdをRowに持たせず、refのMap(非永続)で
 * 管理する(PersistedStateスキーマは変更しない)。1枚の写真が複数領域(レシート)に
 * 分割された場合のみエントリを持つ(領域が1つの場合はグループを作らない=既存の
 * 1枚運用と変わらない)。
 */
type PhotoGroup = {
  file: File;
  rowIds: string[];
  ambiguous: boolean;
  nearLimit: boolean;
};

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
  // 失敗行の再試行(I8)・v1.3領域再試行(§16.4)用に、追加時のRetrySourceをid別に保持する。
  // 行削除時にクリアする。
  const retryFilesRef = useRef(new Map<string, RetrySource>());
  // v1.3(§16.5): 写真単位のグループ管理(非永続、photoJobId→グループ)。1枚の写真が
  // 複数領域に分割された場合のみエントリを持つ。
  const photoGroupRef = useRef(new Map<string, PhotoGroup>());
  // 印字アニメーションのstagger遅延(ms)をid別に保持する(Codexレビュー v1.2再指摘I5)。
  // 「追加バッチ内のindex」から算出し、ReceiptRowへそのままpropとして渡す。一覧全体の
  // 通し番号から逆算する旧実装は、既存行が10件以上ある状態で1件だけ追加しても
  // 540ms待たされ、複数件同時追加時は全新規行が上限の540msに丸められてstaggerが
  // 消えるバグがあった。行削除・月次リセット時にエントリを解放する。
  const printDelayByIdRef = useRef(new Map<string, number>());
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
      // v1.3(§16.4): パス1(検出)完了時、1枚の写真が複数領域(レシート)に分割された
      // ことの通知。プレースホルダ行(=写真1枚分の当初の行)をN行へ原子的に置換し
      // (`replacePendingRow`)、各新行を領域ごとのjobIdへ紐づけ直す。領域が1つの場合は
      // このコールバック自体が発火しない(既存の1枚運用と完全互換)。
      onRegions: (photoJobId, regions, flags: RegionGroupFlags) => {
        const rowId = jobRowRef.current.get(photoJobId);
        if (!rowId || activeJobRef.current.get(rowId) !== photoJobId) return; // 削除済み・無効化済みのjob
        const originalRow = rowsRef.current.find((r) => r.id === rowId);
        const originalSource = retryFilesRef.current.get(rowId);
        if (!originalRow || !originalSource) return;

        invalidateJobForRow(rowId);
        retryFilesRef.current.delete(rowId);

        const newRowIds = regions.map(() => crypto.randomUUID());
        dispatch({
          type: "replacePendingRow",
          placeholderId: rowId,
          newRows: newRowIds.map((id) => ({ id, payerId: originalRow.payerId })),
        });

        regions.forEach((region, i) => {
          const newRowId = newRowIds[i];
          activeJobRef.current.set(newRowId, region.jobId);
          jobRowRef.current.set(region.jobId, newRowId);
          retryFilesRef.current.set(newRowId, { file: originalSource.file, crop: region.crop });
        });

        photoGroupRef.current.set(photoJobId, {
          file: originalSource.file,
          rowIds: newRowIds,
          ambiguous: flags.ambiguous,
          nearLimit: flags.nearLimit,
        });
      },
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
  // v1.3(§16.4): `source.crop`/`source.forceSingle`はそのままqueueへ渡す(通常の新規写真は
  // どちらも未指定)。
  const enqueueForRow = (rowId: string, source: RetrySource) => {
    invalidateJobForRow(rowId); // 前のjob(あれば)の逆引きエントリも解放してから差し替える
    const jobId = crypto.randomUUID();
    activeJobRef.current.set(rowId, jobId);
    jobRowRef.current.set(jobId, rowId);
    queueRef.current?.enqueue(jobId, source.file, { crop: source.crop, forceSingle: source.forceSingle });
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
      // 印字アニメーションのstagger(設計ドキュメント§15.5)は「このバッチ内で今まで
      // 追加した行数」を基準にする(Codexレビュー v1.2再指摘I5)。極端に長いバッチで
      // 遅延が積み上がらないよう最大10件分(600ms)でキャップする。
      printDelayByIdRef.current.set(id, Math.min(rows.length, 9) * 60);
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
      retryFilesRef.current.set(id, { file });
      enqueueForRow(id, { file });
    }
    if (rows.length > 0) dispatch({ type: "addRows", rows });
  };

  const onRemove = (id: string) => {
    const row = state.rows.find((r) => r.id === id);
    if (row?.thumbnailUrl) URL.revokeObjectURL(row.thumbnailUrl);
    if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
    retryFilesRef.current.delete(id);
    printDelayByIdRef.current.delete(id);
    invalidateJobForRow(id);
    // v1.3(§16.5): この行が属していた写真グループから除外する。グループが空になったら
    // グループごと消す(非永続管理、photoIdはRowに持たせない)。
    for (const [photoJobId, group] of photoGroupRef.current) {
      if (!group.rowIds.includes(id)) continue;
      const rowIds = group.rowIds.filter((rid) => rid !== id);
      if (rowIds.length === 0) photoGroupRef.current.delete(photoJobId);
      else photoGroupRef.current.set(photoJobId, { ...group, rowIds });
      break;
    }
    dispatch({ type: "removeRow", id });
  };

  // 失敗行の再試行(Codexレビュー指摘I8)。Appが保持しているRetrySourceで再enqueueする
  // (v1.3 §16.4: `crop`があれば同じ領域だけを元解像度から再クロップする)。
  const onRetry = (id: string) => {
    const source = retryFilesRef.current.get(id);
    if (!source) return;
    dispatch({ type: "updateRow", id, patch: { processing: true, status: "failed" } });
    enqueueForRow(id, source);
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
  // 重複検出用Set(seenFiles)をクリアし、新しい(空の)月の状態へ切り替える(Task 9レポートで
  // 予告済みの統合ポイント)。onRemove/アンマウント時クリーンアップと同様のURL解放パターンを
  // 流用する。
  //
  // 旧実装は`clearState()`(localStorage.removeItem)を先に呼び、成功後に
  // dispatch({type:"clearMonth"})→自動保存effectのsaveState()という2段階で永続化していた。
  // この間(削除成功〜次の保存完了)に容量超過・SecurityError等でsaveStateが失敗する、
  // effect実行前にタブ終了・クラッシュする、dispatch後だが保存完了前にリロードする、
  // といった事態が起きると、旧月のデータだけでなく月をまたいで維持するはずの`people`まで
  // 失われる(Codexレビュー指摘I1)。
  // 「削除してから保存」ではなく、新しい空状態を`reducer`であらかじめ計算し、同じ
  // localStorageキーへ`saveState()`一発で原子的に上書きする。保存に失敗した場合は
  // 何も変更せず(旧状態のlocalStorageがそのまま残る)アラートするだけで中断する。
  const onNewMonth = () => {
    const t = computeTotals(state.people, state.rows);
    const totalsText = t.totals.map((p) => `${p.name} ${yen(p.amountYen)}円`).join(" / ");
    const ok = window.confirm(`${state.month} のデータ(${totalsText})を消去して新しい月を始めますか?`);
    if (!ok) return;

    const nextState = reducer(state, { type: "clearMonth", month: currentMonth() });
    if (!saveState(toPersisted(nextState))) {
      window.alert("新しい月の状態を保存できませんでした。時間をおいて再試行してください。");
      return; // 保存失敗時は何もクリーンアップしない。旧状態のlocalStorage・画面表示ともに残る。
    }

    // ここから先は永続化済みなので、pending中のOCRジョブ破棄・Object URL解放・
    // 再試行/重複検出用ステートのクリアを行ってからdispatchする。
    // `queue.cancelAll()`を呼ばないと、月次リセット後も旧月の画像がバックグラウンドで
    // OCR処理され続け、新しい月に追加した画像の処理がその後ろに並んでしまう
    // (Codexレビュー指摘。行自体は既に無くなるため結果が反映されて実害が出ることはないが、
    // 無駄な処理・待ち時間を発生させる)。
    queueRef.current?.cancelAll();
    for (const r of state.rows) {
      if (r.thumbnailUrl) URL.revokeObjectURL(r.thumbnailUrl);
      if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
    }
    retryFilesRef.current.clear();
    printDelayByIdRef.current.clear();
    photoGroupRef.current.clear();
    seenFiles.current.clear();
    dispatch({ type: "hydrate", state: nextState });
  };

  // v1.3(§16.5): グループ内に失敗行がある・領域判定が曖昧(ambiguous)・領域数が
  // 上限付近(nearLimit)の場合のみ、そのグループの最後の行の直後に回復導線
  // (2ボタン)を表示する。手動の矩形編集・分割/結合UIは作らない(仕様通り)。
  function findRecoveryGroupForRow(rowId: string): { photoJobId: string; group: PhotoGroup } | null {
    for (const [photoJobId, group] of photoGroupRef.current) {
      if (group.rowIds.length === 0 || group.rowIds[group.rowIds.length - 1] !== rowId) continue;
      const hasFailed = group.rowIds.some((id) => state.rows.find((r) => r.id === id)?.status === "failed");
      if (group.ambiguous || group.nearLimit || hasFailed) return { photoJobId, group };
      return null;
    }
    return null;
  }

  /** §16.5「写真全体を1枚として読み直す」: 1枚を誤って2分割した場合の回復。
   *  グループの行を全て削除し、同じFileを検出スキップ(forceSingle)で読み直す新しい行を追加する。 */
  const onRereadWholePhoto = (photoJobId: string) => {
    const group = photoGroupRef.current.get(photoJobId);
    if (!group) return;
    const payerId = state.rows.find((r) => group.rowIds.includes(r.id))?.payerId ?? state.people[0]?.id;
    for (const rowId of group.rowIds) onRemove(rowId);
    photoGroupRef.current.delete(photoJobId);
    if (!payerId) return;

    const remainingRows = state.rows.filter((r) => !group.rowIds.includes(r.id));
    const id = crypto.randomUUID();
    const label = nextReceiptLabel(remainingRows)(1);
    dispatch({
      type: "addRows",
      rows: [{ id, payerId, amountYen: null, label, status: "failed", source: "ocr", candidates: [], processing: true }],
    });
    retryFilesRef.current.set(id, { file: group.file });
    enqueueForRow(id, { file: group.file, forceSingle: true });
  };

  /** §16.5「削除して撮り直す」: 2枚を1領域に誤結合した場合の回復。グループの行を全て削除するのみ。 */
  const onDeleteGroup = (photoJobId: string) => {
    const group = photoGroupRef.current.get(photoJobId);
    if (!group) return;
    for (const rowId of group.rowIds) onRemove(rowId);
    photoGroupRef.current.delete(photoJobId);
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
        // v1.3(§16.4): パス1(検出)完了時、写真単位で「◯枚のレシートを見つけました」を
        // 通知する(aria-live、既存のocr-statusと同じ領域を使う)。
        : ocrEvent?.kind === "regionsFound"
          ? `この写真から${ocrEvent.count}枚のレシートを見つけました`
          : ocrEvent?.kind === "regionProcessing"
            ? `${ocrEvent.current}/${ocrEvent.total}枚目を読取中…`
            : ocrEvent?.kind === "complete" && ocrEvent.total > 0
              ? `完了 (${ocrEvent.done}/${ocrEvent.total})`
              : "";

  return (
    // 集計パネル(.summary-panel、画面下部固定)は<main>の中・`.receipt-paper`の外に置く
    // (Codexレビュー v1.2再指摘I4)。以前のリビジョンでは集計パネルを<main>の外(body直下側)
    // まで出していたが、これだと主要機能である集計・月切替がスクリーンリーダーの
    // 「mainへ移動」ランドマークから外れ、主要コンテンツのランドマークが分断されてしまう。
    // 固定位置決めを安全にするために必要なのは、ジグザグのミシン目エッジ(clip-path)を持つ
    // `.receipt-paper`の外へ出すことだけであり、<main>自体には固定包含ブロックを変える
    // スタイル(transform/filter/perspective/contain/backdrop-filter等)は無いため、
    // <main>の子であること自体は`position:fixed`の基準に影響しない。
    <main>
      {/* 「紙」本体(設計ドキュメント§15.2)。 */}
      <div className="receipt-paper">
        {/* レシートの店名ヘッダー様式(設計ドキュメント§15.3): モノスペース・中央寄せ・
            字間広め、上下に「＊ ＊ ＊」の装飾行(装飾のみ・aria-hidden)。 */}
        <header className="receipt-header">
          <p className="receipt-deco" aria-hidden="true">＊ ＊ ＊</p>
          <h1>レシート清算スキャナー <span className="month">{state.month}</span></h1>
          <p className="receipt-deco" aria-hidden="true">＊ ＊ ＊</p>
        </header>
        <PeopleManager
          people={state.people}
          rows={state.rows}
          onAdd={() => dispatch({ type: "addPerson" })}
          onRename={(id, name) => dispatch({ type: "renamePerson", id, name })}
          onRemove={(id) => dispatch({ type: "removePerson", id })}
        />
        <AddReceiptButtons people={state.people} onFiles={onFiles} />
        {/* 撮り方ヒント(調査結論: `.superpowers/sdd/ocr-investigation.md`。占有率(レシートが
            画面に占める割合=実効解像度)が失敗の最も支配的な単独要因、傾きは副次要因。
            取り込みボタン群の直下に常時表示する装飾的な案内文で、機能には影響しない。 */}
        <p className="capture-hint">
          レシートを画面いっぱい・まっすぐ・ピントを合わせて撮ると読み取り精度が上がります。複数枚まとめて撮る場合は間隔を空けて並べてください。
        </p>

        {/* 切り取り線装飾(設計ドキュメント§15.4、装飾のみ・aria-hidden)。 */}
        <p className="tear-line" aria-hidden="true">✂ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─</p>

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
          {state.rows.flatMap((row, index) => {
            const elements = [
              <ReceiptRow
                key={row.id}
                row={row}
                people={state.people}
                rowNumber={index + 1}
                printDelayMs={printDelayByIdRef.current.get(row.id) ?? 0}
                canRetry={retryFilesRef.current.has(row.id)}
                onPatch={(id: string, patch: RowPatch) => {
                  releaseRetryFileIfResolved(id, patch);
                  dispatch({ type: "updateRow", id, patch });
                }}
                onRemove={onRemove}
                onRetry={onRetry}
              />,
            ];
            // v1.3(§16.5): グループ内に失敗行がある・領域判定が曖昧・領域数が上限付近の
            // 場合のみ、そのグループの最後の行の直後に回復導線(2ボタン)を表示する。
            const recovery = findRecoveryGroupForRow(row.id);
            if (recovery) {
              elements.push(
                <li key={`${row.id}-recovery`} className="region-group-recovery">
                  <p>この写真の読み取りに問題があるかもしれません</p>
                  <button type="button" onClick={() => onRereadWholePhoto(recovery.photoJobId)}>
                    写真全体を1枚として読み直す
                  </button>
                  <button type="button" onClick={() => onDeleteGroup(recovery.photoJobId)}>
                    削除して撮り直す
                  </button>
                </li>,
              );
            }
            return elements;
          })}
        </ul>
        <p className="tear-line" aria-hidden="true">✂ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─</p>
        <ManualEntryForm people={state.people} onAdd={(row) => dispatch({ type: "addRows", rows: [row] })} />
      </div>
      <SummaryPanel state={state} onNewMonth={onNewMonth} />
    </main>
  );
}
