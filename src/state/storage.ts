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

/** v1(夫/妻固定)スキーマの検証。移行元としてのみ使う(新規に書き出すことはない)。 */
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
      LEGACY_PAYERS.has(row.payer as string) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

/** v2スキーマの検証(設計ドキュメント§14.2): peopleが1人以上・IDが重複しない・
 *  名前が非空文字列であること、rows.payerIdが必ずpeopleに存在すること。他の検証水準はv1と同等。 */
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
  return s.rows.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
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
/** legacy payer値の登場順を固定するための優先順位(「夫」→「妻」の順でcolorIndexを振る)。 */
const LEGACY_PAYER_ORDER: LegacyPayer[] = ["husband", "wife"];

/**
 * v1データの自動移行(設計ドキュメント§14.2)。`payer:"husband"`が登場すれば人「夫」、
 * `payer:"wife"`が登場すれば人「妻」を生成してpayerIdへ変換する。実際に登場したpayer値
 * のみ人として生成する(使っていない側の人が不要に増えないようにする)。行が1件もない
 * (=どちらのpayer値も登場しない)場合でもpeopleは1人以上が必須(§14.2)のため、
 * 既定で「夫」を1人だけ生成する。行データ自体は一切失わない(進行中の月のデータを消さない)。
 */
export function migrateV1ToV2(v1: PersistedStateV1): PersistedState {
  const usedPayers = new Set<LegacyPayer>(v1.rows.map((r) => r.payer));
  if (usedPayers.size === 0) usedPayers.add("husband");
  const order = LEGACY_PAYER_ORDER.filter((payer) => usedPayers.has(payer));

  const idByPayer = new Map<LegacyPayer, string>();
  const people: Person[] = order.map((payer, index) => {
    const id = crypto.randomUUID();
    idByPayer.set(payer, id);
    return { id, name: LEGACY_PERSON_NAME[payer], colorIndex: index };
  });

  return {
    version: 2,
    month: v1.month,
    updatedAt: v1.updatedAt,
    people,
    rows: v1.rows.map(({ id, payer, amountYen, label, status, source }) => ({
      id,
      payerId: idByPayer.get(payer)!, // 構築上、payerは必ずidByPayerに存在する
      amountYen,
      label,
      status,
      source,
    })),
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
