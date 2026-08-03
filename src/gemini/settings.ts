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

  return { apiKey, enabled };
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

/** キー設定済み(空白のみは未設定扱い)かつトグル有効時のみtrue。App.tsxはこれで
 *  「写真投入時にGeminiへ送るか、内蔵OCRのままにするか」を判定する。 */
export function isGeminiActive(settings: GeminiSettings): boolean {
  return settings.enabled && settings.apiKey.trim() !== "";
}
