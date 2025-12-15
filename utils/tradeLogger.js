import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function sanitizeSymbol(symbol = "unknown") {
    return String(symbol || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function listLogFiles() {
    if (!fs.existsSync(LOG_DIR)) return [];
    return fs
        .readdirSync(LOG_DIR)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => path.join(LOG_DIR, file));
}

export function getSymbolLogPath(symbol = "unknown") {
    ensureLogDir();
    return path.join(LOG_DIR, `${sanitizeSymbol(symbol)}.jsonl`);
}

function appendLine(logPath, payload) {
    ensureLogDir();
    fs.appendFileSync(logPath, JSON.stringify(payload) + "\n");
}

function updateEntry(logPath, dealId, updater) {
    if (!fs.existsSync(logPath)) return false;
    const targetId = String(dealId);
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim()) continue;

        let entry;
        try {
            entry = JSON.parse(raw);
        } catch {
            continue;
        }

        if (String(entry.dealId) === targetId) {
            const next = updater(entry);
            lines[i] = JSON.stringify(next);
            updated = true;
            break;
        }
    }

    if (updated) {
        fs.writeFileSync(logPath, lines.filter(Boolean).join("\n") + "\n");
    }

    return updated;
}

export function logTradeOpen({
    symbol,
    dealId,
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    indicators,
    timestamp = new Date().toISOString(),
}) {
    const logPath = getSymbolLogPath(symbol);
    const payload = {
        dealId,
        symbol,
        side,
        timestamp,
        openedAt: timestamp,
        entryPrice,
        stopLoss,
        takeProfit,
        indicators,
        status: "open",
    };

    appendLine(logPath, payload);
}

export function logTradeClose({
    symbol,
    dealId,
    closeReason,
    indicators,
    closePrice,
    timestamp = new Date().toISOString(),
}) {
    const reason = closeReason || "closed";
    const closedAt = timestamp;
    const primaryPath = symbol ? getSymbolLogPath(symbol) : null;
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (entry) => {
            const openedTimestamp = entry.timestamp ?? entry.openedAt ?? null;

            return {
                ...entry,
                timestamp: openedTimestamp || closedAt,
                status: "closed",
                closeReason: reason,
                closedAt,
                closePrice: typeof closePrice !== "undefined" ? closePrice : entry.closePrice,
                indicatorsClose: indicators ?? entry.indicatorsClose ?? null,
            };
        });

        if (updated) return true;
    }

    // If we could not find the original entry, append a new record as a fallback.
    const fallbackPath = primaryPath || getSymbolLogPath("unknown");
    appendLine(fallbackPath, {
        dealId,
        symbol: symbol || "unknown",
        timestamp: closedAt,
        status: "closed",
        closeReason: reason,
        closedAt,
        closePrice,
        indicatorsClose: indicators ?? null,
        missingOpen: true,
    });

    return false;
}
