import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { calcIndicators } from "../indicators/indicators.js";
import Strategy from "../strategies/strategies.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEFRAMES = {
    M1: { suffix: "M1" },
    M5: { suffix: "M5" },
    M15: { suffix: "M15" },
    H1: { suffix: "H1" },
    H4: { suffix: "H4" },
};

const STOP_LOSS_ATR_MULTIPLIER = 1.5;
const TAKE_PROFIT_MULTIPLIER = 2; // risk-reward 1:2

function normalizeSymbol(input) {
    return (input || "").toUpperCase().replace(/\//g, "").trim();
}

function formatIso(ts) {
    return new Date(ts).toISOString();
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing data file: ${filePath}`);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw
        .map((c) => ({
            ...c,
            timestampMs: new Date(c.timestamp).getTime(),
        }))
        .sort((a, b) => a.timestampMs - b.timestampMs);
}

function loadAllCandles(symbol) {
    const result = {};
    for (const [key, { suffix }] of Object.entries(TIMEFRAMES)) {
        const file = path.resolve(__dirname, "data", symbol, `${symbol}_${suffix}.json`);
        result[key] = readJson(file);
    }
    return result;
}

function advanceIndex(candles, currentIdx, timestamp) {
    let idx = currentIdx < 0 ? 0 : currentIdx;
    while (idx + 1 < candles.length && candles[idx + 1].timestampMs <= timestamp) {
        idx++;
    }
    if (candles[idx] && candles[idx].timestampMs <= timestamp) {
        return idx;
    }
    return -1;
}

function findStartIndex(candles, timestamp) {
    let left = 0;
    let right = candles.length - 1;
    let answer = -1;
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (candles[mid].timestampMs >= timestamp) {
            answer = mid;
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }
    return answer;
}

function pickExitOnSameCandle(direction, candle, stopLoss, takeProfit) {
    const open = candle.open ?? candle.close;
    const distToSL = Math.abs(open - stopLoss);
    const distToTP = Math.abs(open - takeProfit);
    return distToSL <= distToTP ? "SL" : "TP";
}

function simulateExit(trade, m1Candles) {
    const startIdx = findStartIndex(m1Candles, trade.entryTime);
    if (startIdx === -1) {
        return { ...trade, result: "OPEN", exitTime: trade.entryTime, exitPrice: trade.entryPrice };
    }

    for (let i = startIdx; i < m1Candles.length; i++) {
        const candle = m1Candles[i];
        const hitSL = trade.direction === "BUY" ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss;
        const hitTP = trade.direction === "BUY" ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit;

        if (hitSL && hitTP) {
            const winner = pickExitOnSameCandle(trade.direction, candle, trade.stopLoss, trade.takeProfit);
            const exitPrice = winner === "TP" ? trade.takeProfit : trade.stopLoss;
            return { ...trade, result: winner, exitTime: candle.timestampMs, exitPrice };
        }

        if (hitSL) {
            return { ...trade, result: "SL", exitTime: candle.timestampMs, exitPrice: trade.stopLoss };
        }
        if (hitTP) {
            return { ...trade, result: "TP", exitTime: candle.timestampMs, exitPrice: trade.takeProfit };
        }
    }

    const last = m1Candles[m1Candles.length - 1];
    return { ...trade, result: "OPEN", exitTime: last.timestampMs, exitPrice: last.close };
}

async function calculateAtr(candles, idx) {
    if (idx < 1) return null;
    const indicator = await calcIndicators(candles.slice(0, idx + 1));
    return indicator?.atr ?? null;
}

async function backtestSymbol(symbol) {
    const candles = loadAllCandles(symbol);
    const m5 = candles.M5;
    if (!m5 || m5.length < 3) {
        throw new Error(`Not enough M5 candles for ${symbol}`);
    }

    const positions = { M15: -1, H1: -1, H4: -1 };
    const trades = [];

    for (let i = 2; i < m5.length - 1; i++) {
        const lastClosed = m5[i - 1];
        const nextCandle = m5[i];
        const signalTime = lastClosed.timestampMs;

        positions.M15 = advanceIndex(candles.M15, positions.M15, signalTime);
        positions.H1 = advanceIndex(candles.H1, positions.H1, signalTime);
        positions.H4 = advanceIndex(candles.H4, positions.H4, signalTime);

        if (positions.M15 < 0 || positions.H1 < 0 || positions.H4 < 0) continue;

        const signal = Strategy.getSignal({
            symbol,
            indicators: {
                m15: candles.M15[positions.M15],
                h1: candles.H1[positions.H1],
                h4: candles.H4[positions.H4],
            },
            candles: { m5Candles: m5.slice(0, i + 1) },
            bid: lastClosed.close,
            ask: lastClosed.close,
        });

        if (!signal?.signal) continue;

        const atr = await calculateAtr(candles.M15, positions.M15);
        if (!Number.isFinite(atr) || atr <= 0) continue;

        const stopDistance = atr * STOP_LOSS_ATR_MULTIPLIER;
        const takeProfitDistance = stopDistance * TAKE_PROFIT_MULTIPLIER;

        const entryPrice = nextCandle.open ?? lastClosed.close;
        const trade = {
            direction: signal.signal,
            entryPrice,
            entryTime: nextCandle.timestampMs,
        };

        if (signal.signal === "BUY") {
            trade.stopLoss = entryPrice - stopDistance;
            trade.takeProfit = entryPrice + takeProfitDistance;
        } else {
            trade.stopLoss = entryPrice + stopDistance;
            trade.takeProfit = entryPrice - takeProfitDistance;
        }

        const result = simulateExit(trade, candles.M1);
        trades.push(result);

        while (i < m5.length && m5[i].timestampMs <= result.exitTime) {
            i++;
        }
        i--;
    }

    const takeProfitHits = trades.filter((t) => t.result === "TP").length;
    const stopLossHits = trades.filter((t) => t.result === "SL").length;
    const avgDurationMinutes =
        trades.length === 0
            ? 0
            : trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0) / trades.length / 60000;

    const firstTs = m5?.[0]?.timestampMs ?? null;
    const lastTs = m5?.[m5.length - 1]?.timestampMs ?? null;

    console.log(`\nBacktest results for ${symbol}`);
    console.log(`Positions opened: ${trades.length}`);
    console.log(`Take-profit hits: ${takeProfitHits}`);
    console.log(`Stop-loss hits: ${stopLossHits}`);
    console.log(`Average duration: ${avgDurationMinutes.toFixed(2)} minutes`);
    if (firstTs && lastTs) {
        console.log(`Period: ${formatIso(firstTs)}  ->  ${formatIso(lastTs)}`);
    }
}

function promptSymbol() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question("Enter symbol (e.g. EURUSD): ", (answer) => {
            rl.close();
            resolve(normalizeSymbol(answer) || "EURUSD");
        });
    });
}

async function main() {
    try {
        const symbol = await promptSymbol();
        await backtestSymbol(symbol);
    } catch (error) {
        console.error("Backtest failed:", error.message);
    }
}

main();
