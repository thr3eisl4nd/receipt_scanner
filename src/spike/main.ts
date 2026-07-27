import { createPpuPaddleEngine } from "../ocr/ppuPaddleEngine";
import { loadAsCanvas, enhanceContrast } from "../image/preprocess";
import { extractTotal, type ExtractResult } from "../extract/extractTotal";
import type { OcrLine } from "../ocr/engine";
import { isWebGpuAvailable } from "ppu-paddle-ocr/web";

/** 1回のOCR試行(元画像 or コントラスト補正版)の記録。 */
type Attempt = {
  kind: "original" | "contrast";
  ocrMs: number;
  lines: OcrLine[];
  result: ExtractResult;
};

type SpikeEntry = {
  file: string;
  /** デコード開始からOCR・再試行・抽出完了(または例外)までのエンドツーエンド時間。 */
  totalMs: number;
  attempts: Attempt[];
  error?: string;
};

/** 複数選択(1回のfile input change)を1runとして区切って記録する。 */
type SpikeRun = {
  startedAt: string;
  userAgent: string;
  /** モデル初回ロード時間。2回目以降のrunは既存値を引き継ぐ(再ロードしないため)。 */
  initializeMs: number;
  /** WebGPUが利用可能だったか(実際に使われた実行プロバイダそのものではなく、
   *  ppu-paddle-ocrがWebGPUを優先するかどうかの判定に使う入力)。 */
  webGpuAvailable: boolean;
  entries: SpikeEntry[];
};

const statusEl = document.getElementById("status") as HTMLElement;
const resultsEl = document.getElementById("results") as HTMLElement;
const filesInput = document.getElementById("files") as HTMLInputElement;
const engine = createPpuPaddleEngine();

const runs: SpikeRun[] = [];
let initialized = false;
let initializeMs = 0;

/**
 * iOSではCanvas backing storeの回収タイミングがJSオブジェクトのGCと一致する
 * 保証がないため、連続処理(30枚等)に備えて使い終えたcanvasを明示的に解放する。
 */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

async function runAttempt(kind: Attempt["kind"], canvas: HTMLCanvasElement): Promise<Attempt> {
  const t0 = performance.now();
  const lines = await engine.recognize(canvas);
  const ocrMs = Math.round(performance.now() - t0);
  const result = extractTotal(lines);
  return { kind, ocrMs, lines, result };
}

/** auto-highを優先し、なければ元画像(先頭)のattemptを維持する(補正版が悪化する場合の安全策)。 */
function pickBestAttempt(attempts: Attempt[]): Attempt | undefined {
  return attempts.find((a) => a.result.status === "auto-high") ?? attempts[0];
}

function statusClass(status: ExtractResult["status"] | undefined): "ok" | "warn" {
  return status === "auto-high" ? "ok" : "warn";
}

/** OCR文字列・ファイル名はユーザー由来かつ信頼できないため、innerHTMLは使わずDOM APIで組み立てる。 */
function buildResultDiv(entry: SpikeEntry): HTMLDivElement {
  const div = document.createElement("div");

  if (entry.error !== undefined) {
    div.className = "result ng";
    div.textContent = `${entry.file}: エラー ${entry.error} (${entry.totalMs}ms)`;
    return div;
  }

  const best = pickBestAttempt(entry.attempts);
  const status = best?.result.status;
  div.className = `result ${statusClass(status)}`;

  const title = document.createElement("b");
  title.textContent = entry.file;

  const amountLabel =
    best !== undefined && best.result.amountYen !== null ? `${best.result.amountYen}円` : "抽出失敗";
  const retried = entry.attempts.length > 1;
  const summary = document.createElement("span");
  summary.textContent = ` → ${amountLabel} [${status ?? "failed"}] ${entry.totalMs}ms${retried ? " (再試行あり)" : ""}`;

  const pre = document.createElement("pre");
  pre.textContent =
    best?.lines.map((l) => `${Math.round(l.confidence * 100)}% ${l.text}`).join("\n") ?? "";

  div.append(title, summary, pre);
  return div;
}

filesInput.addEventListener("change", async () => {
  const files = [...(filesInput.files ?? [])];
  if (files.length === 0) return;

  // 処理中は複数のchangeイベントが並走してOCRセッションを取り合わないよう、inputを無効化する。
  filesInput.disabled = true;
  try {
    if (!initialized) {
      statusEl.textContent = "モデルロード中…";
      const t0 = performance.now();
      try {
        await engine.initialize();
      } catch (err) {
        statusEl.textContent = `モデル初期化に失敗しました: ${String(err)}`;
        return;
      }
      initializeMs = Math.round(performance.now() - t0);
      initialized = true;
      statusEl.textContent = `モデルロード完了 (${initializeMs}ms)`;
    }

    const run: SpikeRun = {
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      initializeMs,
      webGpuAvailable: await isWebGpuAvailable(),
      entries: [],
    };
    runs.push(run);

    for (let i = 0; i < files.length; i++) {
      statusEl.textContent = `処理中 ${i + 1}/${files.length}`;
      const t0 = performance.now();
      let source: HTMLCanvasElement | null = null;
      let enhanced: HTMLCanvasElement | null = null;
      let entry: SpikeEntry;
      try {
        source = await loadAsCanvas(files[i]);
        const attempts: Attempt[] = [];

        const first = await runAttempt("original", source);
        attempts.push(first);

        // needs-review/failedはどちらも「そのままでは自動確定できない」ため、
        // 低信頼として扱いコントラスト補正版で再試行する。
        if (first.result.status !== "auto-high") {
          enhanced = enhanceContrast(source);
          attempts.push(await runAttempt("contrast", enhanced));
        }

        entry = { file: files[i].name, totalMs: Math.round(performance.now() - t0), attempts };
      } catch (err) {
        // 例外画像もp95に反映されるよう、経過時間を必ず記録する。
        entry = {
          file: files[i].name,
          totalMs: Math.round(performance.now() - t0),
          attempts: [],
          error: String(err),
        };
      } finally {
        releaseCanvas(enhanced);
        releaseCanvas(source);
      }
      run.entries.push(entry);
      resultsEl.append(buildResultDiv(entry));
    }

    statusEl.textContent = `完了 (${files.length}枚)`;
  } finally {
    filesInput.disabled = false;
    filesInput.value = "";
  }
});

document.getElementById("copy")!.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(runs, null, 2));
  statusEl.textContent = "コピーしました";
});
