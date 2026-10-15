import { appendFileSync } from "node:fs";

const DEFAULT_DIAG_FILE = "/tmp/opencode/brain-capture-diag.log";

let diagFile: string | undefined = DEFAULT_DIAG_FILE;

/** Point diagnostics at a custom file (plugin option `diag`). */
export function enableDiag(file: string): void {
  diagFile = file;
}

/** Append-only plugin lifecycle log. Diagnostics must never break capture. */
export function diag(event: string, data?: unknown): void {
  if (!diagFile) return;
  try {
    const line = `${new Date().toISOString()} pid=${process.pid} ${event}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`;
    appendFileSync(diagFile, line);
  } catch {
    // ignore: diagnostics are best-effort
  }
}
