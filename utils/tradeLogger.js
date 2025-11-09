import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

// helper function to get the current trades log path (monthly rotated)
export function getCurrentTradesLogPath() {
    ensureLogDir();
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    return path.join(LOG_DIR, `trades_${month}.log`);
}

export function recordTradeOpen(entry) {
    if (!entry?.id) {
        throw new Error("recordTradeOpen requires an entry with an id");
    }
    const logPath = getCurrentTradesLogPath();
    const payload = {
        version: 1,
        ...entry,
    };
    fs.appendFileSync(logPath, JSON.stringify(payload) + "\n");
}

export function recordTradeClose(dealId, closePayload = {}) {
    if (!dealId) {
        throw new Error("recordTradeClose requires a dealId");
    }

    const formattedClose = {
        ...closePayload,
        time: closePayload.time || new Date().toISOString(),
    };

    const logPath = getCurrentTradesLogPath();
    const existingContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    const lines = existingContent
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.id === dealId) {
                entry.close = formattedClose;
                lines[i] = JSON.stringify(entry);
                updated = true;
                break;
            }
        } catch {
            continue;
        }
    }

    if (!updated) {
        lines.push(
            JSON.stringify({
                version: 1,
                id: dealId,
                entry: null,
                close: formattedClose,
            })
        );
    }

    fs.writeFileSync(logPath, lines.join("\n") + "\n");
}
