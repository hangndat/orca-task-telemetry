/** Shared text/JSON helpers for usage reports (T35–T37). */

const CONTROL_OR_ANSI =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\u001B\[[0-9;]*[A-Za-z]/g;

/** Strip terminal controls and line breaks for human-readable report text (not JSON). */
export function sanitizeDisplayText(value: string): string {
  return value
    .replace(CONTROL_OR_ANSI, '')
    .replace(/[\n\r\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function shellSingleQuote(value: string): string {
  if (!/[^\w@%+=:,./-]/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) {
    return 'unknown';
  }
  return `$${amount.toFixed(2)}`;
}

export function padEndVisible(value: string, width: number): string {
  const visible = sanitizeDisplayText(value);
  if (visible.length >= width) {
    return visible;
  }
  return visible + ' '.repeat(width - visible.length);
}

export type TableColumn = {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
};

export function renderTable(
  columns: TableColumn[],
  rows: Record<string, string>[],
): string {
  const header = columns
    .map((c) => padEndVisible(c.header, c.width))
    .join('  ');
  const lines = [header, columns.map((c) => '-'.repeat(c.width)).join('  ')];
  for (const row of rows) {
    const cells = columns.map((c) => {
      const raw = row[c.key] ?? '';
      const text = sanitizeDisplayText(raw);
      if (c.align === 'right') {
        return text.padStart(c.width, ' ');
      }
      return padEndVisible(text, c.width);
    });
    lines.push(cells.join('  '));
  }
  return `${lines.join('\n')}\n`;
}

export type ReportCostField = {
  amountUsd: number | null;
  kind: 'estimated_api_equivalent' | 'unknown';
};

export type OrcaReferenceField =
  | { status: 'verified'; executionKey: string; dispatchId: string | null }
  | { status: 'unknown' };

export type CollectionFreshnessSlice = {
  source: 'github' | 'orca' | 'agent-top';
  status: 'success' | 'failed';
  recordedAt: string;
};
