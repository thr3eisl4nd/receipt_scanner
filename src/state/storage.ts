import type { LegacyPayer, PersistedState, PersistedStateV1, Person } from "../types";

export const STORAGE_KEY = "receipt-scanner:state:v1";

const LEGACY_PAYERS = new Set(["husband", "wife"]);
const STATUSES = new Set(["auto-high", "needs-review", "confirmed", "manual", "failed"]);
const SOURCES = new Set(["ocr", "manual"]);

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_TIME_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * v1(夫/妻固定)スキーマの検証。移行元としてのみ使う(新規に書き出すことはない)。
 *
 * 行IDは非空文字列であることのみ検証し、v2と異なり一意性は検証しない
 * (Codexレビュー指摘Minor#3)。旧アプリの不具合等で行IDが重複していた場合、
 * ここで一意性まで強制して丸ごと`null`にすると進行中の月のデータを全部失う。
 * 重複は`migrateV1ToV2`側で新UUIDへ再採番して修復し、データを1件も捨てない。
 */
function isValidV1(v: unknown): v is PersistedStateV1 {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (!isMonth(s.month) || !isIsoDateTime(s.updatedAt)) return false;
  if (!Array.isArray(s.rows)) return false;
  return s.rows.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      row.id !== "" &&
      LEGACY_PAYERS.has(row.payer as string) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

/** v2スキーマの検証(設計ドキュメント§14.2): peopleが1人以上・IDが重複しない・
 *  名前が非空文字列であること、rows.payerIdが必ずpeopleに存在すること、行IDが非空かつ
 *  一意であること(Codexレビュー指摘Minor#3: 重複IDがあると`updateRow`が複数行を同時
 *  更新し`removeRow`が複数行を一括削除してしまうため)。v2はアプリ自身が書き出す形式なので、
 *  v1のような「捨てずに修復」ではなく厳格に拒否する。 */
function isValidV2(v: unknown): v is PersistedState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== 2) return false;
  if (!isMonth(s.month) || !isIsoDateTime(s.updatedAt)) return false;
  if (!Array.isArray(s.people) || s.people.length === 0) return false;

  const peopleIds = new Set<string>();
  for (const p of s.people) {
    if (typeof p !== "object" || p === null) return false;
    const person = p as Record<string, unknown>;
    if (typeof person.id !== "string" || person.id === "" || peopleIds.has(person.id)) return false;
    if (typeof person.name !== "string" || person.name === "") return false;
    if (!Number.isSafeInteger(person.colorIndex) || (person.colorIndex as number) < 0) return false;
    peopleIds.add(person.id);
  }

  if (!Array.isArray(s.rows)) return false;
  const rowIds = new Set<string>();
  return s.rows.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id === "" || rowIds.has(row.id)) return false;
    rowIds.add(row.id);
    return (
      typeof row.payerId === "string" &&
      peopleIds.has(row.payerId) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

const LEGACY_PERSON_NAME: Record<LegacyPayer, string> = { husband: "夫", wife: "妻" };
/** legacy payer値の生成順(「夫」→「妻」の順でcolorIndexを振る)。 */
const LEGACY_PAYER_ORDER: LegacyPayer[] = ["husband", "wife"];

/**
 * v1データの自動移行(設計ドキュメント§14.2、2026-07-29改訂: v1利用者は夫婦2人運用
 * だったため、行の有無に関わらず「夫」「妻」の両方を常に生成する)。
 *
 * 旧実装は実際にrowsへ登場したpayer値のみ人として生成していた(例: husband行しか
 * 無ければ「夫」だけを生成)。しかしv1(夫/妻固定)は常に夫婦2人での運用を前提とした
 * スキーマであり、「妻の行がまだ無いだけ」(=これから追加される)なのか「妻という
 * 人がそもそも存在しない」のかをv1データ単体からは区別できない。片方しか生成しないと、
 * 移行直後に妻の取り込みボタンが無い状態になり、ユーザーは「+ 人を追加」で自分で
 * 妻を作り直す羽目になる(移行の意図に反する)。v1データが存在する(=移行対象として
 * 呼ばれる)時点で夫婦2人運用だったとみなし、行の有無に関わらず常に両方を生成する。
 * 行データ自体は一切失わない(進行中の月のデータを消さない)。
 */
export function migrateV1ToV2(v1: PersistedStateV1): PersistedState {
  const idByPayer = new Map<LegacyPayer, string>();
  const people: Person[] = LEGACY_PAYER_ORDER.map((payer, index) => {
    const id = crypto.randomUUID();
    idByPayer.set(payer, id);
    return { id, name: LEGACY_PERSON_NAME[payer], colorIndex: index };
  });

  // 行IDの重複をUUID再採番で修復する(Codexレビュー指摘Minor#3)。isValidV1は行IDの
  // 一意性までは検証しない(重複していても移行対象として受理する)ため、ここで
  // 初出のIDはそのまま残し、2回目以降に同じIDが出てきた行だけ新しいUUIDへ差し替える。
  // 丸ごと拒否するのではなく最小限の修復に留めることで、行データを1件も捨てない。
  const seenRowIds = new Set<string>();
  return {
    version: 2,
    month: v1.month,
    updatedAt: v1.updatedAt,
    people,
    rows: v1.rows.map(({ id, payer, amountYen, label, status, source }) => {
      const dedupedId = seenRowIds.has(id) ? crypto.randomUUID() : id;
      seenRowIds.add(dedupedId);
      return {
        id: dedupedId,
        payerId: idByPayer.get(payer)!, // 構築上、payerは必ずidByPayerに存在する
        amountYen,
        label,
        status,
        source,
      };
    }),
  };
}

type PersistedRow = PersistedState["rows"][number];

/** 保存対象を列挙フィールドのみへ明示的に射影する。candidates/thumbnailUrl/processing等を混入させない。 */
function toPersistedState(state: PersistedState): PersistedState {
  return {
    version: state.version,
    month: state.month,
    updatedAt: state.updatedAt,
    people: state.people.map(({ id, name, colorIndex }): Person => ({ id, name, colorIndex })),
    rows: state.rows.map(
      ({ id, payerId, amountYen, label, status, source }): PersistedRow => ({
        id,
        payerId,
        amountYen,
        label,
        status,
        source,
      })
    ),
  };
}

/** 保存。射影後のデータがロード不能(スキーマ不一致)、または容量超過等の例外時はfalseを返す — 呼び出し側でUI表示すること。 */
export function saveState(state: PersistedState): boolean {
  try {
    const persisted = toPersistedState(state);
    if (!isValidV2(persisted)) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    return true;
  } catch {
    return false;
  }
}

/** 読み込み。v2として妥当ならそのまま、v1として妥当なら自動移行してから返す(§14.2)。
 *  どちらの形式としても妥当でなければnull。 */
export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isValidV2(parsed)) return parsed;
    if (isValidV1(parsed)) return migrateV1ToV2(parsed);
    return null;
  } catch {
    return null;
  }
}

/** 削除。端末のプライベートブラウジング等でlocalStorageアクセス自体が例外を投げる場合はfalseを返す
 *  (Codexレビュー指摘: saveState/loadStateと同様に呼び出し側で失敗を検知できる必要がある)。 */
export function clearState(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
