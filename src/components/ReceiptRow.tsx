import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { FailureKind, Row } from "../types";
import type { RowPatch } from "../state/reducer";
import { parseYenInput, toggleYenSign, isNegativeYenInput } from "../moneyInput";

const STATUS_LABEL: Record<Row["status"], string> = {
  "auto-high": "自動読取",
  "needs-review": "要確認",
  confirmed: "確認済",
  manual: "手入力",
  failed: "読取失敗",
};

/**
 * 失敗原因ごとの案内文(Codexレビュー最終ゲート指摘I1)。role="alert"で表示し、
 * 「読取失敗」の一律表示では区別できなかった回復手段をユーザーへ示す。
 */
const FAILURE_MESSAGE: Record<FailureKind, string> = {
  "image-decode": "画像を読み込めません。JPEGまたはPNGで追加してください",
  "unsupported-format": "この画像形式には対応していません",
  "image-too-large": "画像が大きすぎます。縮小してから追加してください",
  ocr: "文字を読み取れませんでした。金額を手入力してください",
};

/**
 * このfailureKindで「同じFileを再試行」する意味があるか。
 * 画像デコード失敗・未対応形式・巨大画像は、同じFileを再度読み込ませても
 * 決定的に同じ結果になるため再試行ボタンを出さない(Codexレビュー指摘I1: 原因別の
 * 回復導線)。OCR推論の失敗(ocr)や、failureKind未設定(モデル初期化失敗等の
 * 旧来経路)は再試行に意味があるため引き続き表示する。
 */
function canRetryFailureKind(failureKind: FailureKind | undefined): boolean {
  return failureKind === undefined || failureKind === "ocr";
}

/** `src/moneyInput.ts`の`parseYenInput`の別名エクスポート(Codexレビュー指摘対応でユーティリティを
 *  共通化した後も、既存テスト・呼び出し元との互換のためこの名前を維持する)。 */
export const parseYen = parseYenInput;

type Props = {
  row: Row;
  /** 一覧内での表示順(1始まり)。同名の手動行が複数あってもaria-labelを一意にするために使う
   *  (Codexレビュー最終ゲート指摘Minor#2)。 */
  rowNumber: number;
  /** Appが当該行のFileをまだ保持しているか(再試行ボタンの表示可否、Codexレビュー指摘I8)。 */
  canRetry: boolean;
  onPatch(id: string, patch: RowPatch): void;
  onRemove(id: string): void;
  onRetry(id: string): void;
};

export function ReceiptRow({ row, rowNumber, canRetry, onPatch, onRemove, onRetry }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const amountButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const thumbButtonRef = useRef<HTMLButtonElement>(null);
  const zoomCloseButtonRef = useRef<HTMLButtonElement>(null);
  const wasZoomedRef = useRef(false);
  // 編集終了(確定/キャンセル)のたびにインクリメントし、金額ボタンへフォーカスを戻す
  // トリガーにする(Codexレビュー指摘I5)。初期値0のままではuseLayoutEffectが
  // マウント時にも走ってしまい、行が増えるたびに直前の行からフォーカスを奪ってしまうため、
  // 「実際に編集を閉じた回数」が変化した時だけ発火するようにしている。
  const [focusEpoch, setFocusEpoch] = useState(0);

  useLayoutEffect(() => {
    if (focusEpoch > 0) amountButtonRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEpoch]);

  // 拡大オーバーレイのフォーカス管理(Codexレビュー再指摘I5): 開いたら閉じるボタンへ、
  // 閉じたらサムネイルボタンへ戻す。マウント時(zoomed初期値false)には何もしないよう、
  // 「直前もzoomedだったか」をrefで追跡して遷移時だけ発火させる。
  useLayoutEffect(() => {
    if (zoomed) {
      zoomCloseButtonRef.current?.focus();
    } else if (wasZoomedRef.current) {
      thumbButtonRef.current?.focus();
    }
    wasZoomedRef.current = zoomed;
  }, [zoomed]);

  const startEdit = () => {
    setDraft(row.amountYen === null ? "" : String(row.amountYen));
    setError(null);
    setEditing(true);
  };

  const closeEdit = (restoreFocus: boolean) => {
    setEditing(false);
    setError(null);
    // 明示的な確定・キャンセル操作の時だけ金額ボタンへフォーカスを戻す。無条件に戻すと、
    // ユーザーがTabで次の要素・他の操作へフォーカス移動しただけ(暗黙のblur)でも
    // フォーカスを奪い返してしまう(Codexレビュー再指摘Important: キーボード操作で
    // 「Tabで進んだのに元へ戻される」状態になっていた)。
    if (restoreFocus) setFocusEpoch((n) => n + 1);
  };

  const commitEdit = (restoreFocus: boolean) => {
    const parsed = parseYenInput(draft);
    if (parsed === "invalid") {
      setError("金額は数字で入力してください(例: 1200 / -300)");
      // 編集を閉じず、入力へフォーカスを残す(Codexレビュー指摘I3・I5)
      inputRef.current?.focus();
      return;
    }
    const status = row.source === "manual" ? "manual" : parsed === null ? "failed" : "confirmed";
    // 手修正時は必ずprocessing:falseを含める。OCR処理中に手修正した場合、これが
    // ないと遅延到着したOCR結果が手修正を無警告で上書きしてしまう(Codexレビュー指摘C1)。
    onPatch(row.id, { amountYen: parsed, status, candidates: [], processing: false });
    closeEdit(restoreFocus);
  };

  const cancelEdit = () => {
    // Escapeでの離脱はcloseEdit()がinputをアンマウントするだけで、`.blur()`を明示的に
    // 呼ばない。React再レンダーによるDOM除去は「フォーカス中の要素が除去された」ことに
    // 由来する暗黙のblurイベントを(React 19+jsdomの検証上)発火させないため、
    // 「キャンセル直後の意図しないコミット」を防ぐための特別なガードは不要。
    // Escapeは常に明示操作なので金額ボタンへフォーカスを戻す。
    closeEdit(true);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    // 符号切替・確定・キャンセルボタンへフォーカスが移る場合はコミットしない
    // (Codexレビュー再指摘I1: ポインター操作でinputのblur→ボタンのclickという順序に
    // なる実ブラウザでは、blurで先にcommitEdit()が走り編集UIごと消えてしまい、
    // クリックされたボタン本来の処理(特にキャンセル)が実行されない/意図と異なる
    // 結果になる恐れがあった)。それ以外へのフォーカス移動・喪失時のみ通常通り確定する。
    const next = e.relatedTarget;
    if (next instanceof Node && editorRef.current?.contains(next)) return;
    // relatedTargetがnull(=Enterキー由来のblur.currentTarget.blur()等、次に何も
    // フォーカスされない場合)の時だけ金額ボタンへフォーカスを戻す。Tabや他行操作への
    // クリックでrelatedTargetが実要素になっている場合は、ユーザーが意図的に移動した
    // フォーカス先を金額ボタンへ強制的に戻さない(Codexレビュー再指摘Important)。
    commitEdit(next === null);
  };

  /** エディタ内ボタンのpointerdownでinputのフォーカスを奪わない(Safari含む実ブラウザ対策)。
   *  上記handleBlurのrelatedTargetガードと二重に効くことで、クリック操作でのblur競合を防ぐ。 */
  const keepFocus = (e: PointerEvent) => e.preventDefault();

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // IME変換確定のEnterを誤ってコミットに使わない。二重コミットを避けるため
      // commitEdit()を直接呼ばずblur()に一本化し、onBlurだけがコミットを担う
      // (Codexレビュー指摘I5)。
      if (!e.nativeEvent.isComposing) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  // 符号切替・負数判定はManualEntryFormと共通の実装(src/moneyInput.ts)を使う
  // (Codexレビュー最終ゲート指摘Minor#1: コンポーネント間の重複解消)。
  const toggleSign = () => setDraft((v) => toggleYenSign(v));
  const isNegativeDraft = isNegativeYenInput(draft);

  const displayAmount = row.amountYen === null ? "金額を入力" : `${row.amountYen.toLocaleString("ja-JP")}円`;

  return (
    <li className={`receipt-row ${row.processing ? "is-processing" : `status-${row.status}`}`}>
      {row.thumbnailUrl && (
        <button
          type="button"
          ref={thumbButtonRef}
          className="thumb-button"
          aria-label={`${row.label}の画像を拡大`}
          aria-expanded={zoomed}
          onClick={() => setZoomed((v) => !v)}
        >
          <img src={row.thumbnailUrl} alt="" className="thumb" />
        </button>
      )}
      <div className="row-main">
        <span className="row-label">{row.label}</span>
        <span className={`badge badge-${row.status}`}>
          {row.processing ? "処理中…" : STATUS_LABEL[row.status]}
        </span>
        {editing ? (
          <div className="amount-editor" ref={editorRef}>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              aria-label="金額(円)"
              aria-invalid={error !== null}
            />
            <button
              type="button"
              aria-pressed={isNegativeDraft}
              aria-label={`${row.label}を返品・取消として入力`}
              className="sign-toggle"
              onPointerDown={keepFocus}
              onClick={toggleSign}
            >
              返品・取消として入力
            </button>
            <button
              type="button"
              aria-label={`${row.label}の金額を確定`}
              onPointerDown={keepFocus}
              onClick={() => commitEdit(true)}
            >
              確定
            </button>
            <button
              type="button"
              aria-label={`${row.label}の金額編集をキャンセル`}
              onPointerDown={keepFocus}
              onClick={cancelEdit}
            >
              キャンセル
            </button>
            {error && (
              <p role="alert" className="amount-error">
                {error}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            ref={amountButtonRef}
            className="amount"
            aria-label={`${row.label}の金額を編集`}
            onClick={startEdit}
          >
            {displayAmount}
          </button>
        )}
        {row.status === "needs-review" && row.candidates.length > 1 && (
          <div className="candidates">
            候補:
            {row.candidates.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`${row.label}の候補 ${c.toLocaleString("ja-JP")}円を選択`}
                onClick={() => onPatch(row.id, { amountYen: c, status: "confirmed", candidates: [], processing: false })}
              >
                {c.toLocaleString("ja-JP")}円
              </button>
            ))}
          </div>
        )}
        {row.status === "failed" && !row.processing && (
          <>
            {/* 原因別の案内文(Codexレビュー最終ゲート指摘I1)。role="alert"で即座に
                読み上げられる。failureKind未設定(旧データ・モデル初期化失敗経由)の
                場合は表示しない。 */}
            {row.failureKind && (
              <p role="alert" className="failure-message">
                {FAILURE_MESSAGE[row.failureKind]}
              </p>
            )}
            {canRetry && canRetryFailureKind(row.failureKind) && (
              <button
                type="button"
                className="retry-button"
                aria-label={`${row.label}を再試行`}
                onClick={() => onRetry(row.id)}
              >
                再試行
              </button>
            )}
          </>
        )}
      </div>
      <div className="row-actions">
        <button
          type="button"
          aria-label={`${row.label}（${rowNumber}行目）を${row.payer === "husband" ? "妻" : "夫"}の支払いへ変更`}
          onClick={() => onPatch(row.id, { payer: row.payer === "husband" ? "wife" : "husband" })}
        >
          {row.payer === "husband" ? "→妻へ" : "→夫へ"}
        </button>
        <button type="button" aria-label={`${row.label}（${rowNumber}行目）を削除`} onClick={() => onRemove(row.id)}>
          削除
        </button>
      </div>
      {zoomed && (row.previewUrl ?? row.thumbnailUrl) && (
        <div
          className="thumb-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${row.label}の拡大画像`}
          onClick={() => setZoomed(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setZoomed(false);
            // ダイアログ内の唯一のフォーカス可能要素(閉じるボタン)以外に背景へフォーカスが
            // 抜けないよう、Tab/Shift+Tabはここで無効化する(Codexレビュー再指摘Important:
            // aria-modal="true"を宣言していてもTabで背景の他行の操作へ移動できてしまい、
            // モーダルとして機能していなかった)。
            else if (e.key === "Tab") e.preventDefault();
          }}
        >
          {/* 拡大時は320pxサムネイルではなく1280px相当のpreviewUrlを優先表示する
              (Codexレビュー最終ゲート指摘I2)。<img>は拡大(zoomed)時のみ描画され、
              閉じている間はデコード済み画像を保持しない。previewUrl生成が
              best-effortで失敗している場合はthumbnailUrlへフォールバックする。 */}
          <img src={row.previewUrl ?? row.thumbnailUrl} alt="" className="thumb-overlay-img" />
          <button
            type="button"
            ref={zoomCloseButtonRef}
            className="thumb-overlay-close"
            aria-label="拡大画像を閉じる"
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(false);
            }}
          >
            閉じる
          </button>
        </div>
      )}
    </li>
  );
}
