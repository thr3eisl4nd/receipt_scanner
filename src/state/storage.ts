import type { PersistedState, Row } from "../types";

export const STORAGE_KEY = "receipt-scanner:state:v1";

const PAYERS = new Set(["husband", "wife"]);
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

function isValid(v: unknown): v is PersistedState {
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
      PAYERS.has(row.payer as string) &&
      (row.amountYen === null || Number.isSafeInteger(row.amountYen)) &&
      typeof row.label === "string" &&
      STATUSES.has(row.status as string) &&
      SOURCES.has(row.source as string)
    );
  });
}

type PersistedRow = Pick<Row, "id" | "payer" | "amountYen" | "label" | "status" | "source">;

/** 保存対象を列挙フィールドのみへ明示的に射影する。candidates/thumbnailUrl/processing等を混入させない。 */
function toPersistedState(state: PersistedState): PersistedState {
  return {
    version: state.version,
    month: state.month,
    updatedAt: state.updatedAt,
    rows: state.rows.map(
      ({ id, payer, amountYen, label, status, source }): PersistedRow => ({
        id,
        payer,
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
    if (!isValid(persisted)) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    return true;
  } catch {
    return false;
  }
}

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
