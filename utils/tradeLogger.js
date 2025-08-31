import fs from "fs";
import path from "path";

// helper function to get the current trades log path
export function getCurrentTradesLogPath() {
    const now = new Date();
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    return path.join(logDir, `trades_${month}.log`);
}


export function logTradeResult(dealId, closedPrice) {
    const logPath = getCurrentTradesLogPath();
    if (!fs.existsSync(logPath)) return;
    // Read all lines, update the one with this dealId
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            continue;
        }
        if (entry.id === dealId && !entry.result) {
            entry.result = {
                closedPrice,
                timestamp: new Date().toISOString(),
            };
            lines[i] = JSON.stringify(entry);
            updated = true;
            break;
        }
    }
    if (updated) fs.writeFileSync(logPath, lines.join("\n") + "\n");
}
