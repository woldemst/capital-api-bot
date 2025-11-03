import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import Strategy from "../strategies/strategies.js";
import logger from "../utils/logger.js";
import Strategy from "../strategies/strategies.js";
import { calcIndicators } from "../indicators.js";

const pair = process.env.PAIR || "AUDUSD";
const inputFile = process.env.INPUT || `./analysis/${pair}_combined.jsonl`;
const outputFile = process.env.OUTPUT || `./results/${pair}_backtest_results.jsonl`;

import tradingService from "../services/trading.js";

const MAX_BUF = 200;
const MIN_BARS = 60;

let m5Buffer = [];
let m15Buffer = [];
let h1Buffer = [];
let h4Buffer = [];

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

const fileStream = fs.createReadStream(inputFile);
const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
const startTime = new Date();
let wins = 0,
    losses = 0,
    totalDuration = 0;
const profitableFile = `./results/${pair}_profitable.jsonl`;
const profitableStream = fs.createWriteStream(profitableFile, { flags: "w" });

let total = 0;
let signals = 0;
let balance = 1000;
tradingService.setAccountBalance(balance);
const results = [];
let allLines = [];

// --- Preload all candles for lookahead ---
for await (const line of rl) {
    if (!line.trim()) continue;
    let data;
    try {
        const data = JSON.parse(line);
        allLines.push(data);
        if (data.M5) {
            m5Buffer.push(data.M5);
            if (m5Buffer.length > MAX_BUF) m5Buffer.shift();
        }
        if (data.M15) {
            m15Buffer.push(data.M15);
            if (m15Buffer.length > MAX_BUF) m15Buffer.shift();
        }
        if (data.H1) {
            h1Buffer.push(data.H1);
            if (h1Buffer.length > MAX_BUF) h1Buffer.shift();
        }
        if (data.H4) {
            h4Buffer.push(data.H4);
            if (h4Buffer.length > MAX_BUF) h4Buffer.shift();
        }
    } catch (err) {
        logger.error(`[Backtest] Failed to parse line for ${pair}: ${err.message}`);
        continue;
    }

    if (data.M5) {
        m5Buffer.push(data.M5);
        if (m5Buffer.length > M5_BUFFER_SIZE) {
            m5Buffer.shift();
        }
    }

    const indicators = { m1: data.M1, m5: data.M5, m15: data.M15, h1: data.H1, h4: data.H4 };
    const candles = {
        m5Candles: m5Buffer.slice(),
        m15Candles: [data.M15].filter(Boolean),
        h1Candles: [data.H1].filter(Boolean),
        m1Candles: [data.M1].filter(Boolean),
    };

    const decision = Strategy.getSignal({ symbol: pair, indicators, candles }) || { signal: null, reason: "no_decision" };
    const indicatorSnapshot = buildIndicatorSnapshot(indicators);
    const timestamp = getTimestamp(data);
    const tookTrade = Boolean(decision.signal);
    const context = decision.context && !decision.context.trend ? decision.context : undefined;
    const trendContext = decision.context?.trend;

    const decisionRecord = {
        time: timestamp,
        tookTrade,
        signal: decision.signal,
        reason: decision.reason,
        trend: trendContext,
        indicators: indicatorSnapshot,
        ...(context ? { context } : {}),
    };

    decisionStream.write(JSON.stringify(decisionRecord) + "\n");

    stats.processed += 1;

    if (tookTrade) {
        stats.signals += 1;
        if (stats.signalBreakdown[decision.signal] != null) {
            stats.signalBreakdown[decision.signal] += 1;
        }

        Object.entries(FEATURE_SELECTORS).forEach(([key, selector]) => {
            const value = selector(indicatorSnapshot);
            recordFeature(stats.featureStats, key, value);
        });

        signalStream.write(
            JSON.stringify({
                time: timestamp,
                signal: decision.signal,
                reason: decision.reason,
                indicators: indicatorSnapshot,
                ...(context ? { context } : {}),
            }) + "\n"
        );
    } else {
        const reasonKey = decision.reason || "unknown";
        stats.rejectionReasons[reasonKey] = (stats.rejectionReasons[reasonKey] || 0) + 1;
    }
}

// Clear buffers for processing loop
m5Buffer = [];
m15Buffer = [];
h1Buffer = [];
h4Buffer = [];

for (let idx = 0; idx < allLines.length; idx++) {
    const data = allLines[idx];
    if (data.M5) {
        m5Buffer.push(data.M5);
        if (m5Buffer.length > MAX_BUF) m5Buffer.shift();
    }
    if (data.M15) {
        m15Buffer.push(data.M15);
        if (m15Buffer.length > MAX_BUF) m15Buffer.shift();
    }
    if (data.H1) {
        h1Buffer.push(data.H1);
        if (h1Buffer.length > MAX_BUF) h1Buffer.shift();
    }
    if (data.H4) {
        h4Buffer.push(data.H4);
        if (h4Buffer.length > MAX_BUF) h4Buffer.shift();
    }

    if (m5Buffer.length < MIN_BARS || m15Buffer.length < MIN_BARS || h1Buffer.length < MIN_BARS || h4Buffer.length < MIN_BARS) {
        continue;
    }

    const indicators = {
        m1: data.M1 || null,
        m5: await calcIndicators(m5Buffer, pair, "MINUTE_5"),
        m15: await calcIndicators(m15Buffer, pair, "MINUTE_15"),
        h1: await calcIndicators(h1Buffer, pair, "HOUR"),
        h4: await calcIndicators(h4Buffer, pair, "HOUR_4"),
    };

    const candles = {
        m5Candles: m5Buffer.slice(),
        m15Candles: m15Buffer.slice(),
        h1Candles: h1Buffer.slice(),
        h4Candles: h4Buffer.slice(),
        m1Candles: data.M1 ? [data.M1] : [],
    };

    const result = Strategy.getSignal({ symbol: pair, indicators, candles });
    total++;

    if (result?.signal) {
        signals++;
        const entryIdx = m5Buffer.findIndex((c) => c.timestamp === data.M5.timestamp);
        if (entryIdx === -1) continue;
        const bid = data.M5.close;
        const ask = data.M5.close;
        const params = await tradingService.calculateTradeParameters(result.signal, pair, bid, ask, candles, result.context);
        if (!params) continue;
        const lookahead = 100;
        const m5LookaheadBuffer = m5Buffer.slice(entryIdx, entryIdx + lookahead + 1);
        const simResult = simulateTradeResult(m5LookaheadBuffer, 0, params, result.signal);
        const risk = balance * tradingService.maxRiskPerTrade;
        if (simResult.outcome === "WIN") {
            balance += risk * 2;
        } else {
            balance -= risk;
        }
        tradingService.setAccountBalance(balance);
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

        if (simResult.hitTime && data.M5?.timestamp) {
            const durationMin = (new Date(simResult.hitTime) - new Date(data.M5.timestamp)) / 60000;
            tradeResult.durationMin = durationMin;
            totalDuration += durationMin;
        }

        // Optional M1 stop loss check
        const m1Candles = data.M1Candles || data.M1 || [];
        const slHitOnM1 = Array.isArray(m1Candles)
            ? m1Candles.some((c) => (result.signal === "BUY" && c.low <= params.stopLossPrice) || (result.signal === "SELL" && c.high >= params.stopLossPrice))
            : false;
        if (slHitOnM1 && simResult.outcome === "WIN") simResult.outcome = "LOSS";

        if (simResult.outcome === "WIN") {
            wins++;
            profitableStream.write(JSON.stringify(tradeResult) + "\n");
        } else {
            losses++;
        }

        results.push(tradeResult);
        outputStream.write(JSON.stringify(tradeResult) + "\n");
    }
}

outputStream.end();
profitableStream.end();
const endTime = new Date();
const avgDuration = wins ? totalDuration / wins : 0;

// --- Additional summary metrics ---
const grossProfit = wins * (balance * tradingService.maxRiskPerTrade * 2);
const grossLoss = losses * (balance * tradingService.maxRiskPerTrade);
const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "N/A";
// Placeholder for max drawdown (not tracked here, would need equity curve)
const maxDrawdown = "N/A";

console.log(`✅ Backtest finished for ${pair}`);
console.log(`Processed: ${total} candles`);
console.log(`Signals generated: ${signals}`);
console.log(`Saved results to: ${outputFile}`);

console.log(`\n=== ${pair} BACKTEST SUMMARY ===`);
console.log(`Start: ${startTime.toISOString()}`);
console.log(`End: ${endTime.toISOString()}`);
console.log(`Signals: ${signals}`);
console.log(`Profitable: ${wins}`);
console.log(`Unprofitable: ${losses}`);
console.log(`Win Rate: ${((wins / (signals || 1)) * 100).toFixed(2)}%`);
console.log(`Avg Hold: ${avgDuration.toFixed(2)} min`);
console.log(`Profit Factor: ${profitFactor}`);
console.log(`Max Drawdown: ${maxDrawdown}`);
console.log(`Profitable trades saved to: ${profitableFile}`);

runBacktests().catch((err) => {
    logger.error(`[Backtest] Failed: ${err.stack || err.message}`);
    process.exitCode = 1;
});
