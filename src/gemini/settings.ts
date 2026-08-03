/**
 * 「Gemini連携モード」(task-26、設計ドキュメント§19)の設定(APIキー・有効/無効)。
 *
 * 既存の`PersistedState`(`src/state/storage.ts`、`receipt-scanner:state:v1`)とは
 * 完全に独立した別のlocalStorageキーへ保存する(オーケストレーター指示:
 * 「PersistedStateスキーマは変更禁止」)。APIキーは各自のGoogle AI Studioアカウントに
 * 紐づく秘匿情報であり、月次データ(rows/people)と同じ器へ混在させると、将来
 * `toPersisted`/`isValidV2`等の永続化ロジックを触るたびに誤って漏洩・書き出し対象へ
 * 巻き込むリスクがあるため、意図的に名前空間を分けている。
 */

export const API_KEY_STORAGE_KEY = "receipt-scanner:gemini:apiKey";
export const ENABLED_STORAGE_KEY = "receipt-scanner:gemini:enabled";

export type GeminiSettings = { apiKey: string; enabled: boolean };

/** 読み込み。localStorageアクセス自体が例外を投げる場合(プライベートブラウジング等、
 *  `src/state/storage.ts`と同じ考慮)は未設定として扱う。 */
export function loadGeminiSettings(): GeminiSettings {
  let apiKey = "";
  try {
    apiKey = localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    apiKey = "";
  }

  let enabled = false;
  try {
    enabled = localStorage.getItem(ENABLED_STORAGE_KEY) === "1";
  } catch {
    enabled = false;
  }

  // 不変条件の防御(Codexレビュー指摘Important#3): APIキーが空(未設定)のまま
  // enabled:trueが保存されている状態を作らせない。呼び出し側(App.tsx)は
  // APIキー変更時に空になったら`enabled`もfalseへ戻すが、直接localStorageを
  // 編集された場合や過去バージョンの保存データとの互換のため、読み込み側でも
  // 同じ不変条件を強制する。
  return { apiKey, enabled: apiKey.trim() !== "" && enabled };
}

/** APIキーの保存。空文字は「未設定に戻す」として扱い、キー自体を削除する
 *  (localStorageに空文字のまま残すと`getItem`が`""`を返しnullと区別できないため、
 *  「未設定」の判定を`isGeminiActive`側の空文字チェックだけに頼らず一貫させる)。 */
export function saveGeminiApiKey(apiKey: string): boolean {
  try {
    if (apiKey === "") localStorage.removeItem(API_KEY_STORAGE_KEY);
    else localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    return true;
  } catch {
    return false;
  }
}

export function saveGeminiEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

/** task-27セキュリティレビュー指摘(Medium): `localStorage`はオリジン単位(パス単位ではない)
 *  のため、同じGitHub Pagesアカウント配下の別プロジェクト(同一オリジン)からもこのAPIキーを
 *  読み取られ得る。バックエンドを持たない静的SPAである以上この構造上の制約自体は解消できない
 *  ため、キーの保持期間を利用者が能動的に短くできる「削除」導線を設ける。`saveGeminiApiKey("")`
 *  (キー削除)と`saveGeminiEnabled(false)`(無効化)を一括で行う。両呼び出しのどちらかが
 *  失敗しても(プライベートブラウジング等)、もう一方は独立して試行する。 */
export function forgetGeminiSettings(): boolean {
  const keyRemoved = saveGeminiApiKey("");
  const disabled = saveGeminiEnabled(false);
  return keyRemoved && disabled;
}

/** キー設定済み(空白のみは未設定扱い)かつトグル有効時のみtrue。App.tsxはこれで
 *  「写真投入時にGeminiへ送るか、内蔵OCRのままにするか」を判定する。 */
export function isGeminiActive(settings: GeminiSettings): boolean {
  return settings.enabled && settings.apiKey.trim() !== "";
}
