/** Minimal RFC 4180 CSV writer — enough for the export endpoints. */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export interface Column<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: Array<Column<T>>): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  }
  // Excel opens UTF-8 correctly only when a BOM is present.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFilename(base: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-${stamp}.csv`;
}
