import { useEffect, useRef, useState } from "react";
import type { PhotoDiagnostics } from "../ocr/queue";

type Props = {
  /** 呼び出し時点の最新診断データを返す(App.tsx側のref経由。再レンダーに頼らず
   *  クリック時点の最新値を取れるよう、値そのものではなく取得関数を渡す)。 */
  getDiagnostics: () => PhotoDiagnostics | null;
  className?: string;
  label?: string;
};

/**
 * task-22: 実機診断データ(直近の写真ジョブ1件分。画像データ・OCR認識テキストは
 * 含まない、`src/ocr/queue.ts`の`PhotoDiagnostics`参照)をJSON文字列としてクリップボード
 * へコピーするボタン。
 *
 * コピー成功フィードバックは`SummaryPanel`の「結果をコピー」ボタン(`copy`関数)と同じ
 * パターン(2秒間だけラベルを「コピーしました」へ差し替え、`is-copied`クラスで
 * パルスアニメーション)を踏襲する。回復パネル・集計パネル隅の両方の導線から同じ実装を
 * 再利用できるよう、独立したボタンコンポーネントとして切り出す(`copied`状態は
 * インスタンスごとに独立するため、複数箇所に同時表示されても互いに干渉しない)。
 */
export function DiagnosticsCopyButton({ getDiagnostics, className, label = "診断データをコピー" }: Props) {
  const [copied, setCopied] = useState(false);
  // 連打・アンマウント時にタイマーを取り違えない/放置しないための管理(Codexレビュー
  // 指摘: setTimeoutを都度素で呼ぶと、2秒以内の連打で先発のタイマーが後発の
  // 「コピーしました」表示を早期に打ち消してしまい、アンマウント後もタイマーが
  // 残り続ける)。
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = async () => {
    const diagnostics = getDiagnostics();
    if (!diagnostics) {
      window.alert("診断データがありません(写真を読み込むと取得できます)");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setCopied(true);
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      window.alert("コピーできませんでした");
    }
  };

  const classes = [className, copied ? "is-copied" : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <button type="button" className={classes} onClick={copy}>
      {copied ? "コピーしました" : label}
    </button>
  );
}
