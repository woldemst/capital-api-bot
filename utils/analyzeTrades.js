// analyzeTrades.js
import fs from "fs";
import path from "path";

// === CONFIG ===
const LOG_DIR = "./logs";
const OUTPUT_DIR = "./data";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// === Utility: Load all JSON lines from current log file ===
function loadTradesLog(filePath) {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const jsons = [];
    for (const line of lines) {
        try {
            jsons.push(JSON.parse(line));
        } catch (e) {
            console.warn("⚠️ Skipping invalid JSON line:", line.slice(0, 80));
        }
    }
    return jsons;
}

// === Merge open + close trades by ID ===
function mergeTrades(entries) {
    const openTrades = {};
    const merged = [];

    for (const entry of entries) {
        // Open trades have indicatorsSnapshot, closed trades have resultType
        if (entry.indicatorsSnapshot) {
            openTrades[entry.id] = entry;
        } else if (entry.resultType) {
            const open = openTrades[entry.id];
            if (open) {
                merged.push({
                    id: entry.id,
                    symbol: open.symbol,
                    direction: open.direction,
                    entry: open.entry,
                    closePrice: entry.closePrice,
                    resultType: entry.resultType,
                    profitPips: entry.profitPips,
                    ...open.indicatorsSnapshot,
                });
                delete openTrades[entry.id];
            }
        }
    }
    return merged;
}

// === Convert to CSV (optional for Excel/AI) ===
function toCSV(data) {
    if (!data.length) return "";
    const headers = Object.keys(data[0]);
    const rows = data.map(obj => headers.map(h => JSON.stringify(obj[h] ?? "")).join(","));
    return [headers.join(","), ...rows].join("\n");
}

// === Main process ===
function main() {
    // Pick the newest log file automatically
    const logFiles = fs.readdirSync(LOG_DIR).filter(f => f.startsWith("trades_") && f.endsWith(".log"));
    if (logFiles.length === 0) return console.error("No trade logs found.");

    const latestLog = logFiles.sort().pop();
    const logPath = path.join(LOG_DIR, latestLog);
    console.log(`📘 Reading ${logPath}`);

    const entries = loadTradesLog(logPath);
    console.log(`✅ Loaded ${entries.length} entries`);

    const merged = mergeTrades(entries);
    console.log(`🔗 Merged into ${merged.length} completed trades`);

    // Save as JSON + CSV
    const jsonOut = path.join(OUTPUT_DIR, "trade_dataset.json");
    const csvOut = path.join(OUTPUT_DIR, "trade_dataset.csv");
    fs.writeFileSync(jsonOut, JSON.stringify(merged, null, 2));
    fs.writeFileSync(csvOut, toCSV(merged));
    console.log(`💾 Saved dataset:\n- ${jsonOut}\n- ${csvOut}`);
}

main();