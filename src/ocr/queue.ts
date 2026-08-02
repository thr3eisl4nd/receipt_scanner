import type { OcrBox, OcrEngine, OcrLine } from "./engine";
import type { RowPatch } from "../state/reducer";
import type { FailureKind } from "../types";
import type { ExtractResult } from "../extract/extractTotal";
import {
  loadAsCanvas,
  enhanceContrast,
  toThumbnailBlob,
  toPreviewBlob,
  UnsupportedFormatError,
  ImageTooLargeError,
} from "../image/preprocess";
import { loadSourceImage, type NormalizedRect, type SourceImage } from "../image/sourceImage";
import { extractTotal } from "../extract/extractTotal";
import { buildLayoutDecision, cropRectForRegion, DEFAULT_THRESHOLDS, type LayoutDecision } from "./regionDetection";

export type { NormalizedRect } from "../image/sourceImage";

/**
 * `loadAsCanvas`が投げた例外を`Row.failureKind`へ分類する(Codexレビュー最終ゲート
 * 指摘I1)。`UnsupportedFormatError`/`ImageTooLargeError`はinstanceofで判別できるが、
 * それ以外(実装の`ImageDecodeError`、テストスタブが投げる汎用`Error`等)は
 * すべて「デコード失敗」として扱う。`loadSourceImage`(v1.3)も同じエラー型を
 * 投げるため共通で使う。
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
  | { kind: "complete"; done: number; total: number }
  // v1.3(§16.4): パス1(検出)完了時、この写真から複数のレシートを見つけたことを通知する
  // (「この写真から◯枚のレシートを見つけました」)。ambiguousフォールバック(regions.length===1)
  // では発火しない(発見ではなく安全側フォールバックのため)。
  | { kind: "regionsFound"; count: number }
  // v1.3(§16.4): 複数領域のうち何枚目を読取中か(「◯/◯枚目を読取中」)。
  | { kind: "regionProcessing"; current: number; total: number };

/** v1.3(§16.4): パス1で分割された1領域の記述子。`crop`は元画像に対する正規化座標(0..1)。 */
export type RegionDescriptor = { jobId: string; crop: NormalizedRect };

/**
 * v1.3(§16.3/§16.5): `onRegions`と共に渡す安全弁フラグ。
 * - `ambiguous`: 領域判定が曖昧で写真全体を1領域として処理した(§16.3の安全弁。
 *   この場合auto-highは発生しない=呼び出し側は`needs-review`以下として扱われた
 *   結果を受け取る)。
 * - `nearLimit`: 領域数がMAX_REGIONSの上限付近(上限-1以上)。誤結合(本来もっと
 *   多くのレシートがあるのに打ち切られた)の疑いがある目安。
 * UI側(§16.5)はこのいずれかが真、またはグループ内に失敗行がある場合のみ
 * 「写真全体を1枚として読み直す」「削除して撮り直す」の回復導線を表示する。
 */
export type RegionGroupFlags = { ambiguous: boolean; nearLimit: boolean };

/**
 * task-22: 実機診断データ収集。
 *
 * iPhone Safari固有のマルチレシート誤分割(デスクトップでは再現せず、実機の`rawBoxes`
 * 採取が必要)をユーザーの実機から1タップで回収できるようにするための、検出パス
 * (パス1、`processNewPhoto`)実行時のスナップショット。画像データ・OCR認識テキストは
 * 一切含めない(プライバシー)。座標はすべて検出用canvas(`detectCanvasW`×
 * `detectCanvasH`、長辺`DETECT_LONG_EDGE`px)寸法に対する正規化座標(0..1、小数3桁に
 * 丸め)で持つ(`buildLayoutDecision`に渡す座標系そのもの)。
 */
export type NormalizedBox = { x: number; y: number; width: number; height: number };

export type PhotoDiagnostics = {
  userAgent: string;
  /** 元画像(EXIF回転補正後、検出用に縮小する前)の実寸。 */
  photoW: number;
  photoH: number;
  /** 検出専用実行(パス1)に使ったcanvasの実寸。`rawBoxes`/`decision.regions`の正規化基準。 */
  detectCanvasW: number;
  detectCanvasH: number;
  /** `OcrEngine.detect()`が返した生box(行マージ・oversized除外より前)。 */
  rawBoxes: NormalizedBox[];
  decision: { kind: LayoutDecision["kind"]; regions: NormalizedBox[] };
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 1軸分(x/width または y/height)の正規化(Codexレビュー指摘: 開始点とサイズを
 * 独立に丸めると、丸め後に`start+size`が1をわずかに超えうる。例: 幅1200pxに対し
 * `x=3,width=1197`は独立丸めだと`x:0.003`+`width:0.998`=`1.001`になる)。
 * 開始点・終了点をそれぞれクランプ・丸めてから、丸め後の値同士の差としてサイズを
 * 求めることで、`start+size`が丸め後の終了点と一致し1を超えないことを保証する。
 */
function normalizeAxis(start: number, size: number, total: number): { start: number; size: number } {
  const safeTotal = total > 0 ? total : 1;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const from = round3(clamp(start / safeTotal));
  const to = round3(clamp((start + size) / safeTotal));
  return { start: from, size: round3(Math.max(0, to - from)) };
}

/** `w`/`h`が0以下(テストスタブ等の異常値)でも0除算しない防御込みの正規化。 */
function normalizeBox(box: { x: number; y: number; width: number; height: number }, w: number, h: number): NormalizedBox {
  const { start: x, size: width } = normalizeAxis(box.x, box.width, w);
  const { start: y, size: height } = normalizeAxis(box.y, box.height, h);
  return { x, y, width, height };
}

/** `LayoutDecision`の種別ごとにばらばらなフィールド名(`region`/`regions`/`fallbackRegion`)を1本化する。 */
function regionsOfDecision(decision: LayoutDecision): { x: number; y: number; width: number; height: number }[] {
  if (decision.kind === "single") return [decision.region];
  if (decision.kind === "multiple") return decision.regions;
  return [decision.fallbackRegion];
}

/**
 * `processNewPhoto`から呼ぶ純粋関数として切り出す(単体テスト容易化・可読性)。
 * `rawBoxes`/`decision.regions`は検出用canvas寸法(`detectCanvasW`×`detectCanvasH`)に
 * 対する正規化座標へ変換する。
 */
export function buildPhotoDiagnostics(
  photoW: number,
  photoH: number,
  detectCanvasW: number,
  detectCanvasH: number,
  rawBoxes: readonly OcrBox[],
  decision: LayoutDecision,
): PhotoDiagnostics {
  return {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    photoW,
    photoH,
    detectCanvasW,
    detectCanvasH,
    rawBoxes: rawBoxes.map((b) => normalizeBox(b, detectCanvasW, detectCanvasH)),
    decision: {
      kind: decision.kind,
      regions: regionsOfDecision(decision).map((r) => normalizeBox(r, detectCanvasW, detectCanvasH)),
    },
  };
}

export type QueueCallbacks = {
  onStatus(event: QueueStatusEvent): void;
  // v1.3(§16.4): パス1完了時、1枚の写真が複数領域(レシート)に分割されたことを通知する。
  // 領域が1つ(kind:"single")の場合は発火しない(既存の1枚運用と完全互換にするため、
  // 呼び出し側は`onResult`をそのまま`id`(enqueueに渡したid)で受け取ればよい)。
  // 省略可能(未指定の場合、複数領域が生じても何も通知されない=呼び出し側は
  // 単純化のため多重領域を無視できる)。
  onRegions?(photoJobId: string, regions: RegionDescriptor[], flags: RegionGroupFlags): void;
  // task-22: 検出パス(パス1)実行時の実機診断データ。新規写真ジョブ(`processNewPhoto`)
  // ごとに1回発火する(領域が1つ(kind:"single")の場合も含め、検出を実際に実行した
  // 全ての新規写真で発火する。`crop`/`forceSingle`指定の再試行・回復導線では検出を
  // やり直さないため発火しない)。画像データ・OCR認識テキストは含まない。
  // `photoJobId`は`enqueue()`に渡したid(`onRegions`と同じ引数)そのもの
  // (Codexレビュー指摘: これが無いと、呼び出し側は届いた診断データが現在も有効な
  // 写真ジョブのものか検証できず、キャンセル・削除・月次リセット後に届いた古い
  // 診断データで「最新」を誤って上書きしてしまう)。
  // 省略可能(未指定なら何も収集されない=既存の呼び出し側は無視できる)。
  onDiagnostics?(photoJobId: string, diagnostics: PhotoDiagnostics): void;
  // 処理済み(縮小済み)canvasから生成した320px級サムネイルBlobを行へ返す(Codexレビュー指摘I1)。
  // 呼び出し側はObject URL化し、置換時・行削除時・削除済み行への遅着時に確実にrevokeすること。
  onThumbnail(id: string, blob: Blob): void;
  // 拡大表示用の1280px級プレビューBlobを行へ返す(Codexレビュー最終ゲート指摘I2)。
  // onThumbnailと同様、呼び出し側はObject URL化しライフサイクル全体でrevokeを管理する。
  onPreview(id: string, blob: Blob): void;
  onResult(id: string, patch: RowPatch): void; // 行更新(amountYen/status/candidates/processing)
};

/**
 * v1.3(§16.4): 個別領域の再試行・回復用オプション。
 * - `crop`指定時: 元Fileを`loadSourceImage`で再デコードし、この正規化矩形だけを
 *   元解像度からクロップして処理する(検出をやり直さない。特定の1領域の再試行)。
 * - `forceSingle`指定時: 検出(detect)自体をスキップし、写真全体を1領域として
 *   従来経路で処理する(§16.5「写真全体を1枚として読み直す」の回復導線)。
 * どちらも未指定なら、通常の新規写真として検出→領域判定から処理する。
 * - `forceNonAutoHigh`(Codexレビュー最終ゲート指摘C1): `crop`指定の再試行が、
 *   元々`ambiguous`(§16.3安全弁)だった領域の再試行である場合にtrueを渡す。
 *   再試行結果がauto-highでも`needs-review`へ格下げし続け、「ambiguousな行を
 *   再試行するとauto-high禁止が外れる」事故を防ぐ(呼び出し側=App.tsxが
 *   `RetrySource`にこのフラグを保存し、再試行のたびに渡し直す)。
 */
export type EnqueueOptions = { crop?: NormalizedRect; forceSingle?: boolean; forceNonAutoHigh?: boolean };

type Item = { id: string; file: File; generation: number } & EnqueueOptions;

/**
 * `loadAsCanvas`/`enhanceContrast`/`toThumbnailBlob`/`toPreviewBlob`の差し替えポイント。
 * 実運用では`src/image/preprocess.ts`の実装を使うが、jsdom環境の単体テストでは
 * 実Canvas描画(`drawImage`/`getImageData`/`toBlob`等)に依存できないため、薄いスタブに
 * 差し替えられるようにしている。
 *
 * `loadSourceImage`(v1.3)は複数領域が検出された場合の元解像度クロップ用で、任意指定
 * (未指定時は`src/image/sourceImage.ts`の実装を使う)。既存(1枚運用)のテストは
 * 領域が常に1つ(kind:"single")になるため、この依存に触れることはない。
 */
export type OcrQueueDeps = {
  loadAsCanvas: (file: File) => Promise<HTMLCanvasElement>;
  enhanceContrast: (src: HTMLCanvasElement) => HTMLCanvasElement;
  toThumbnailBlob: (src: HTMLCanvasElement) => Promise<Blob>;
  toPreviewBlob: (src: HTMLCanvasElement) => Promise<Blob>;
  loadSourceImage?: (file: File) => Promise<SourceImage>;
};

const defaultDeps: OcrQueueDeps = { loadAsCanvas, enhanceContrast, toThumbnailBlob, toPreviewBlob, loadSourceImage };

/** 処理済みcanvasの明示解放。描画バッファをGC任せにせず即座に縮小する。 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

/** 正規化座標系での「画像全体」矩形(Codexレビュー最終ゲート指摘I4: ambiguous時の
 *  OCR入力は検出文字群のbboxではなく写真全体に固定する)。 */
const FULL_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * §16.1: パス1(検出専用実行)の入力は長辺1200px(仕様・検証スパイクの調整値。
 * Codexレビュー最終ゲート指摘I8)。完全OCR(1枚運用・領域クロップ運用とも共通)の
 * 入力は従来通り長辺1600px。`SourceImage`を1回だけデコードし、そこから
 * 検出用(1200px)・OCR用(1600px)の2つのcanvasをそれぞれ`cropToCanvas`で
 * 生成する(デコード回数を増やさずに済む)。
 */
const DETECT_LONG_EDGE = 1200;
const RECOGNIZE_LONG_EDGE = 1600;

/**
 * [仮説C] コントラスト再試行のゲート閾値(調査由来: `.superpowers/sdd/ocr-investigation.md`
 * Phase3仮説C)。
 *
 * 調査前は`status !== "auto-high"`のみで無条件に2回目のOCR(`enhanceContrast`再試行)を
 * 実行していたが、Phase 1の実測で「読みにくい写真ほど遅い」という複合症状(2回分で
 * 約2倍の処理時間)が確認された。一方、劣化画像9条件すべてで再試行が最終結果
 * (status/amountYen)を変えたケースは無かった(常に同じ結果に収束していた)ため、
 * 「本当に読みにくい画像」だけに再試行を絞ることで精度を落とさずに処理時間を削減できる。
 *
 * ゲート条件(`failed`のみに適用。Codexレビュー指摘I5で`needs-review`は無条件再試行に
 * 変更したため、詳細は`shouldRetryWithContrast`のdocを参照): 1回目の認識行数が
 * `RETRY_MIN_LINES`未満、**または**1回目の平均confidenceが`RETRY_MAX_AVG_CONFIDENCE`
 * 未満の場合のみ再試行する。confidence統計値は「平均(confStat=avg)」を採用する。
 * 「最良の1行(confStat=max)」で試したところ、劣化画像でもヘッダー/フッター等の
 * 読みやすい行が1つは残るためほぼ常に閾値を超えてしまい、ゲートの判別力が失われる
 * ことを調査で確認したため。
 *
 * 閾値(行数15・平均confidence0.85)は調査で使った合成劣化データセットに基づく初期値であり、
 * 実機データでの再チューニングが必要(調査レポート「Phase 3: 仮説C」の限界節を参照)。
 */
const RETRY_MIN_LINES = 15;
const RETRY_MAX_AVG_CONFIDENCE = 0.85;

/**
 * 行confidenceの平均値。非有限値(`NaN`/`Infinity`)への防御(Codexレビュー指摘Minor)。
 *
 * 本番の`mapRecognitionResult.ts`はconfidenceを`[0,1]`へ正規化するため現行エンジンでは
 * 顕在化しないが、`createOcrQueue`は任意の`OcrEngine`を受け入れるため境界で防御する。
 * 1件でも非有限値があれば全体を0扱いにする(NaNはそのままだと平均もNaNになり
 * `NaN < RETRY_MAX_AVG_CONFIDENCE`が常にfalseとなって再試行を誤ってスキップし、
 * Infinityも同様に平均がInfinityとなって同じ問題を起こすため)。
 */
function averageConfidence(lines: OcrLine[]): number {
  if (lines.length === 0) return 0;
  let sum = 0;
  for (const line of lines) {
    if (!Number.isFinite(line.confidence)) return 0;
    sum += Math.min(1, Math.max(0, line.confidence));
  }
  return sum / lines.length;
}

/**
 * 1回目の認識結果からコントラスト再試行が必要かを判定する(Codexレビュー指摘I5)。
 *
 * - `auto-high`: 既に成功しているため無条件に再試行しない(従来通り)。
 * - `needs-review`: 無条件に常に再試行する。[仮説A]の弱ラベル経由の候補は設計上
 *   `needs-review`止まりのため、行数・平均confidenceによるゲートで再試行を
 *   スキップしてしまうと、コントラスト補正で改善しうるケースを取り逃す
 *   (全行平均には抽出判断に無関係な行のconfidenceも含まれ、合計ラベル自体の
 *   低confidenceが埋もれるため)。
 * - `failed`: 行数・平均confidenceによるゲートを適用する(従来の[仮説C]ゲート)。
 *   1回目の認識行数が`RETRY_MIN_LINES`未満、**または**平均confidenceが
 *   `RETRY_MAX_AVG_CONFIDENCE`未満の場合のみ再試行する。
 */
function shouldRetryWithContrast(status: ExtractResult["status"], lines: OcrLine[]): boolean {
  if (status === "auto-high") return false;
  if (status === "needs-review") return true;

  if (lines.length < RETRY_MIN_LINES) return true;
  return averageConfidence(lines) < RETRY_MAX_AVG_CONFIDENCE;
}

/**
 * `ExtractResult["status"]`の「良さ」の順位(Codexレビュー指摘I4)。
 * コントラスト再試行の採用条件に使う: 数値が大きいほど良い結果。
 */
const STATUS_RANK: Record<ExtractResult["status"], number> = {
  failed: 0,
  "needs-review": 1,
  "auto-high": 2,
};

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
 *
 * v1.3(§16.1): 1枚の写真ごとに「検出1回(detect, 長辺1200相当)+完全OCR N回」を
 * 直列実行する(検出も完全OCRも常に直列。並列化しない)。検出結果(§16.2の再帰XY-cut、
 * `regionDetection.ts`)が単一領域(kind:"single")なら、従来通り1回のrecognize+
 * 再試行ゲートで完結する(1枚運用との完全互換、既存269テストの前提)。複数領域
 * (kind:"multiple")、または領域判定が曖昧(kind:"ambiguous", §16.3の安全弁)の場合のみ、
 * `onRegions`で呼び出し側へ通知したうえで元解像度からの領域クロップ→領域ごとの
 * OCRへ進む。
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

  /**
   * キャンセル世代トークン(Codexレビュー最終ゲート指摘I1)。
   *
   * v1.3以前は「実行中の1件」が高々1枚のOCRだったため、`cancelAll()`は`pending`
   * (未着手分)だけを破棄すれば十分だった。v1.3では実行中の1写真ジョブが最大
   * `MAX_REGIONS`(既定8)個の領域処理を内包するため、`cancelAll()`/`dispose()`が
   * 呼ばれた後もその写真の残り領域のOCRが最後まで走り、大きな`ImageBitmap`
   * (`SourceImage`)も全領域完了まで保持され続けてしまう。
   *
   * `enqueue()`時点の`cancelGeneration`を各アイテムへ焼き付け、`cancelAll()`が
   * 呼ばれるたびにこの世代を進める。実行中の写真ジョブは領域ループの各反復前に
   * `canceled(item)`を確認し、世代が変わっていれば(=cancelAll済み)残りの領域には
   * 進まずbreakする(`disposed`も同じ判定に含める。dispose後の継続処理を止める
   * という点でcancelAllと同じ効果を持たせるため)。
   */
  let cancelGeneration = 0;

  function canceled(item: Item): boolean {
    return disposed || item.generation !== cancelGeneration;
  }

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

  /** 同上。v1.3: 複数領域への分割通知(`onRegions`未指定なら何もしない)。 */
  function emitRegions(photoJobId: string, regions: RegionDescriptor[], flags: RegionGroupFlags): void {
    if (disposed || !cb.onRegions) return;
    try {
      cb.onRegions(photoJobId, regions, flags);
    } catch (err) {
      console.error("OCR onRegions callback failed:", photoJobId, err);
    }
  }

  /** 同上。task-22: 実機診断データ(`onDiagnostics`未指定なら何もしない、best-effort)。 */
  function emitDiagnostics(photoJobId: string, diagnostics: PhotoDiagnostics): void {
    if (disposed || !cb.onDiagnostics) return;
    try {
      cb.onDiagnostics(photoJobId, diagnostics);
    } catch (err) {
      console.error("OCR onDiagnostics callback failed:", photoJobId, err);
    }
  }

  /** 裸の`void run()`を一箇所に集約し、予期しないrejectを未処理のまま放置しない。 */
  function kick(): void {
    void run().catch((err) => {
      console.error("OCR queue failed unexpectedly:", err);
    });
  }

  /**
   * サムネイル・プレビューの生成+通知(best-effort、Codexレビュー指摘I1・最終ゲート指摘I2)。
   * `canvas`(処理済み・縮小済み)から生成し、失敗してもOCR結果には影響させない。
   */
  async function emitThumbnailAndPreview(id: string, canvas: HTMLCanvasElement): Promise<void> {
    try {
      const thumbnail = await deps.toThumbnailBlob(canvas);
      emitThumbnail(id, thumbnail);
    } catch (thumbErr) {
      console.error("Thumbnail generation failed:", id, thumbErr);
    }
    try {
      const preview = await deps.toPreviewBlob(canvas);
      emitPreview(id, preview);
    } catch (previewErr) {
      console.error("Preview generation failed:", id, previewErr);
    }
  }

  /**
   * recognize→extractTotal→コントラスト再試行ゲート、を実行しRowPatchを組み立てる
   * (1枚運用・領域クロップ運用の両方から共有する中核パイプライン)。`canvas`は
   * 呼び出し側が既に用意した処理対象(1枚運用なら`loadAsCanvas`結果、領域クロップ
   * 運用なら`SourceImage.cropToCanvas`結果)。呼び出し後、`canvas`(と再試行で
   * 生成した補正版)は必ず解放する。
   *
   * `forceNonAutoHigh`(§16.3の安全弁): 領域判定が`ambiguous`だった場合にtrueを渡す。
   * 誤って2枚を1領域に結合したまま片方の合計を自動確定する事故を防ぐため、最終結果が
   * `auto-high`でも`needs-review`へ格下げする(金額・候補はそのまま、状態のみ変更)。
   */
  async function runOcrPipeline(canvas: HTMLCanvasElement, forceNonAutoHigh: boolean): Promise<RowPatch> {
    let enhanced: HTMLCanvasElement | undefined;
    let patch: RowPatch;
    try {
      const firstLines = await engine.recognize(canvas);
      const firstResult = extractTotal(firstLines);

      let result = firstResult;
      if (shouldRetryWithContrast(firstResult.status, firstLines)) {
        // 二段階前処理: [仮説C]+Codexレビュー指摘I5のゲートに従い、`needs-review`は
        // 常に、`failed`は行数が少ない・平均confidenceが低い場合のみコントラスト補正で
        // 再試行する(`auto-high`は既にshouldRetryWithContrastでfalseになっている)。
        // 再試行自体(補正処理/2回目認識)が例外を投げても、1回目の有効な結果を
        // 失わないようbest-effortとして扱う(Codexレビュー指摘: 再試行失敗で
        // 元結果ごと失われるのを防ぐ)。
        try {
          enhanced = deps.enhanceContrast(canvas);
          const secondResult = extractTotal(await engine.recognize(enhanced));
          // ステータスが改善した場合のみ採用する(Codexレビュー指摘I4)。
          // 従来は「補正版がauto-highの場合のみ採用」だったため、[仮説A]の弱ラベル経由で
          // 設計上needs-review止まりの回復(例: failed → needs-review)を取り逃していた。
          // 改善していない場合(補正で悪化する/変わらないケース)は元結果を維持する。
          if (STATUS_RANK[secondResult.status] > STATUS_RANK[result.status]) result = secondResult;
        } catch (retryErr) {
          console.error("OCR retry failed, keeping first result:", retryErr);
        }
      }

      // §16.3の安全弁: ambiguous(領域判定が曖昧)な写真から生じた結果はauto-highを
      // 許可しない。誤結合を自動確定させる事故を防ぐため、金額・候補はそのまま
      // needs-reviewへ格下げする。
      const finalStatus = forceNonAutoHigh && result.status === "auto-high" ? "needs-review" : result.status;

      patch = {
        amountYen: result.amountYen,
        status: finalStatus,
        candidates: result.candidates,
        processing: false,
        // 通常経路(例外を投げず`extractTotal`がfailedを返した場合)にも撮り直し案内を
        // 表示できるようfailureKindを付与する(Codexレビュー指摘I1)。従来は例外catch経由の
        // failedにしかfailureKind:"ocr"が付かず、「OCRは成功したが合計を抽出できない」という
        // 主症状で撮り直し案内が到達不能だった。
        failureKind: finalStatus === "failed" ? "ocr" : undefined,
      };
    } catch (err) {
      console.error("OCR failed:", err);
      patch = failedPatch("ocr");
    } finally {
      // onResult(呼び出し側コールバック)の例外をOCR失敗と誤認しないよう、
      // canvas解放後・try/catch外でonResultを呼ぶ(Codexレビュー指摘)。
      releaseCanvas(canvas);
      if (enhanced) releaseCanvas(enhanced);
    }
    return patch;
  }

  /** サムネイル・プレビュー生成→OCRパイプライン→onResult、を1つの`canvas`に対して実行する。 */
  async function processCanvas(id: string, canvas: HTMLCanvasElement, forceNonAutoHigh: boolean): Promise<void> {
    await emitThumbnailAndPreview(id, canvas);
    const patch = await runOcrPipeline(canvas, forceNonAutoHigh);
    emitResult(id, patch);
  }

  /**
   * v1.3(§16.4): 個別領域ジョブ(内部生成 or ユーザーによる`crop`指定の再試行)。
   * 元Fileを`loadSourceImage`で再デコードし、`crop`(正規化座標)だけを元解像度から
   * クロップして通常のOCRパイプラインへ渡す。検出(detect)・領域判定はやり直さない。
   *
   * `forceNonAutoHigh`(Codexレビュー最終ゲート指摘C1): 再試行元がambiguousだった
   * 場合にtrueを渡す。§16.3の安全弁(auto-high禁止)を再試行でも維持するため。
   */
  async function processRegionJob(id: string, file: File, crop: NormalizedRect, forceNonAutoHigh: boolean): Promise<void> {
    const loadSource = deps.loadSourceImage ?? loadSourceImage;
    let source: SourceImage;
    try {
      source = await loadSource(file);
    } catch (err) {
      console.error("Source image load failed:", file.name, err);
      emitResult(id, failedPatch(classifyLoadError(err)));
      return;
    }
    try {
      // クロップ生成自体の例外(Canvas確保失敗・2D context取得失敗・drawImage失敗等)を
      // catchする(Codexレビュー最終ゲート指摘I2)。ここで捕まえないと`processItem()`が
      // rejectし、この行が`processing:true`のまま永久に残留する。
      let cropCanvas: HTMLCanvasElement;
      try {
        cropCanvas = source.cropToCanvas(crop, RECOGNIZE_LONG_EDGE);
      } catch (err) {
        console.error("Region crop failed:", id, err);
        emitResult(id, failedPatch("ocr"));
        return;
      }
      await processCanvas(id, cropCanvas, forceNonAutoHigh);
    } finally {
      source.close();
    }
  }

  /**
   * 写真全体を1領域として扱う経路(§16.5「写真全体を1枚として読み直す」回復導線、および
   * 新規写真がkind:"single"だった場合の従来経路)。`loadAsCanvas`(EXIF回転補正+長辺1600へ
   * 縮小)をそのまま使い、検出は行わない。
   */
  async function processWholePhoto(id: string, file: File, forceNonAutoHigh: boolean): Promise<void> {
    let canvas: HTMLCanvasElement;
    try {
      canvas = await deps.loadAsCanvas(file);
    } catch (err) {
      console.error("Image load failed:", file.name, err);
      emitResult(id, failedPatch(classifyLoadError(err)));
      return;
    }
    await processCanvas(id, canvas, forceNonAutoHigh);
  }

  /**
   * v1.3の中心関数: 新規写真(`crop`/`forceSingle`いずれも未指定)を検出→領域判定から
   * 処理する。§16.1のパス1(検出専用実行、長辺1200px)→再帰XY-cut(`regionDetection.ts`)→
   * LayoutDecisionに応じて分岐する:
   *
   * - `single`: 写真全体を長辺1600pxへ正規化し直し、従来経路(1枚運用)と同じ入力で
   *   OCRする。
   * - `multiple`/`ambiguous`: `onRegions`で通知したうえで、元解像度から領域ごとに
   *   クロップ(`SourceImage`)→領域ごとにOCR、を直列実行する。`ambiguous`は
   *   写真全体(検出文字群のbboxではなく)を単一領域として扱いつつ、auto-highを
   *   禁止する(`runOcrPipeline`の`forceNonAutoHigh`、Codexレビュー最終ゲート指摘I4)。
   *
   * `SourceImage`は1回だけデコードし、検出用(1200px)・完全OCR用(1600px、単一/
   * 領域クロップとも)のいずれのcanvas生成にも使い回す(Codexレビュー最終ゲート
   * 指摘I8: 検出入力を仕様通り長辺1200pxにしつつ、デコード回数を増やさないため)。
   */
  async function processNewPhoto(item: Item): Promise<void> {
    const loadSource = deps.loadSourceImage ?? loadSourceImage;
    let source: SourceImage;
    try {
      source = await loadSource(item.file);
    } catch (err) {
      console.error("Source image load failed:", item.file.name, err);
      emitResult(item.id, failedPatch(classifyLoadError(err)));
      return;
    }

    let detectCanvas: HTMLCanvasElement;
    try {
      detectCanvas = source.cropToCanvas(FULL_RECT, DETECT_LONG_EDGE);
    } catch (err) {
      // 検出用canvas自体の生成失敗(Canvas確保失敗・drawImage失敗等)も、この写真
      // ジョブをfailed確定する(Codexレビュー最終ゲート指摘I2と同じ考え方)。
      console.error("Detect canvas creation failed:", item.file.name, err);
      source.close();
      emitResult(item.id, failedPatch("ocr"));
      return;
    }

    let boxes: OcrBox[];
    try {
      boxes = await engine.detect(detectCanvas);
    } catch (err) {
      // 検出専用実行自体の失敗は、写真全体を1領域として扱う安全側フォールバックにする
      // (§16.3の安全弁と同じ考え方: 分割根拠を得られないなら分割しない)。
      console.error("Detect failed, treating whole photo as a single region:", item.file.name, err);
      boxes = [];
    }

    const decision = buildLayoutDecision(boxes, detectCanvas.width, detectCanvas.height);
    // 後段の正規化座標計算に使うため、解放前に幅・高さを控えておく。
    const detectWidth = detectCanvas.width;
    const detectHeight = detectCanvas.height;
    releaseCanvas(detectCanvas);

    // task-22: 検出パス実行時の実機診断データ収集(画像・認識テキストは含めない)。
    // `decision.kind`に関わらず(single/multiple/ambiguousいずれも)発火する。
    // `canceled(item)`(Codexレビュー指摘): dispose()/cancelAll()が既に呼ばれたジョブでは
    // 発火しない(領域ループ内の他のcanceled()チェックと同じ考え方)。行単位の削除・
    // 再試行による無効化は`queue.ts`側からは判別できないため、呼び出し側(App.tsx)が
    // `photoJobId`で「現在も有効なジョブか」を別途検証する。
    if (!canceled(item)) {
      emitDiagnostics(item.id, buildPhotoDiagnostics(source.width, source.height, detectWidth, detectHeight, boxes, decision));
    }

    if (decision.kind === "single") {
      // 1枚運用との互換: 写真全体を長辺1600pxへ正規化し直してOCRする(検出用1200pxの
      // canvasはここでは使わない。再デコードではなく同一`SourceImage`からの再クロップ
      // なので追加のFile decodeは発生しない)。
      let wholeCanvas: HTMLCanvasElement;
      try {
        wholeCanvas = source.cropToCanvas(FULL_RECT, RECOGNIZE_LONG_EDGE);
      } catch (err) {
        console.error("Whole photo canvas creation failed:", item.file.name, err);
        source.close();
        emitResult(item.id, failedPatch("ocr"));
        return;
      }
      source.close();
      await processCanvas(item.id, wholeCanvas, false);
      return;
    }

    const regions = decision.kind === "multiple" ? decision.regions : [decision.fallbackRegion];
    const ambiguous = decision.kind === "ambiguous";
    const nearLimit = regions.length >= DEFAULT_THRESHOLDS.maxRegions - 1;

    // 検出canvas座標系での正規化座標(0..1)は、EXIF補正済み・無クロップの元画像に対する
    // 正規化座標と一致する(`cropToCanvas(FULL_RECT, ...)`は縦横比を保ったまま一様
    // 縮小するのみのため)。ambiguous(§16.3安全弁)の場合は、fallbackRegion(検出文字群
    // のbbox)ではなく写真全体を固定でOCR入力にする(Codexレビュー最終ゲート指摘I4:
    // 上限到達・断片疑いこそ、bboxクロップで周辺レシートを落とすべきではない)。
    const regionDescriptors: RegionDescriptor[] = regions.map((region, i) => {
      const crop: NormalizedRect = ambiguous
        ? FULL_RECT
        : (() => {
            const cropRect = cropRectForRegion(region, detectWidth, detectHeight);
            return {
              x: cropRect.x / detectWidth,
              y: cropRect.y / detectHeight,
              width: cropRect.width / detectWidth,
              height: cropRect.height / detectHeight,
            };
          })();
      return { jobId: `${item.id}#${i}`, crop };
    });

    emitRegions(item.id, regionDescriptors, { ambiguous, nearLimit });
    if (!ambiguous) {
      emitStatus({ kind: "regionsFound", count: regionDescriptors.length });
    }

    try {
      for (let i = 0; i < regionDescriptors.length; i++) {
        // キャンセル世代トークン(Codexレビュー最終ゲート指摘I1): cancelAll()/dispose()が
        // 呼ばれた後は、残りの領域のOCRを開始しない。SourceImageはこのループを抜けた
        // 直後、finallyで即closeされる(最後の領域まで保持し続けない)。
        if (canceled(item)) break;
        const desc = regionDescriptors[i];
        emitStatus({ kind: "regionProcessing", current: i + 1, total: regionDescriptors.length });
        try {
          // クロップ生成自体の例外をcatchする(Codexレビュー最終ゲート指摘I2)。
          // ここで捕まえないと、この領域の行が`processing:true`のまま永久に残留し、
          // かつ後続領域のOCRにも進めなくなる。
          const cropCanvas = source.cropToCanvas(desc.crop, RECOGNIZE_LONG_EDGE);
          await processCanvas(desc.jobId, cropCanvas, ambiguous);
        } catch (err) {
          console.error("Region crop failed:", desc.jobId, err);
          emitResult(desc.jobId, failedPatch("ocr"));
        }
      }
    } finally {
      source.close();
    }
  }

  async function processItem(item: Item): Promise<void> {
    if (item.crop) {
      await processRegionJob(item.id, item.file, item.crop, item.forceNonAutoHigh ?? false);
      return;
    }
    if (item.forceSingle) {
      await processWholePhoto(item.id, item.file, false);
      return;
    }
    await processNewPhoto(item);
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
    /**
     * `options.crop`/`options.forceSingle`はv1.3の再試行・回復導線用(§16.4/§16.5)。
     * 通常の新規写真追加は`enqueue(id, file)`のまま(第3引数省略)でよい。
     */
    enqueue(id: string, file: File, options?: EnqueueOptions) {
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
      pending.push({
        id,
        file,
        crop: options?.crop,
        forceSingle: options?.forceSingle,
        forceNonAutoHigh: options?.forceNonAutoHigh,
        generation: cancelGeneration,
      });
      total++;
      kick();
    },
    /**
     * 未処理分を全部キャンセルする(処理済み・処理中の行はそのまま維持)。
     *
     * `cancelGeneration`を進めることで、現在実行中の写真ジョブ(v1.3: 最大8領域を
     * 内包しうる)の残り領域ループも次の反復で停止させる(Codexレビュー最終ゲート
     * 指摘I1)。実行中のONNX推論そのものは中断できないため「今処理中の1領域」は
     * 最後まで走るが、それ以降の領域には進まない。
     */
    cancelAll() {
      cancelGeneration++;
      const canceledItems = pending.splice(0);
      done += canceledItems.length; // 完了表示の分母/分子を一致させる(Codexレビュー指摘)
      for (const item of canceledItems) {
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
