import { version } from "../../package.json";

type LogLevel = "INFO" | "WARN" | "ERROR";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 200;
const buffer: LogEntry[] = [];

export function csLog(level: LogLevel, ...args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.message : String(a)))
    .join(" ");
  const timestamp = new Date().toISOString();

  if (buffer.length >= MAX_ENTRIES) buffer.shift();
  buffer.push({ timestamp, level, message });

  try {
    ztoolkit.log(`[${level}] ${message}`);
  } catch {
    // ztoolkit not yet ready — entry is still stored in buffer
  }
}

export function getFormattedLogs(): string {
  const now = new Date().toISOString();
  const zVersion = (() => {
    try {
      return (ztoolkit.getGlobal("Zotero") as any).version as string;
    } catch {
      return "unknown";
    }
  })();
  const platform = (() => {
    try {
      return (Services as any).appinfo.OS as string;
    } catch {
      return "unknown";
    }
  })();

  const header = [
    "The Cite Shop Client Sync - Log Export",
    `Version:        ${version}`,
    `Exported:       ${now}`,
    `Zotero Version: ${zVersion}`,
    `Platform:       ${platform}`,
    "============================================================",
  ].join("\n");

  const lines = buffer
    .map((e) => `[${e.timestamp}] [${e.level}] ${e.message}`)
    .join("\n");

  return `${header}\n${lines || "(no log entries yet)"}`;
}
