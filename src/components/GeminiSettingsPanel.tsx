import { useId, useState } from "react";
import type { GeminiSettings } from "../gemini/settings";

type Props = {
  settings: GeminiSettings;
  onApiKeyChange(apiKey: string): void;
  onEnabledChange(enabled: boolean): void;
  /** task-27セキュリティレビュー指摘(Medium): 保存済みAPIキーを即座に削除する(無効化トグルは
   *  キー自体を消さないため、平文キーの保持期間を能動的に短くする専用の導線)。 */
  onForgetKey(): void;
};

const AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

/**
 * 「AI読み取り(Gemini)」設定パネル(task-26、設計ドキュメント§19、オプトイン)。
 *
 * v1.4デザイン(quiet luxury)に調和させ、控えめな歯車ボタン(既定は折りたたみ)の
 * 奥に置く。取り込みボタン群のような主要導線とは異なり、明示的に開かないと
 * 目に入らない位置づけにする(オプトイン機能の重みに合わせた情報設計)。
 *
 * 表示する要素(オーケストレーター指示どおり):
 * - APIキー入力(既定でマスク、表示切り替え可能)
 * - 有効/無効トグル(APIキー未設定の間はdisabled: 「キー無し・有効」という無意味な
 *   状態を作らせない)
 * - 「キーの発行方法」折りたたみガイド(AI Studioへのリンク)
 * - 「画像がGoogleに送信される」旨の明示(常時表示、折りたたまない — 安全に関わる
 *   情報を追加の操作なしに読めるようにする)
 *
 * APIキー・有効フラグの永続化はApp.tsx側の責務(`src/gemini/settings.ts`)。この
 * コンポーネントは常に親から渡された値を表示するcontrolledな入力のみを担う。
 */
export function GeminiSettingsPanel({ settings, onApiKeyChange, onEnabledChange, onForgetKey }: Props) {
  const [open, setOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const panelId = useId();

  const hasKey = settings.apiKey.trim() !== "";

  return (
    <section className="gemini-settings" aria-label="Gemini連携">
      <button
        type="button"
        className="gemini-settings-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() =>
          setOpen((v) => {
            const next = !v;
            // パネルを閉じる際はキー表示状態もリセットする(Codexレビュー指摘Important#3:
            // 表示状態のまま閉じると、再度開いた時にAPIキーが平文表示されたままになる)。
            if (!next) setKeyVisible(false);
            return next;
          })
        }
      >
        {/* 歯車は装飾のみ(aria-hidden)。アクセシブルネームは常に「Gemini連携の設定」の
            テキストで構成する(WCAG 2.5.3 Label in Name、既存コンポーネント群と同じ方針)。 */}
        <span aria-hidden="true">⚙</span> Gemini連携の設定
      </button>
      {open && (
        <div id={panelId} className="gemini-settings-panel">
          <h2 className="gemini-settings-heading">AI読み取り(Gemini)</h2>
          {/* 安全に関わる明示(オーケストレーター指示+Codexレビュー指摘: 平文保存・
              無料枠のデータ利用ポリシーも合わせて開示する)。折りたたまず常時表示する。 */}
          <p className="gemini-settings-notice">
            有効にすると、取り込んだレシート写真がGoogleのGemini APIへ送信されます。画像は各自のGoogleアカウントのAPIキーを使って直接送信され、このアプリのサーバーは経由しません。APIキーはこの端末のブラウザに平文で保存されます(共有端末では注意してください)。同じサイト上の別ページ・別アプリからも技術的には読み取られ得るため、他のサービスと共用しない専用のAPIキーを使い、使わなくなったら下の「APIキーを削除」で消してください。無料枠を利用する場合、送信内容がGoogleの製品改善に利用されることがあります(有料プランでは利用されません。詳細はGoogleの利用規約を確認してください)。
          </p>
          <label className="gemini-settings-field">
            <span>Gemini APIキー</span>
            <span className="gemini-settings-key-row">
              <input
                type={keyVisible ? "text" : "password"}
                name="gemini-api-key"
                autoComplete="off"
                value={settings.apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                aria-label="Gemini APIキー"
                placeholder="AIza..."
              />
              <button type="button" onClick={() => setKeyVisible((v) => !v)}>
                {keyVisible ? "隠す" : "表示"}
              </button>
            </span>
          </label>
          {/* task-27セキュリティレビュー指摘(Medium): 平文保存されたAPIキーの保持期間を
              利用者が能動的に短くできる導線。無効化トグル(下)はキー自体を消さないため、
              「もう使わない」場合の明確な削除操作を別に用意する。 */}
          {hasKey && (
            <button type="button" className="gemini-settings-forget" onClick={onForgetKey}>
              APIキーを削除
            </button>
          )}
          {/* aria-labelで上書きせず、ネイティブの<label>包含関係(=見えるテキスト
              「AI読み取り(Gemini)を使う」そのもの)からアクセシブルネームを構成する
              (WCAG 2.5.3 Label in Name、既存コンポーネント群と同じ方針)。 */}
          <label className="gemini-settings-enabled">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={!hasKey}
              onChange={(e) => onEnabledChange(e.target.checked)}
            />
            AI読み取り(Gemini)を使う
          </label>
          {!hasKey && <p className="gemini-settings-hint">APIキーを入力すると有効にできます。</p>}
          <details className="gemini-settings-guide">
            <summary>キーの発行方法</summary>
            <p>
              <a href={AI_STUDIO_KEY_URL} target="_blank" rel="noreferrer">
                Google AI Studio({AI_STUDIO_KEY_URL})
              </a>
              にアクセスし、Googleアカウントでログインして「APIキーを作成」を選ぶと発行できます(APIキーの発行自体は無料。利用条件・料金は各自のGoogleアカウントのプランに従います)。発行したキーをそのまま上の欄に貼り付けてください。AI Studio側でこのキーに利用量の上限を設定しておくと、万一キーが漏れた場合の被害を抑えられます。
            </p>
          </details>
        </div>
      )}
    </section>
  );
}
