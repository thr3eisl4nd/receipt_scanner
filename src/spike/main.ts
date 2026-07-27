import { createPpuPaddleEngine } from "../ocr/ppuPaddleEngine";
import { loadAsCanvas, enhanceContrast } from "../image/preprocess";
import { extractTotal } from "../extract/extractTotal";

const statusEl = document.getElementById("status")!;
const resultsEl = document.getElementById("results")!;
const engine = createPpuPaddleEngine();
const allResults: unknown[] = [];
let initialized = false;

document.getElementById("files")!.addEventListener("change", async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (!initialized) {
    statusEl.textContent = "モデルロード中…";
    const t0 = performance.now();
    await engine.initialize();
    initialized = true;
    statusEl.textContent = `モデルロード完了 (${Math.round(performance.now() - t0)}ms)`;
  }
  for (let i = 0; i < files.length; i++) {
    statusEl.textContent = `処理中 ${i + 1}/${files.length}`;
    const t0 = performance.now();
    try {
      const canvas = await loadAsCanvas(files[i]);
      let lines = await engine.recognize(canvas);
      let retried = false;
      let result = extractTotal(lines);
      if (result.status === "failed") {
        lines = await engine.recognize(enhanceContrast(canvas));
        result = extractTotal(lines);
        retried = true;
      }
      const ms = Math.round(performance.now() - t0);
      const entry = { file: files[i].name, ms, retried, result, lines };
      allResults.push(entry);
      const div = document.createElement("div");
      div.className = `result ${result.status === "failed" ? "ng" : "ok"}`;
      div.innerHTML = `<b>${files[i].name}</b> → ${result.amountYen ?? "抽出失敗"}円
        [${result.status}] ${ms}ms ${retried ? "(再試行あり)" : ""}
        <pre>${lines.map((l) => `${Math.round(l.confidence * 100)}% ${l.text}`).join("\n")}</pre>`;
      resultsEl.append(div);
    } catch (err) {
      allResults.push({ file: files[i].name, error: String(err) });
      const div = document.createElement("div");
      div.className = "result ng";
      div.textContent = `${files[i].name}: エラー ${String(err)}`;
      resultsEl.append(div);
    }
  }
  statusEl.textContent = `完了 (${files.length}枚)`;
  (e.target as HTMLInputElement).value = "";
});

document.getElementById("copy")!.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(allResults, null, 2));
  statusEl.textContent = "コピーしました";
});
