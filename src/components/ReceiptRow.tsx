import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { Row } from "../types";
import type { RowPatch } from "../state/reducer";

const STATUS_LABEL: Record<Row["status"], string> = {
  "auto-high": "自動読取",
  "needs-review": "要確認",
  confirmed: "確認済",
  manual: "手入力",
  failed: "読取失敗",
};

/**
 * 金額入力の正規化+検証(Codexレビュー指摘I3)。
 *
 * 従来は「数字/マイナス以外を除去してから解釈する」実装だったため、`1.5`→`15`、
 * `12abc34`→`1234`のように入力ミスがまったく別の金額として黙って確定してしまう
 * 危険があった。当初の修正版もNFKC正規化後に許可文字(カンマ・空白・円記号)を
 * 「文字列中のどこからでも」除去してから検証しており、`"円"`単体→null(未入力扱い)、
 * `"1,00"`→100、`"1 2"`→12のように、依然として一部の入力ミスを黙って解釈して
 * しまう穴が残っていた(Codexレビュー再指摘I3)。ここでは許可する書式そのものを
 * 正規表現で構造的に検証し、部分一致除去はしない。
 */
export function parseYen(raw: string): number | null | "invalid" {
  const value = raw.normalize("NFKC").trim();
  if (value === "") return null;

  // 許可する書式: 任意の先頭¥(空白可)、任意の-、"1234"のような数字の並び、または
  // "1,234"/"12,345,678"のようにカンマ区切りが3桁ごとに正しく入っている数字、
  // 任意の末尾円(空白可)。これ以外(記号だけ・桁区切りの誤り・数字の途中に
  // 空白や文字が混ざる等)はすべて"invalid"として拒否する。
  const match = /^(?:¥\s*)?(-?)(\d+|\d{1,3}(?:,\d{3})+)\s*円?$/.exec(value);
  if (!match) return "invalid";

  const parsed = Number(`${match[1]}${match[2].replaceAll(",", "")}`);
  if (!Number.isSafeInteger(parsed)) return "invalid";
  return parsed === 0 ? 0 : parsed; // "-0"の負のゼロを正のゼロへ正規化する(Codexレビュー再指摘Minor)
}

type Props = {
  row: Row;
  /** Appが当該行のFileをまだ保持しているか(再試行ボタンの表示可否、Codexレビュー指摘I8)。 */
  canRetry: boolean;
  onPatch(id: string, patch: RowPatch): void;
  onRemove(id: string): void;
  onRetry(id: string): void;
};

export function ReceiptRow({ row, canRetry, onPatch, onRemove, onRetry }: Props) {
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
    const parsed = parseYen(draft);
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

  // parseYenが許可する書式は「¥(任意)→-(任意)→数字」の順(¥が-より前)。単純に
  // 文字列の先頭へ"-"を足し引きすると、ユーザーが"¥1,234"のように¥を手入力していた
  // 場合に"-¥1,234"という不正な並びを作ってしまう(Codexレビュー再指摘Minor)。
  // 先頭の¥プレフィックスを検出し、その直後に符号を置くようにする。
  const toggleSign = () => {
    setDraft((v) => {
      const prefixMatch = /^[¥￥]\s*/.exec(v);
      const prefix = prefixMatch ? prefixMatch[0] : "";
      const rest = v.slice(prefix.length);
      const toggled = rest.startsWith("-") ? rest.slice(1) : `-${rest}`;
      return `${prefix}${toggled}`;
    });
  };
  const isNegativeDraft = /^[¥￥]?\s*-/.test(draft);

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
        {row.status === "failed" && !row.processing && canRetry && (
          <button
            type="button"
            className="retry-button"
            aria-label={`${row.label}を再試行`}
            onClick={() => onRetry(row.id)}
          >
            再試行
          </button>
        )}
      </div>
      <div className="row-actions">
        <button
          type="button"
          aria-label={`${row.label}を${row.payer === "husband" ? "妻" : "夫"}の支払いへ変更`}
          onClick={() => onPatch(row.id, { payer: row.payer === "husband" ? "wife" : "husband" })}
        >
          {row.payer === "husband" ? "→妻へ" : "→夫へ"}
        </button>
        <button type="button" aria-label={`${row.label}を削除`} onClick={() => onRemove(row.id)}>
          削除
        </button>
      </div>
      {zoomed && row.thumbnailUrl && (
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
          <img src={row.thumbnailUrl} alt="" className="thumb-overlay-img" />
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
