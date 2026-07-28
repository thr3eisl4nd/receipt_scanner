import type { OcrEngine } from "./engine";
import type { RowPatch } from "../state/reducer";
import type { FailureKind } from "../types";
import {
  loadAsCanvas,
  enhanceContrast,
  toThumbnailBlob,
  toPreviewBlob,
  UnsupportedFormatError,
  ImageTooLargeError,
} from "../image/preprocess";
import { extractTotal } from "../extract/extractTotal";

/**
 * `loadAsCanvas`が投げた例外を`Row.failureKind`へ分類する(Codexレビュー最終ゲート
 * 指摘I1)。`UnsupportedFormatError`/`ImageTooLargeError`はinstanceofで判別できるが、
 * それ以外(実装の`ImageDecodeError`、テストスタブが投げる汎用`Error`等)は
 * すべて「デコード失敗」として扱う。
 */
function classifyLoadError(err: unknown): FailureKind {
  if (err instanceof UnsupportedFormatError) return "unsupported-format";
  if (err instanceof ImageTooLargeError) return "image-too-large";
  return "image-decode";
}

/**
 * キューの進捗・エラーを構造化した形で通知する(Codexレビュー指摘I8)。
 * 従来は`onStatus(text: string)`で「モデル準備中」「画像 3/12 処理中」等の文言を
 * そのまま渡していたが、これだと通常進捗(`role="status"`)とモデル初期化失敗
 * (`role="alert"`+リトライボタン)をUI側で区別できない。
 */
export type QueueStatusEvent =
  | { kind: "preparing" }
  // `current`は「今処理を開始した画像の番号」(1始まり)。`done`(完了件数)と紛らわしい
  // ため名前を分ける(Codexレビュー再指摘M1): `processing`イベントは対象アイテムの
  // recognize()開始前にemitされるため、値そのものは「まだ完了していない現在番号」。
  | { kind: "processing"; current: number; total: number }
  | { kind: "model-error"; message: string }
  | { kind: "complete"; done: number; total: number };

export type QueueCallbacks = {
  onStatus(event: QueueStatusEvent): void;
  // 処理済み(縮小済み)canvasから生成した320px級サムネイルBlobを行へ返す(Codexレビュー指摘I1)。
  // 呼び出し側はObject URL化し、置換時・行削除時・削除済み行への遅着時に確実にrevokeすること。
  onThumbnail(id: string, blob: Blob): void;
  // 拡大表示用の1280px級プレビューBlobを行へ返す(Codexレビュー最終ゲート指摘I2)。
  // onThumbnailと同様、呼び出し側はObject URL化しライフサイクル全体でrevokeを管理する。
  onPreview(id: string, blob: Blob): void;
  onResult(id: string, patch: RowPatch): void; // 行更新(amountYen/status/candidates/processing)
};

type Item = { id: string; file: File };

/**
 * `loadAsCanvas`/`enhanceContrast`/`toThumbnailBlob`/`toPreviewBlob`の差し替えポイント。
 * 実運用では`src/image/preprocess.ts`の実装を使うが、jsdom環境の単体テストでは
 * 実Canvas描画(`drawImage`/`getImageData`/`toBlob`等)に依存できないため、薄いスタブに
 * 差し替えられるようにしている。
 */
export type OcrQueueDeps = {
  loadAsCanvas: (file: File) => Promise<HTMLCanvasElement>;
  enhanceContrast: (src: HTMLCanvasElement) => HTMLCanvasElement;
  toThumbnailBlob: (src: HTMLCanvasElement) => Promise<Blob>;
  toPreviewBlob: (src: HTMLCanvasElement) => Promise<Blob>;
};

const defaultDeps: OcrQueueDeps = { loadAsCanvas, enhanceContrast, toThumbnailBlob, toPreviewBlob };

/** 処理済みcanvasの明示解放。描画バッファをGC任せにせず即座に縮小する。 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * キャンセル/初期化失敗/例外時の一律失敗patch。
 * `candidates`は空配列だが、複数行が同一配列インスタンスを共有して将来の
 * 意図しないミューテーションで汚染し合わないよう、呼び出しごとに新規生成する。
 *
 * `failureKind`は原因が分類できる場合のみ渡す(Codexレビュー最終ゲート指摘I1)。
 * 省略時(キャンセルやモデル初期化失敗経由)は`undefined`のままにし、UI側で
 * 原因別メッセージを出さない(cancelAllは「失敗」ではなくユーザー操作による中断であり、
 * モデル初期化失敗は既に専用のrole="alert"バナーで原因を説明済みのため)。
 */
function failedPatch(failureKind?: FailureKind): RowPatch {
  return { amountYen: null, status: "failed", candidates: [], processing: false, failureKind };
}

/**
 * 同一`OcrEngine`インスタンスへのアクセスをモジュール内で直列化するレーン。
 *
 * `createOcrQueue()`ごとの`running`フラグだけでは、同じengineを共有する
 * 複数のキューインスタンスが同時に`processItem()`(canvasデコード含む)へ
 * 到達し得る(Codexレビュー指摘I1)。ppu-paddle-ocrのONNXセッションは
 * 同時多重実行を想定していないため、engine単位でグローバルに排他する。
 */
const engineLanes = new WeakMap<OcrEngine, Promise<void>>();

/** `engine`に紐づくレーンで`job`を直列実行する。前段のjob失敗有無に関わらず後続は必ず実行される。 */
function runExclusive<T>(engine: OcrEngine, job: () => Promise<T>): Promise<T> {
  const previous = engineLanes.get(engine) ?? Promise.resolve();
  const result = previous.then(job);
  engineLanes.set(
    engine,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

export type OcrQueue = ReturnType<typeof createOcrQueue>;

/**
 * File群を1枚ずつ直列(while逐次)で処理するOCRキュー。
 *
 * `Promise.all`等での並列化は禁止(Global Constraints)。ppu-paddle-ocrのONNX
 * セッションは同時多重実行を想定しておらず、モデル自体も31MB前後あるため、
 * 1枚ずつ確実に処理し進捗をonStatusで都度通知する。
 */
export function createOcrQueue(
  engine: OcrEngine,
  cb: QueueCallbacks,
  deps: OcrQueueDeps = defaultDeps,
) {
  const pending: Item[] = [];
  let running = false;
  let itemInFlight = false;
  let initialized = false;
  let total = 0;
  let done = 0;

  // dispose()用の状態(Codexレビュー指摘I2)。`disposed`になった後は新規enqueueを
  // 拒否し、コールバックも一切発火させない。`idleWaiters`は「現在実行中のジョブが
  // 完了しキューが完全に空転(running===false)した」タイミングでdispose()側の
  // 待機を解決するための単純なイベント通知。
  let disposed = false;
  let idleWaiters: Array<() => void> = [];

  function notifyIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitUntilIdle(): Promise<void> {
    if (!running) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  /** 呼び出し側コールバックの例外でキューの状態遷移を壊さないよう隔離する(Codexレビュー指摘I2)。
   *  dispose後は呼び出し側(アンマウント済みの可能性がある)へコールバックを一切発火しない。 */
  function emitStatus(event: QueueStatusEvent): void {
    if (disposed) return;
    try {
      cb.onStatus(event);
    } catch (err) {
      console.error("OCR status callback failed:", err);
    }
  }

  /** 同上。呼び出し側コールバックの例外を握りつぶし、後続行の処理継続を妨げない。 */
  function emitResult(id: string, patch: RowPatch): void {
    if (disposed) return;
    try {
      cb.onResult(id, patch);
    } catch (err) {
      console.error("OCR result callback failed:", id, err);
    }
  }

  /** 同上。サムネイル生成自体の失敗はbest-effortとして扱い、OCR結果に影響させない。 */
  function emitThumbnail(id: string, blob: Blob): void {
    if (disposed) return;
    try {
      cb.onThumbnail(id, blob);
    } catch (err) {
      console.error("OCR thumbnail callback failed:", id, err);
    }
  }

  /** 同上。プレビュー生成自体の失敗もbest-effortとして扱う(Codexレビュー最終ゲート指摘I2)。 */
  function emitPreview(id: string, blob: Blob): void {
    if (disposed) return;
    try {
      cb.onPreview(id, blob);
    } catch (err) {
      console.error("OCR preview callback failed:", id, err);
    }
  }

  /** 裸の`void run()`を一箇所に集約し、予期しないrejectを未処理のまま放置しない。 */
  function kick(): void {
    void run().catch((err) => {
      console.error("OCR queue failed unexpectedly:", err);
    });
  }

  async function processItem(item: Item): Promise<void> {
    // 画像ロード(decode)とOCR推論の失敗を別のtry/catchに分離する(Codexレビュー最終ゲート
    // 指摘I1)。従来は単一のtry/catchで両方を囲んでおり、未対応形式・破損画像・巨大画像・
    // OCR推論失敗のすべてが同じ`failedPatch()`(failureKindなし)に潰れ、UIも「読取失敗」の
    // 一律表示になっていた。原因ごとに再試行が有効かどうかが異なるため区別する。
    let canvas: HTMLCanvasElement;
    try {
      canvas = await deps.loadAsCanvas(item.file);
    } catch (err) {
      console.error("Image load failed:", item.file.name, err);
      emitResult(item.id, failedPatch(classifyLoadError(err)));
      return;
    }

    // 処理済み(縮小済み)canvasから表示用サムネイル・プレビューを生成して即座に返す
    // (Codexレビュー指摘I1・最終ゲート指摘I2)。元画像のObject URLをApp側で保持し続けると
    // メモリを圧迫するため、ここで作る縮小Blobを表示専用に使う。生成失敗はどちらも
    // OCR結果に影響させないbest-effort。
    try {
      const thumbnail = await deps.toThumbnailBlob(canvas);
      emitThumbnail(item.id, thumbnail);
    } catch (thumbErr) {
      console.error("Thumbnail generation failed:", item.file.name, thumbErr);
    }
    try {
      const preview = await deps.toPreviewBlob(canvas);
      emitPreview(item.id, preview);
    } catch (previewErr) {
      console.error("Preview generation failed:", item.file.name, previewErr);
    }

    let enhanced: HTMLCanvasElement | undefined;
    let patch: RowPatch;
    try {
      const firstResult = extractTotal(await engine.recognize(canvas));

      let result = firstResult;
      if (firstResult.status !== "auto-high") {
        // 二段階前処理: auto-high以外は常にコントラスト補正で再試行する
        // (「failedのみ再試行」ではなく、needs-reviewも含めて再試行する。
        // Task 4スパイクのpickBestAttempt方針と揃えている)。
        // 再試行自体(補正処理/2回目認識)が例外を投げても、1回目の有効な結果を
        // 失わないようbest-effortとして扱う(Codexレビュー指摘: 再試行失敗で
        // 元結果ごと失われるのを防ぐ)。
        try {
          enhanced = deps.enhanceContrast(canvas);
          const secondResult = extractTotal(await engine.recognize(enhanced));
          // 補正版がauto-highになった場合のみ採用し、そうでなければ元結果を維持する
          // (補正で悪化するケースへの対策。補正版が常に優れているとは限らない)。
          if (secondResult.status === "auto-high") result = secondResult;
        } catch (retryErr) {
          console.error("OCR retry failed, keeping first result:", item.file.name, retryErr);
        }
      }

      patch = {
        amountYen: result.amountYen,
        status: result.status,
        candidates: result.candidates,
        processing: false,
      };
    } catch (err) {
      console.error("OCR failed:", item.file.name, err);
      patch = failedPatch("ocr");
    } finally {
      // onResult(呼び出し側コールバック)の例外をOCR失敗と誤認しないよう、
      // canvas解放後・try/catch外でonResultを呼ぶ(Codexレビュー指摘)。
      releaseCanvas(canvas);
      if (enhanced) releaseCanvas(enhanced);
    }
    emitResult(item.id, patch);
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!initialized) {
        emitStatus({ kind: "preparing" });
        try {
          await engine.initialize();
          initialized = true;
        } catch (err) {
          // 初期化失敗時、現在の未処理分をすべて失敗確定する(Codexレビュー指摘:
          // ここで何もしないとprocessing:trueのまま永久に残留する)。
          console.error("OCR engine initialization failed:", err);
          for (const item of pending.splice(0)) {
            done++;
            emitResult(item.id, failedPatch());
          }
          emitStatus({ kind: "model-error", message: "モデル準備に失敗しました" });
          return;
        }
      }
      while (pending.length > 0) {
        const item = pending.shift()!;
        done++;
        emitStatus({ kind: "processing", current: done, total });
        itemInFlight = true;
        try {
          // engine単位のレーンで排他する。同じengineを共有する別キューインスタンスからの
          // processItem()(canvasデコード含む)とも同時実行1を保証する(Codexレビュー指摘I1)。
          await runExclusive(engine, () => processItem(item));
        } finally {
          itemInFlight = false;
        }
      }
      emitStatus({ kind: "complete", done, total });
    } finally {
      running = false;
      if (pending.length > 0) {
        // 完了通知(onStatus/onResult)コールバックの中から同期的にenqueueされた
        // 分を取りこぼさない(Codexレビュー指摘: runningガードで即returnした
        // enqueue呼び出しをここで拾い直す)。
        kick();
      } else {
        total = 0;
        done = 0;
        // running===falseかつ後続のkickもない=真に空転状態。dispose()側の待機を解決する
        // (Codexレビュー指摘I2)。
        notifyIdle();
      }
    }
  }

  return {
    enqueue(id: string, file: File) {
      // dispose後は新規enqueueを一切受け付けない(Codexレビュー指摘I2)。
      if (disposed) return;
      // 未処理・処理中のアイテムが無ければ、これは新しいバッチの開始とみなし
      // カウンタをリセットする。完了通知コールバックからの同期的な再入enqueueで
      // 前バッチのdone/totalを引きずり「画像 2/2」のような不自然な表示になる
      // 問題への対策(Codexレビュー指摘Minor)。処理中アイテムがある場合(同一
      // バッチの継続的な追加投入)はリセットしない。
      if (pending.length === 0 && !itemInFlight) {
        total = 0;
        done = 0;
      }
      pending.push({ id, file });
      total++;
      kick();
    },
    /** 未処理分を全部キャンセルする(処理済み・処理中の行はそのまま維持)。 */
    cancelAll() {
      const canceled = pending.splice(0);
      done += canceled.length; // 完了表示の分母/分子を一致させる(Codexレビュー指摘)
      for (const item of canceled) {
        emitResult(item.id, failedPatch());
      }
    },
    /**
     * アンマウント等でengineを破棄する前に呼ぶ非同期の後始末(Codexレビュー指摘I2)。
     *
     * - 以降の`enqueue()`を拒否する
     * - 未処理分(pending)を破棄する(コールバックは発火しない)
     * - 以降、内部で進行中の処理が完了してもコールバックは発火しない(`disposed`ガード)
     * - 実行中のジョブ(`engine.initialize()`または`engine.recognize()`)が完了するまで待つ
     *
     * これらをすべて終えてから解決するため、呼び出し側は
     * `queue.dispose().finally(() => engine.destroy())`のように安全にengineを破棄できる。
     */
    async dispose(): Promise<void> {
      disposed = true;
      pending.splice(0);
      await waitUntilIdle();
    },
  };
}
