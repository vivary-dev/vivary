/**
 * Issue #131. Where focus goes after a list row is removed together with the control that held focus: the row now at
 * the removed row's index, else the last row, else the fallback.
 */
export function focusAfterRemoval<T>(rows: readonly T[], removedIndex: number, fallback: T | null): T | null {
  return rows[Math.min(removedIndex, rows.length - 1)] ?? fallback;
}
