import fs from "fs";
import path from "path";

/**
 * Returns the path to the current monthly trades log file.
 * Does NOT delete previous logs.
 */
export function getCurrentTradesLogPath() {
    const now = new Date();
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    return path.join(logDir, `trades_${month}.log`);
}

/**
 * Logs a snapshot of all open trades.
 * Each entry: {id, symbol, price, direction, tp, sl, indicators: {...}}
 */
export async function logTradeSnapshot(latestIndicatorsBySymbol, getOpenPositions) {
    const logPath = getCurrentTradesLogPath();
    let positionsData;
    try {
        positionsData = await getOpenPositions();
    } catch (e) {
        console.error("[TradeLog] Could not fetch open positions:", e);
        return;
    }
    if (!positionsData?.positions) return;
    const now = new Date().toISOString();
    for (const p of positionsData.positions) {
        const symbol = p.market.epic;
        const direction = p.position.direction.toLowerCase();
        const dealId = p.position.dealId;
        const entry = p.position.openLevel;
        const price = direction === "buy" ? p.market.bid : p.market.offer;
        const tp = p.position.limitLevel;
        const sl = p.position.stopLevel;
        const indicators = latestIndicatorsBySymbol[symbol] || {};
        // Pick relevant indicators (customize as needed)
        const relevant = {
            emaFast: indicators.emaFast,
            emaSlow: indicators.emaSlow,
            ema9: indicators.ema9,
            ema21: indicators.ema21,
            rsi: indicators.rsi,

            bb: indicators.bb,
            atr: indicators.atr,
        };
        const logEntry = {
            time: now,
            id: dealId,
            symbol,
            price,
            direction,
            tp,
            sl,
            indicators: relevant,
            result: null,
        };
        fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
    }
}

/**
 * Appends the result to the trade log when a position is closed.
 * @param {string} dealId
 * @param {string} result - e.g. 'tp', 'sl', 'exit', plus profit/loss
 */
export function logTradeResult(dealId, result) {
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
            entry.result = result;
            lines[i] = JSON.stringify(entry);
            updated = true;
            break;
        }
    }
    if (updated) fs.writeFileSync(logPath, lines.join("\n") + "\n");
}
