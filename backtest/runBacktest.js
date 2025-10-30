import fs from "fs";
import readline from "readline";
import logger from "../utils/logger.js";
import Strategy from "../strategies/strategies.js";

const pair = "EURUSD"; // or dynamically detect from file name
const inputFile = `./analysis/${pair}_combined.jsonl`; // <-- remove space before ./
const outputFile = `./results/${pair}_backtest_results.jsonl`;

import tradingService from "../services/trading.js";

let m5CandleBuffer = [];
const M5_BUFFER_SIZE = 10; // or whatever your strategy expects

// --- Simulate trade result: check if SL or TP is hit first in future candles ---
function simulateTradeResult(m5Buffer, entryIdx, params, signal) {
    // m5Buffer: array of candles (each with open, high, low, close, timestamp)
    // entryIdx: index of entry candle in buffer
    // params: { price, stopLossPrice, takeProfitPrice }
    // signal: "BUY" or "SELL"
    // Returns: { outcome: "WIN"|"LOSS", hitTime }
    const { price, stopLossPrice, takeProfitPrice } = params;
    // Look ahead after entry candle
    for (let i = entryIdx + 1; i < m5Buffer.length; i++) {
        const candle = m5Buffer[i];
        if (!candle) continue;
        const high = candle.high;
        const low = candle.low;
        if (signal === "BUY") {
            // TP hit if high >= TP, SL hit if low <= SL
            if (low <= stopLossPrice && high >= takeProfitPrice) {
                // both hit in same candle: assume SL first (conservative)
                return { outcome: "LOSS", hitTime: candle.timestamp };
            }
            if (high >= takeProfitPrice) {
                return { outcome: "WIN", hitTime: candle.timestamp };
            }
            if (low <= stopLossPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp };
            }
        } else if (signal === "SELL") {
            // TP hit if low <= TP, SL hit if high >= SL
            if (high >= stopLossPrice && low <= takeProfitPrice) {
                // both hit: SL first
                return { outcome: "LOSS", hitTime: candle.timestamp };
            }
            if (low <= takeProfitPrice) {
                return { outcome: "WIN", hitTime: candle.timestamp };
            }
            if (high >= stopLossPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp };
            }
        }
    }
    // If neither hit in lookahead, treat as "open" or "LOSS" (conservative: loss)
    return { outcome: "LOSS", hitTime: null };
}

async function runBacktest() {
    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
    let total = 0;
    let signals = 0;
    let balance = 1000;
    tradingService.setAccountBalance(balance);
    const results = [];
    let allM5Candles = [];

    // --- Preload all candles for lookahead ---
    let allLines = [];
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const data = JSON.parse(line);
            allLines.push(data);
            if (data.M5) {
                allM5Candles.push(data.M5);
            }
        } catch (err) {
            console.error("Error parsing line:", err);
        }
    }

    // Now process with sliding buffer
    m5CandleBuffer = [];
    for (let idx = 0; idx < allLines.length; idx++) {
        const data = allLines[idx];
        // --- Build rolling buffer for m5Candles ---
        if (data.M5) {
            m5CandleBuffer.push(data.M5);
            if (m5CandleBuffer.length > M5_BUFFER_SIZE) {
                m5CandleBuffer.shift();
            }
        }

        const indicators = {
            m1: data.M1,
            m5: data.M5,
            m15: data.M15,
            h1: data.H1,
            h4: data.H4,
        };

        const candles = {
            m5Candles: m5CandleBuffer.slice(),
            m15Candles: [data.M15].filter(Boolean),
            h1Candles: [data.H1].filter(Boolean),
            m1Candles: [data.M1].filter(Boolean),
        };

        const result = Strategy.getSignal({ symbol: pair, indicators, candles });
        total++;

        if (result?.signal) {
            signals++;
            // Entry price: use close of last candle in buffer
            const entryIdx = allM5Candles.findIndex((c) => c.timestamp === data.M5.timestamp);
            // Defensive: if not found, skip
            if (entryIdx === -1) continue;
            const bid = data.M5.close;
            const ask = data.M5.close;
            // Calculate trade parameters
            const params = await tradingService.calculateTradeParameters(
                result.signal,
                pair,
                bid,
                ask,
                candles,
                result.context
            );
            // Simulate trade result with lookahead (next 10 candles)
            const lookahead = 10;
            const m5LookaheadBuffer = allM5Candles.slice(entryIdx, entryIdx + lookahead + 1);
            const simResult = simulateTradeResult(m5LookaheadBuffer, 0, params, result.signal);
            // Update balance
            const risk = balance * tradingService.maxRiskPerTrade;
            if (simResult.outcome === "WIN") {
                balance += risk * 2;
            } else {
                balance -= risk;
            }
            tradingService.setAccountBalance(balance);
            // Save result
            const tradeResult = {
                time: data.M5.timestamp,
                signal: result.signal,
                entry: params.price,
                SL: params.stopLossPrice,
                TP: params.takeProfitPrice,
                outcome: simResult.outcome,
                exitTime: simResult.hitTime,
                balance,
            };
            results.push(tradeResult);
            outputStream.write(JSON.stringify(tradeResult) + "\n");
        }
    }

    outputStream.end();

    console.log(`✅ Backtest finished for ${pair}`);
    console.log(`Processed: ${total} candles`);
    console.log(`Signals generated: ${signals}`);
    console.log(`Saved results to: ${outputFile}`);
}

runBacktest();
