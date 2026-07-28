import type { OcrEngine } from "./engine";
import type { RowPatch } from "../state/reducer";
import { loadAsCanvas, enhanceContrast } from "../image/preprocess";
import { extractTotal } from "../extract/extractTotal";

export type QueueCallbacks = {
  onStatus(text: string): void; // "モデル準備中" / "画像 3/12 処理中"
  onResult(id: string, patch: RowPatch): void; // 行更新(amountYen/status/candidates/processing)
};

type Item = { id: string; file: File };

/**
 * `loadAsCanvas`/`enhanceContrast`の差し替えポイント。
 * 実運用では`src/image/preprocess.ts`の実装を使うが、jsdom環境の単体テストでは
 * 実Canvas描画(`drawImage`/`getImageData`等)に依存できないため、薄いスタブに
 * 差し替えられるようにしている。
 */
export type OcrQueueDeps = {
  loadAsCanvas: (file: File) => Promise<HTMLCanvasElement>;
  enhanceContrast: (src: HTMLCanvasElement) => HTMLCanvasElement;
};

const defaultDeps: OcrQueueDeps = { loadAsCanvas, enhanceContrast };

/** 処理済みcanvasの明示解放。描画バッファをGC任せにせず即座に縮小する。 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * キャンセル/初期化失敗/例外時の一律失敗patch。
 * `candidates`は空配列だが、複数行が同一配列インスタンスを共有して将来の
 * 意図しないミューテーションで汚染し合わないよう、呼び出しごとに新規生成する。
 */
function failedPatch(): RowPatch {
  return { amountYen: null, status: "failed", candidates: [], processing: false };
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
  let initialized = false;
  let total = 0;
  let done = 0;

  async function processItem(item: Item): Promise<void> {
    let canvas: HTMLCanvasElement | undefined;
    let enhanced: HTMLCanvasElement | undefined;
    let patch: RowPatch;
    try {
      canvas = await deps.loadAsCanvas(item.file);
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
      patch = failedPatch();
    } finally {
      // onResult(呼び出し側コールバック)の例外をOCR失敗と誤認しないよう、
      // canvas解放後・try/catch外でonResultを呼ぶ(Codexレビュー指摘)。
      if (canvas) releaseCanvas(canvas);
      if (enhanced) releaseCanvas(enhanced);
    }
    cb.onResult(item.id, patch);
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!initialized) {
        cb.onStatus("モデル準備中…");
        try {
          await engine.initialize();
          initialized = true;
        } catch (err) {
          // 初期化失敗時、現在の未処理分をすべて失敗確定する(Codexレビュー指摘:
          // ここで何もしないとprocessing:trueのまま永久に残留する)。
          console.error("OCR engine initialization failed:", err);
          for (const item of pending.splice(0)) {
            done++;
            cb.onResult(item.id, failedPatch());
          }
          cb.onStatus("モデル準備に失敗しました");
          return;
        }
      }
      while (pending.length > 0) {
        const item = pending.shift()!;
        done++;
        cb.onStatus(`画像 ${done}/${total} 処理中…`);
        await processItem(item);
      }
      cb.onStatus(total > 0 ? `完了 (${done}/${total})` : "");
    } finally {
      running = false;
      if (pending.length > 0) {
        // 完了通知(onStatus/onResult)コールバックの中から同期的にenqueueされた
        // 分を取りこぼさない(Codexレビュー指摘: runningガードで即returnした
        // enqueue呼び出しをここで拾い直す)。
        void run();
      } else {
        total = 0;
        done = 0;
      }
    }
  }

  return {
    enqueue(id: string, file: File) {
      pending.push({ id, file });
      total++;
      void run();
    },
    /** 未処理分を全部キャンセルする(処理済み・処理中の行はそのまま維持)。 */
    cancelAll() {
      const canceled = pending.splice(0);
      done += canceled.length; // 完了表示の分母/分子を一致させる(Codexレビュー指摘)
      for (const item of canceled) {
        cb.onResult(item.id, failedPatch());
      }
    },
  };
}
