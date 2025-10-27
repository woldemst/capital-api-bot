import fs from "fs";
import path from "path";
import readline from "readline";
import Strategy from "../strategies/strategies.js";
import logger from "../utils/logger.js";

const pair = (process.argv[2] || "EURUSD").toUpperCase();
const inputFile = process.argv[3] || `./analysis/${pair}_combined.jsonl`;
const outputDir = "./results";
const signalOutputFile = path.join(outputDir, `${pair}_signals.jsonl`);
const summaryOutputFile = path.join(outputDir, `${pair}_summary.jsonl`);

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function average(values) {
    if (!values.length) return null;
    const sum = values.reduce((acc, val) => acc + val, 0);
    return sum / values.length;
}

function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function buildIndicatorSnapshot(indicators = {}) {
    const pick = (frame) => {
        if (!frame) return undefined;
        return {
            ema20: frame.ema20 ?? frame.emaFast ?? null,
            ema50: frame.ema50 ?? frame.emaSlow ?? null,
            rsi: frame.rsi ?? null,
            adx: frame.adx?.adx ?? frame.adx ?? null,
            atr: frame.atr ?? null,
        };
    };

    return {
        m5: pick(indicators.m5),
        m15: pick(indicators.m15),
        h1: pick(indicators.h1),
    };
}

function buildTradeMetrics(symbol, signalResult) {
    if (!signalResult?.signal || !signalResult?.context) return null;

    const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
    const { context } = signalResult;

    const entryPrice = toNumber(context.entryPrice);
    const rawStop = toNumber(context.stopLossPrice);
    const slDistance = toNumber(context.slDistance);
    const rewardDistance = toNumber(context.rewardDistance);

    if ([entryPrice, slDistance, rewardDistance].some((v) => v == null || v <= 0)) {
        return null;
    }

    const stopLossPrice =
        rawStop ??
        (signalResult.signal === "BUY" ? entryPrice - slDistance : entryPrice + slDistance);
    const takeProfitPrice =
        signalResult.signal === "BUY" ? entryPrice + rewardDistance : entryPrice - rewardDistance;

    return {
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        slDistance,
        rewardDistance,
        slPips: slDistance / pip,
        tpPips: rewardDistance / pip,
        riskReward: rewardDistance / slDistance,
        atrMultiple: context.atr ? slDistance / context.atr : null,
        swingHigh: context.swingHigh ?? null,
        swingLow: context.swingLow ?? null,
    };
}

async function runBacktest() {
    if (!fs.existsSync(inputFile)) {
        console.error(`❌ Input file not found: ${inputFile}`);
        process.exit(1);
    }

    ensureDirectory(outputDir);

    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const signalStream = fs.createWriteStream(signalOutputFile, { flags: "a" });

    let total = 0;
    let signals = 0;
    let buySignals = 0;
    let sellSignals = 0;

    const slCollection = [];
    const tpCollection = [];
    const rrCollection = [];
    const reasonCounts = new Map();

    let m5CandleBuffer = [];
    const M5_BUFFER_SIZE = 20;

    for await (const line of rl) {
        if (!line.trim()) continue;
        total++;

        let data;
        try {
            data = JSON.parse(line);
        } catch (err) {
            logger.error(`[Backtest] Failed to parse line ${total}: ${err.message}`);
            continue;
        }

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

        const priceReference =
            toNumber(data?.M1?.close) ??
            toNumber(data?.M5?.close) ??
            toNumber(data?.price) ??
            null;

        const bid = priceReference;
        const ask = priceReference;

        const result = Strategy.getSignal({
            symbol: pair,
            indicators,
            candles,
            bid,
            ask,
        });

        if (!result?.signal) {
            const reason = result?.reason || "unknown";
            reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
            continue;
        }

        const metrics = buildTradeMetrics(pair, result);
        if (!metrics) {
            logger.warn(`[Backtest] Missing metrics for signal at record ${total}.`);
            continue;
        }

        signals++;
        if (result.signal === "BUY") buySignals++;
        if (result.signal === "SELL") sellSignals++;

        slCollection.push(metrics.slPips);
        tpCollection.push(metrics.tpPips);
        rrCollection.push(metrics.riskReward);

        const indicatorSnapshot = buildIndicatorSnapshot(indicators);

        const payload = {
            timestamp: data?.M1?.timestamp || data?.timestamp || null,
            symbol: pair,
            direction: result.signal,
            reason: result.reason,
            score: result.score ?? null,
            breakdown: result.breakdown ?? null,
            metrics,
            indicators: indicatorSnapshot,
        };

        signalStream.write(JSON.stringify(payload) + "\n");
    }

    rl.close();
    signalStream.end();

    const summaryStream = fs.createWriteStream(summaryOutputFile, { flags: "a" });

    const avgSL = average(slCollection);
    const avgTP = average(tpCollection);
    const avgRR = average(rrCollection);
    const medRR = median(rrCollection);

    const summary = {
        timestamp: new Date().toISOString(),
        symbol: pair,
        inputFile,
        totalRecords: total,
        signals,
        buySignals,
        sellSignals,
        hitRate: total ? Number((signals / total).toFixed(4)) : null,
        averageSLPips: avgSL != null ? Number(avgSL.toFixed(2)) : null,
        averageTPPips: avgTP != null ? Number(avgTP.toFixed(2)) : null,
        averageRiskReward: avgRR != null ? Number(avgRR.toFixed(2)) : null,
        medianRiskReward: medRR != null ? Number(medRR.toFixed(2)) : null,
        failureReasons: Object.fromEntries(reasonCounts),
    };

    summaryStream.write(JSON.stringify(summary) + "\n");
    summaryStream.end();

    console.log(`✅ Backtest finished for ${pair}`);
    console.log(`Processed: ${total} records`);
    console.log(`Signals generated: ${signals} (BUY: ${buySignals} | SELL: ${sellSignals})`);
    console.log(`Saved signals to: ${signalOutputFile}`);
    console.log(`Saved summary to: ${summaryOutputFile}`);
}

runBacktest().catch((error) => {
    console.error("❌ Backtest failed:", error);
    process.exit(1);
});
