import { useLayoutEffect, useRef, useState } from "react";
import { buildSummaryText, computeTotals, formatDelta, type AppState } from "../state/reducer";
import { personColorClass } from "../personColor";

/** `.receipt-paper`側で本文末尾に予約する余白の基準にするCSSカスタムプロパティ名
 *  (Codexレビュー v1.2再指摘I2)。 */
const SUMMARY_PANEL_HEIGHT_VAR = "--summary-panel-height";

type Props = { state: AppState; onNewMonth(): void };

const yen = (n: number) => n.toLocaleString("ja-JP");

/**
 * 画面下部固定の集計パネル(設計ドキュメント§5.5/§6、v1.1で§14.3へ一般化)。
 *
 * 表示するのは人別合計と、ちょうど2人のときのみの差額(方向付き)まで。清算額の
 * 自動計算(差額÷2)は絶対に行わない — 清算ルールは折半ではなく、最終判断はユーザー
 * 自身が行う(§2 要件確定事項)。合計・サマリー文言生成はTask 6-7で実装・テスト済みの
 * `computeTotals`/`buildSummaryText`をそのまま使う。
 */
export function SummaryPanel({ state, onNewMonth }: Props) {
  const [copied, setCopied] = useState(false);
  const t = computeTotals(state.people, state.rows);
  const direction = formatDelta(t.totals, t.delta);
  const panelRef = useRef<HTMLElement>(null);

  // サマリーは「1人1行」で人数・名前の長さに応じて可変高になる(設計ドキュメント§15.4)。
  // 一方`.receipt-paper`側の本文末尾の予約領域は固定230pxだったため、5～8人や長い
  // 名前ではパネルが230pxを超え、最終行・手動追加フォームが隠れてスクロールしても
  // 表示できなくなっていた(Codexレビュー v1.2再指摘I2、§15.6「最終行を隠さない」への
  // 退行)。ResizeObserverで実高を継続的に計測し、`document.documentElement`上の
  // CSSカスタムプロパティへ反映することで、`.receipt-paper`側がその実測値を
  // `padding-bottom`に使えるようにする。
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // jsdom(Vitestのテスト環境)はResizeObserver未実装のため、存在しない場合は
    // 何もしない(CSS側のフォールバック値230pxがそのまま使われる)。
    if (typeof ResizeObserver === "undefined") return;

    const update = () => {
      document.documentElement.style.setProperty(
        SUMMARY_PANEL_HEIGHT_VAR,
        `${Math.ceil(panel.getBoundingClientRect().height)}px`,
      );
    };

    const observer = new ResizeObserver(update);
    observer.observe(panel);
    update();

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(SUMMARY_PANEL_HEIGHT_VAR);
    };
  }, []);

  const copy = async () => {
    if (t.unconfirmed > 0 && !window.confirm(`未確認が ${t.unconfirmed}件 あります。このままコピーしますか?`)) return;
    try {
      await navigator.clipboard.writeText(buildSummaryText(state));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.alert("コピーできませんでした");
    }
  };

  // 折りたたみ(設計ドキュメント§17.9): スマホ・タブレット(<1024px、画面下部固定)で
  // 「合計行だけのコンパクト表示⇄展開」を可能にするトグル。既存の動作(常時全内容表示)
  // との後方互換を優先し、初期状態は展開のまま(expanded:true)にする — 折りたたみは
  // 追加のユーザー操作であり、デフォルトの見え方は変えない。>=1024pxのstickyパネルでは
  // CSS側で`.summary-body`を常に表示させ、トグル自体も非表示にする(実装はCSSのみ、
  // JS側でbreakpointを分岐させない)。
  const [expanded, setExpanded] = useState(true);
  // 「合計行」に出す単一の金額(設計ドキュメント§17.9: 人数に関わらず必ず1つ定まる値として
  // 全員の合計を使う)。清算額(差額÷2)ではなく、単純な合計なので§2/§14.3の
  // 「折半ではない」方針とは無関係(表示専用の集計)。
  const grandTotal = t.totals.reduce((sum, p) => sum + p.amountYen, 0);

  return (
    <section ref={panelRef} className={`summary-panel${expanded ? " is-expanded" : ""}`} aria-label="集計">
      {/* 折りたたみトグル(スマホ・タブレットのみ、CSSで>=1024pxは非表示)。合計行だけの
          コンパクト表示を兼ねる(設計ドキュメント§17.9)。 */}
      <button
        type="button"
        className="summary-toggle"
        aria-expanded={expanded}
        aria-controls="summary-body"
        aria-label={expanded ? "集計を折りたたむ" : "集計を展開"}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="summary-toggle-label" aria-hidden="true">合計</span>
        <b key={grandTotal} className="summary-toggle-amount">{yen(grandTotal)}円</b>
        {t.unconfirmed > 0 && <span className="summary-toggle-flag" aria-hidden="true" />}
        <span className="summary-chevron" aria-hidden="true">{expanded ? "︿" : "﹀"}</span>
      </button>
      <div id="summary-body" className="summary-body" hidden={!expanded}>
        <div className="summary-body-inner">
          {/* 「合計」ラベルは折りたたみトグル側に既に出ているため、本文側で重複表示
              しない(設計ドキュメント§17.9)。 */}
          <div className="summary-totals">
            {t.totals.map((total) => (
              <div key={total.personId} className="summary-line">
                {/* 人別テーマカラーのドット+ソフトチップは装飾のみ(aria-hidden)。
                    色だけに頼らず名前テキストを併記する(既存a11y方針、設計ドキュメント§17.3)。 */}
                <span className={`summary-person ${personColorClass(total.colorIndex)}`}>
                  <span className="person-dot" aria-hidden="true" />
                  {total.name}
                </span>
                {/* 合計金額の更新時の極小フェード/シフト(設計ドキュメント§17.10)。
                    keyを金額値にすることでReactが要素を再マウントし、CSSのマウント
                    アニメーション(amount-update-in)が更新のたびに再生される。 */}
                <b key={total.amountYen} className="summary-amount">{yen(total.amountYen)}円</b>
              </div>
            ))}
          </div>
          {/* ちょうど2人のときのみ差額行を表示する(1人・3人以上では非表示、設計ドキュメント§14.3)。 */}
          {direction !== null && <div className="delta">{direction}</div>}
          {/* role="status"は付けない: App側のOCR進捗表示(role="status")と同一ロールで
              同時に存在しうると、アクセシブルネーム無しの複数status領域になり
              スクリーンリーダー・テスト双方から曖昧になる(Codexレビュー指摘)。この警告は
              ライブ更新の通知ではなく状態表示なので、通常のテキストで十分。 */}
          {t.unconfirmed > 0 && <div className="warn">⚠ 未確認 {t.unconfirmed}件</div>}
          <div className="panel-actions">
            <button type="button" className={copied ? "is-copied" : undefined} onClick={copy}>
              {copied ? "コピーしました" : "結果をコピー"}
            </button>
            <button type="button" onClick={onNewMonth}>
              新しい月を始める
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
