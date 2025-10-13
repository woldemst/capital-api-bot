// runStrategy.js
import fs from "fs";
import readline from "readline";
import { generateSignal } from "./strategy.js";

function calculateSLTP(signal, atr) {
    if (!signal) return null;
    const entry = signal.entry;
    const direction = signal.signal;
    const sl = direction === "buy" ? entry - atr * 1.5 : entry + atr * 1.5;
    const tp = direction === "buy" ? entry + atr * 3 : entry - atr * 3;
    return { ...signal, SL: sl, TP: tp };
}

async function processPair(pair) {
    const inputPath = `./analysis/${pair}_combined.jsonl`;
    const outputDir = "./results";
    const outputPath = `${outputDir}/${pair}_profitable_trades.jsonl`;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const fileStream = fs.createReadStream(inputPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const outputFile = fs.createWriteStream(outputPath);

    console.log(`🔍 Processing ${pair}...`);

    for await (const line of rl) {
        const dataPoint = JSON.parse(line);
        const signal = generateSignal(pair, dataPoint);
        if (signal) {
            const trade = calculateSLTP(signal, dataPoint.M1.atr);
            if (trade) {
                // Backtester logic integrated here to keep only profitable trades
                const direction = trade.signal;
                const entry = trade.entry;
                const SL = trade.SL;
                const TP = trade.TP;
                const closePrice = dataPoint.M1.close;

                let isProfitable = false;
                if (direction === "buy") {
                    // Trade is profitable if price hits TP before SL
                    if (closePrice >= TP) isProfitable = true;
                    else if (closePrice <= SL) isProfitable = false;
                } else if (direction === "sell") {
                    // Trade is profitable if price hits TP before SL
                    if (closePrice <= TP) isProfitable = true;
                    else if (closePrice >= SL) isProfitable = false;
                }

                if (isProfitable) {
                    outputFile.write(
                        JSON.stringify({
                            pair,
                            time: dataPoint.M1?.timestamp || dataPoint.time,
                            ...trade,
                            indicators: {
                                rsi: dataPoint.M1?.rsi,
                                adx: dataPoint.M1?.adx?.adx,
                                emaFast: dataPoint.M1?.emaFast,
                                emaSlow: dataPoint.M1?.emaSlow,
                                trendH1: dataPoint.H1?.trend,
                                trendH4: dataPoint.H4?.trend,
                            },
                        }) + "\n"
                    );
                }
            }
        }
    }

    outputFile.end();
    console.log(`✅ Profitable trades for ${pair} saved to ${outputPath}`);
}

const pairs = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "NZDUSD", "EURJPY", "GBPJPY", "USDCAD"];

for (const pair of pairs) {
    processPair(pair);
}
