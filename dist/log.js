const MAX_ENTRIES = 120;
export function createEventLog(logger = console) {
    const entries = [];
    let sequence = 0;
    return Object.freeze({
        record(level, message, details) {
            const entry = {
                id: ++sequence,
                at: new Date().toISOString(),
                level,
                message: String(message ?? ''),
                ...(details === undefined ? {} : { details }),
            };
            entries.push(entry);
            while (entries.length > MAX_ENTRIES)
                entries.shift();
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
