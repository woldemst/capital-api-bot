import fs from "fs";
import readline from "readline";
import logger from "../utils/logger.js";

const pair = "AUDUSD"; // or dynamically detect from file name
const inputFile = `./analysis/${pair}_combined.jsonl`; // <-- remove space before ./
const outputFile = `./results/${pair}_backtest_results.jsonl`;

let m5CandleBuffer = [];
const M5_BUFFER_SIZE = 10; // or whatever your strategy expects

async function runBacktest() {
    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const outputStream = fs.createWriteStream(outputFile, { flags: "a" });
    let total = 0;
    let signals = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const data = JSON.parse(line);

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
                m5Candles: m5CandleBuffer.slice(), // pass a copy
                m15Candles: [data.M15].filter(Boolean),
                h1Candles: [data.H1].filter(Boolean),
                m1Candles: [data.M1].filter(Boolean),
            };

            const result = getSignal({ symbol: pair, indicators, candles });
            total++;

            if (result?.signal) {
                signals++;
                outputStream.write(
                    JSON.stringify({
                        time: data.M1.timestamp,
                        signal: result.signal,
                        reason: result.reason,
                        indicators,
                        context: result.context, // if you want extra candle info
                    }) + "\n"
                );
            }
        } catch (err) {
            console.error("Error parsing line:", err);
        }
    }

    rl.close();
    outputStream.end();

    console.log(`✅ Backtest finished for ${pair}`);
    console.log(`Processed: ${total} candles`);
    console.log(`Signals generated: ${signals}`);
    console.log(`Saved results to: ${outputFile}`);
}

const getSignal = ({ symbol, indicators, candles }) => {
    const { m1, m5, m15, h1 } = indicators || {};

    // Defensive checks for missing data
    if (!h1 || h1.ema20 == null || h1.ema50 == null) {
        logger.warn(`[${symbol}] Missing H1 EMA data`);
        return { signal: null, reason: "missing_h1_ema" };
    }
    if (!candles || !candles.m5Candles || candles.m5Candles.length < 4) {
        logger.warn(`[${symbol}] Not enough m5Candles`);
        return { signal: null, reason: "not_enough_m5_candles" };
    }

    // --- Multi-timeframe trends ---
    const h1Trend = h1.ema20 > h1.ema50 ? "bullish" : h1.ema20 < h1.ema50 ? "bearish" : "neutral";
    const m5Trend = m5.ema20 > m5.ema50 ? "bullish" : m5.ema20 < m5.ema50 ? "bearish" : "neutral";
    const alignedTrend = h1Trend === m5Trend && (h1Trend === "bullish" || h1Trend === "bearish");
    if (!alignedTrend) return { signal: null, reason: "trend_not_aligned" };

    // --- Candle data ---
    const prev = candles.m5Candles[candles.m5Candles.length - 3];
    const last = candles.m5Candles[candles.m5Candles.length - 2];
    if (!prev || !last) return { signal: null, reason: "no_candle_data" };

    // --- Pattern recognition ---
    const pattern = greenRedCandlePattern(m5Trend, prev, last);

    // --- Improved conditions based on profitable trades ---
    const m5RSI = m5.rsi;
    const m5ADX = m5.adx?.adx;
    const m5BBpb = m5.bb?.pb;
    const m15ADX = m15.adx?.adx;
    const h1ADX = h1.adx?.adx;
    const h1RSI = h1.rsi;

    // SELL setup
    if (
        pattern === "bearish" &&
        m5Trend === "bearish" &&
        alignedTrend &&
        m5RSI > 45 &&
        m5RSI < 65 &&
        m5BBpb > 0.7 &&
        ((m15ADX && m15ADX > 25) || (h1ADX && h1ADX > 25)) &&
        h1RSI < 35
    ) {
        return {
            signal: "SELL",
            reason: "profitable_pattern_trend_alignment",
            context: {
                prevHigh: prev.high,
                prevLow: prev.low,
                prevOpen: prev.open,
                prevClose: prev.close,
            },
        };
    }

    // BUY setup (mirror logic)
    if (
        pattern === "bullish" &&
        m5Trend === "bullish" &&
        alignedTrend &&
        m5RSI > 35 &&
        m5RSI < 55 &&
        m5BBpb < 0.3 &&
        ((m15ADX && m15ADX > 25) || (h1ADX && h1ADX > 25)) &&
        h1RSI > 65
    ) {
        return {
            signal: "BUY",
            reason: "profitable_pattern_trend_alignment",
            context: {
                prevHigh: prev.high,
                prevLow: prev.low,
                prevOpen: prev.open,
                prevClose: prev.close,
            },
        };
    }

    return { signal: null, reason: "no_profitable_signal" };
};

function greenRedCandlePattern(trend, prev, last) {
    if (!prev || !last || !trend) return false;
    const getOpen = (c) => (typeof c.o !== "undefined" ? c.o : c.open);
    const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

    if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) return false;

    const isBullish = (c) => getClose(c) > getOpen(c);
    const isBearish = (c) => getClose(c) < getOpen(c);

    const trendDirection = String(trend).toLowerCase();

    if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) return "bullish";
    if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) return "bearish";

    return false;
}

runBacktest();
