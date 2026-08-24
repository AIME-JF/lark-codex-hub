import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const secretPattern = /secret|token|authorization|password|app[_-]?id/i;

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(cli_[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED_APP_ID]");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretPattern.test(key) ? "[REDACTED]" : redact(item)
      ])
    );
  }
  return typeof value === "string" ? redactString(value) : value;
}

export interface LoggerOptions {
  console?: boolean;
  maxBytes?: number;
  retentionFiles?: number;
}

export function createLogger(
  level: LogLevel,
  logFile?: string,
  options: LoggerOptions = {}
): Logger {
  const writeConsole = options.console ?? true;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const retentionFiles = options.retentionFiles ?? 5;
  let currentSize = 0;
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    currentSize = existsSync(logFile) ? statSync(logFile).size : 0;
  }

  const rotate = (): void => {
    if (!logFile || !existsSync(logFile)) {
      currentSize = 0;
      return;
    }
    const oldest = `${logFile}.${retentionFiles}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let index = retentionFiles - 1; index >= 1; index -= 1) {
      const source = `${logFile}.${index}`;
      if (existsSync(source)) {
        renameSync(source, `${logFile}.${index + 1}`);
      }
    }
    renameSync(logFile, `${logFile}.1`);
    currentSize = 0;
  };

  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (levelRank[entryLevel] < levelRank[level]) {
      return;
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      message: redactString(message),
      ...(fields ? { fields: redact(fields) } : {})
    });
    if (writeConsole) {
      if (entryLevel === "error") {
        process.stderr.write(`${line}\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
    }
    if (logFile) {
      const output = `${line}\n`;
      const bytes = Buffer.byteLength(output);
      if (currentSize + bytes > maxBytes) {
        rotate();
      }
      appendFileSync(logFile, output, "utf8");
      currentSize += bytes;
    }
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
