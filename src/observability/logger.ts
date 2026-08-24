import { appendFileSync, mkdirSync } from "node:fs";
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

const secretPattern = /secret|token|authorization|password|app_id/i;

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
  return value;
}

export function createLogger(level: LogLevel, logFile?: string): Logger {
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
  }

  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (levelRank[entryLevel] < levelRank[level]) {
      return;
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(fields ? { fields: redact(fields) } : {})
    });
    if (entryLevel === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
    if (logFile) {
      appendFileSync(logFile, `${line}\n`, "utf8");
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
