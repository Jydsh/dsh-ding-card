const MAX_ENTRIES = 120;

/** 日志级别。 */
export type LogLevel = 'info' | 'warn' | 'error';

/** 事件日志条目。 */
export interface EventLogEntry {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
  details?: unknown;
}

/** 事件日志（环形缓冲）。 */
export interface EventLog {
  record(level: LogLevel, message: string, details?: unknown): EventLogEntry;
  list(limit?: number): EventLogEntry[];
  clear(): void;
}

export function createEventLog(logger: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void } = console): EventLog {
  const entries: EventLogEntry[] = [];
  let sequence = 0;
  return Object.freeze({
    record(level: LogLevel, message: string, details?: unknown) {
      const entry = {
        id: ++sequence,
        at: new Date().toISOString(),
        level,
        message: String(message ?? ''),
        ...(details === undefined ? {} : { details }),
      };
      entries.push(entry);
      while (entries.length > MAX_ENTRIES) entries.shift();
      const sink = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
      sink?.call(logger, `[dsh-ding-card] ${entry.message}`);
      return entry;
    },
    list(limit = 60) {
      const count = Math.min(MAX_ENTRIES, Math.max(1, Number(limit) || 60));
      return entries.slice(-count).reverse();
    },
    clear() {
      entries.length = 0;
    },
  });
}
