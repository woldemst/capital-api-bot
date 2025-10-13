// backtest/backtestProfitable.js
import fs from "fs";

function backtestProfitable(pair) {
    const signalsPath = `./backtest/results/${pair}_signals.jsonl`;
    const candlesPath = `./backtest/data/${pair}/${pair}_M1.json`;
    const outputDir = "./backtest/analysis";
    const outputPath = `${outputDir}/${pair}_profitable.jsonl`;

    if (!fs.existsSync(signalsPath)) {
        console.error(`❌ No signals file found for ${pair}`);
        return;
    }
    if (!fs.existsSync(candlesPath)) {
        console.error(`❌ No candle data found for ${pair}`);
        return;
    }
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const signals = fs
        .readFileSync(signalsPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    const candles = JSON.parse(fs.readFileSync(candlesPath, "utf-8"));

    const profitable = [];

    console.log(`💹 Backtesting ${pair} (${signals.length} trades)...`);

    for (const signal of signals) {
        const entryTime = new Date(signal.time).getTime();
        const direction = signal.signal;
        const entry = signal.entry;
        const SL = signal.SL;
        const TP = signal.TP;

        // find entry index
        const startIdx = candles.findIndex((c) => new Date(c.timestamp).getTime() >= entryTime);
        if (startIdx === -1) continue;

        let hitTP = false;
        let hitSL = false;

        // simulate forward candle-by-candle
        for (let i = startIdx; i < candles.length; i++) {
            const c = candles[i];
            if (direction === "buy") {
                if (c.low <= SL) {
                    hitSL = true;
                    break;
                }
                if (c.high >= TP) {
                    hitTP = true;
                    break;
                }
            } else if (direction === "sell") {
                if (c.high >= SL) {
                    hitSL = true;
                    break;
                }
                if (c.low <= TP) {
                    hitTP = true;
                    break;
                }
            }
        }

        if (hitTP && !hitSL) {
            profitable.push(signal);
        }
    }

    fs.writeFileSync(outputPath, profitable.map((t) => JSON.stringify(t)).join("\n"));

    console.log(`✅ ${pair}: ${profitable.length}/${signals.length} profitable trades saved to ${outputPath}`);
}

const pairs = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "NZDUSD", "EURJPY", "GBPJPY", "USDCAD"];

for (const pair of pairs) {
    backtestProfitable(pair);
}
