import fs from "fs";
import path from "path";

const pairs = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "NZDUSD", "EURJPY", "GBPJPY", "USDCAD"];

const signalsDir = path.resolve("data", "signals");
const candlesDir = path.resolve("data", "candles");
const resultsDir = path.resolve("results");

if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
}

function isProfitableTrade(signal, candle) {
    // Check if TP was hit before SL
    if (!signal || !candle) return false;
    if (!signal.entry || !signal.tp || !signal.sl) return false;

    // For buy signals, profitable if low <= sl < tp <= high
    // For sell signals, profitable if high >= sl > tp >= low
    const { signal: sigType, entry, tp, sl } = signal;
    const { high, low } = candle;

    if (sigType === "buy") {
        // TP hit before SL if low > sl and high >= tp
        return low > sl && high >= tp;
    } else if (sigType === "sell") {
        // TP hit before SL if high < sl and low <= tp
        return high < sl && low <= tp;
    }
    return false;
}

function parseJSONLFile(filePath) {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
}

function writeJSONLFile(filePath, data) {
    const lines = data.map((obj) => JSON.stringify(obj));
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function processPair(pair) {
    const signalsPath = path.join(signalsDir, `${pair}.jsonl`);
    const candlesPath = path.join(candlesDir, `${pair}.jsonl`);

    if (!fs.existsSync(signalsPath) || !fs.existsSync(candlesPath)) {
        console.warn(`Missing data files for ${pair}, skipping.`);
        return;
    }

    const signals = parseJSONLFile(signalsPath);
    const candles = parseJSONLFile(candlesPath);

    // Assume signals and candles arrays are aligned by index/time
    const profitableTrades = [];

    for (let i = 0; i < signals.length; i++) {
        const signalObj = signals[i];
        const candleObj = candles[i];
        const signal = generateSignal(pair, signalObj);
        if (!signal) continue;

        // Enhance signal with TP and SL for checking profitability
        // Assuming TP and SL are defined relative to entry price (e.g., 10 pips)
        // Since original signals.js doesn't define TP/SL, define simple TP/SL here
        // For example, TP = entry + 0.0010 for buy, SL = entry - 0.0010 for buy
        // For sell, TP = entry - 0.0010, SL = entry + 0.0010
        const tpSlDistance = 0.001;
        if (signal.signal === "buy") {
            signal.tp = signal.entry + tpSlDistance;
            signal.sl = signal.entry - tpSlDistance;
        } else if (signal.signal === "sell") {
            signal.tp = signal.entry - tpSlDistance;
            signal.sl = signal.entry + tpSlDistance;
        }

        if (isProfitableTrade(signal, candleObj)) {
            profitableTrades.push({
                timestamp: signalObj.timestamp || null,
                pair,
                signal,
                candle: candleObj,
            });
        }
    }

    const outputPath = path.join(resultsDir, `${pair}_profitable.jsonl`);
    writeJSONLFile(outputPath, profitableTrades);
    console.log(`Processed ${pair}: ${profitableTrades.length} profitable trades saved.`);
}

function main() {
    for (const pair of pairs) {
        processPair(pair);
    }
}

main();
