import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../utils/logger.js";
import Strategy, { setPairRuleOverrides, clearPairRuleOverrides, getPairRules } from "../strategies/strategies.js";
import { calcIndicators } from "../indicators.js";
import tradingService from "../services/trading.js";
import { readJsonSafe, integratePendingSuggestions, buildResultPayload, buildImprovementsPayload } from "./evolutionEngine.js";

const pair = process.env.PAIR || "AUDUSD";
const inputFile = process.env.INPUT || `./analysis/${pair}_combined.jsonl`;
const outputFile = process.env.OUTPUT || `./results/${pair}_backtest_results.jsonl`;
const profitableFile = process.env.PROFITABLE || `./results/${pair}_profitable.jsonl`;
const summaryFile = process.env.SUMMARY || `./results/${pair}_backtest_summary.json`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultEvolutionDir = path.resolve(__dirname, "results");
const evolutionDir = process.env.EVOLUTION_DIR ? path.resolve(process.env.EVOLUTION_DIR) : defaultEvolutionDir;
const pairSlug = pair.replace(/[^\w]/g, "");
const evolutionResultFile = path.resolve(evolutionDir, `result_${pairSlug}.json`);
const evolutionImprovementFile = path.resolve(evolutionDir, `improvements_${pairSlug}.json`);

const MAX_BUF = 200;
const MIN_BARS = 60;
const LOOKAHEAD_CANDLES = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ensureDir = (filePath) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

function pushUnique(buffer, candle) {
    if (!candle || !candle.timestamp) {
        return false;
    }
    const last = buffer[buffer.length - 1];
    if (last && last.timestamp === candle.timestamp) {
        return false;
    }
    buffer.push(candle);
    if (buffer.length > MAX_BUF) buffer.shift();
    return true;
}

function buildUniqueM5Series(allLines, startIdx, limit = LOOKAHEAD_CANDLES + 1) {
    const series = [];
    let lastTs = null;
    for (let i = startIdx; i < allLines.length; i++) {
        const candle = allLines[i]?.M5;
        if (!candle || !candle.timestamp) continue;
        if (candle.timestamp === lastTs) continue;
        series.push(candle);
        lastTs = candle.timestamp;
        if (series.length >= limit) break;
    }
    return series;
}

function simulateTradeResult(m5Series, entryIdx, params, signal) {
    const { price, stopLossPrice, takeProfitPrice } = params;
    for (let i = entryIdx + 1; i < m5Series.length; i++) {
        const candle = m5Series[i];
        if (!candle) continue;
        const { high, low } = candle;
        if (signal === "BUY") {
            if (low <= stopLossPrice && high >= takeProfitPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp, exitReason: "sl_hit" };
            }
            if (high >= takeProfitPrice) {
                return { outcome: "WIN", hitTime: candle.timestamp, exitReason: "tp_hit" };
            }
            if (low <= stopLossPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp, exitReason: "sl_hit" };
            }
        } else if (signal === "SELL") {
            if (high >= stopLossPrice && low <= takeProfitPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp, exitReason: "sl_hit" };
            }
            if (low <= takeProfitPrice) {
                return { outcome: "WIN", hitTime: candle.timestamp, exitReason: "tp_hit" };
            }
            if (high >= stopLossPrice) {
                return { outcome: "LOSS", hitTime: candle.timestamp, exitReason: "sl_hit" };
            }
        }
    }
    return { outcome: "LOSS", hitTime: null, exitReason: "soft_exit" };
}

function classifyAlignment(context = {}, decision = "") {
    const desired =
        context.m5Trend ||
        (decision === "BUY" ? "bullish" : decision === "SELL" ? "bearish" : null);

    if (!desired) {
        return {
            type: "unknown",
            desired: null,
            matches: 0,
            context: { m15: context.m15Trend, h1: context.h1Trend, h4: context.h4Trend },
        };
    }

    const matches = ["m15Trend", "h1Trend", "h4Trend"].reduce((acc, key) => (context[key] === desired ? acc + 1 : acc), 0);
    const type = matches === 3 ? "full" : matches >= 2 ? "partial" : "divergent";

    return {
        type,
        desired,
        matches,
        context: {
            m5: desired,
            m15: context.m15Trend,
            h1: context.h1Trend,
            h4: context.h4Trend,
        },
    };
}

const getPatternLabel = (context = {}) => {
    if (context.pattern) return "momentum_flip";
    if (context.engulfing) return "engulfing";
    if (context.pinBar) return "pin_bar";
    return "none";
};

function calculateMaxDrawdown(equityCurve) {
    let peak = equityCurve[0] ?? 0;
    let maxDrop = 0;
    for (const value of equityCurve) {
        if (value > peak) {
            peak = value;
            continue;
        }
        const drop = peak - value;
        if (drop > maxDrop) maxDrop = drop;
    }
    const peakValue = Math.max(...equityCurve);
    const ddPct = peakValue ? (maxDrop / peakValue) * 100 : 0;
    return { absolute: maxDrop, percent: ddPct };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runBacktest() {
    ensureDir(outputFile);
    ensureDir(profitableFile);
    ensureDir(summaryFile);
    ensureDir(evolutionResultFile);
    ensureDir(evolutionImprovementFile);

    const previousResult = readJsonSafe(evolutionResultFile);
    const previousImprovementsRaw = readJsonSafe(evolutionImprovementFile);
    const { overrides: suggestionOverrides, snapshot: previousImprovements, integrationLog } = integratePendingSuggestions(previousImprovementsRaw);

    if (suggestionOverrides && Object.keys(suggestionOverrides).length) {
        setPairRuleOverrides(pair, suggestionOverrides);
        logger.info(
            `[Backtest] Applied ${Object.keys(suggestionOverrides).length} suggestion override block(s) from improvements for ${pair}`
        );
    }

    const iterationNumber = previousResult ? (previousResult.iteration ?? 0) + 1 : 1;
    const hasHistory = Boolean(previousResult && previousImprovementsRaw);
    const iterationLabel = hasHistory ? `iteration ${iterationNumber}` : "first-generation";
    logger.info(`[Backtest] Starting ${iterationLabel} run for ${pair}`);
    console.log(`\n--- PHASE 1: ${hasHistory ? "Analysis of previous generation" : "Genesis run"} ---`);
    const improvementsBaseline = previousImprovements || previousImprovementsRaw;

    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const allLines = [];
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            allLines.push(JSON.parse(line));
        } catch (err) {
            logger.error(`[Backtest] Failed to parse JSON: ${err.message}`);
        }
    }

    if (!allLines.length) {
        logger.error(`[Backtest] No data loaded from ${inputFile}`);
        return;
    }

    console.log("\n--- PHASE 2: Backtest execution ---");

    const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
    const profitableStream = fs.createWriteStream(profitableFile, { flags: "w" });

    let m5Buffer = [];
    let m15Buffer = [];
    let h1Buffer = [];
    let h4Buffer = [];

    const indicatorCache = { m5: null, m15: null, h1: null, h4: null };

    const startTime = new Date();
    let processedCandles = 0;
    let signals = 0;
    let wins = 0;
    let losses = 0;
    let totalDuration = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let balance = 1000;
    tradingService.setAccountBalance(balance);
    const equityCurve = [balance];
    const rejectionReasons = {};
    const directionCounts = { BUY: 0, SELL: 0 };
    const results = [];

    for (let idx = 0; idx < allLines.length; idx++) {
        const data = allLines[idx];

        const m5Updated = pushUnique(m5Buffer, data.M5);
        const m15Updated = pushUnique(m15Buffer, data.M15);
        const h1Updated = pushUnique(h1Buffer, data.H1);
        const h4Updated = pushUnique(h4Buffer, data.H4);

        if (!m5Updated) continue;

        processedCandles++;

        if (
            m5Buffer.length < MIN_BARS ||
            m15Buffer.length < MIN_BARS ||
            h1Buffer.length < MIN_BARS ||
            h4Buffer.length < MIN_BARS
        ) {
            continue;
        }

        try {
            if (m5Updated) indicatorCache.m5 = await calcIndicators(m5Buffer);
            if (m15Updated || !indicatorCache.m15) indicatorCache.m15 = await calcIndicators(m15Buffer);
            if (h1Updated || !indicatorCache.h1) indicatorCache.h1 = await calcIndicators(h1Buffer);
            if (h4Updated || !indicatorCache.h4) indicatorCache.h4 = await calcIndicators(h4Buffer);
        } catch (indicatorErr) {
            logger.warn(`[Backtest] Indicator calculation failed: ${indicatorErr.message}`);
            continue;
        }

        if (!indicatorCache.m5 || !indicatorCache.m15 || !indicatorCache.h1 || !indicatorCache.h4) {
            continue;
        }

        const indicators = {
            m1: data.M1 || null,
            m5: indicatorCache.m5,
            m15: indicatorCache.m15,
            h1: indicatorCache.h1,
            h4: indicatorCache.h4,
        };

        const candles = {
            m5Candles: m5Buffer.slice(),
            m15Candles: m15Buffer.slice(),
            h1Candles: h1Buffer.slice(),
            h4Candles: h4Buffer.slice(),
            m1Candles: data.M1 ? [data.M1] : [],
        };

        const result = Strategy.getSignal({ symbol: pair, indicators, candles });
        if (!result?.signal) {
            const reason = result?.reason || "no_signal";
            rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
            continue;
        }

        const entryCandle = candles.m5Candles[candles.m5Candles.length - 1];
        if (!entryCandle?.timestamp) {
            rejectionReasons["missing_entry_timestamp"] = (rejectionReasons["missing_entry_timestamp"] || 0) + 1;
            continue;
        }

        signals++;
        directionCounts[result.signal] = (directionCounts[result.signal] || 0) + 1;

        const bid = entryCandle.close;
        const ask = entryCandle.close;

        let params;
        try {
            params = await tradingService.calculateTradeParameters(result.signal, pair, bid, ask, {
                last: entryCandle,
                indicators,
            });
        } catch (calcErr) {
            logger.error(`[Backtest] Failed to calculate trade params: ${calcErr.message}`);
            continue;
        }

        if (!params) {
            rejectionReasons["param_calc_failed"] = (rejectionReasons["param_calc_failed"] || 0) + 1;
            continue;
        }

        const futureSeries = buildUniqueM5Series(allLines, idx, LOOKAHEAD_CANDLES + 1);
        if (futureSeries.length < 2) {
            rejectionReasons["insufficient_lookahead"] = (rejectionReasons["insufficient_lookahead"] || 0) + 1;
            continue;
        }

        const simResult = simulateTradeResult(futureSeries, 0, params, result.signal);
        const signalContext = result.context || {};
        const alignmentMeta = classifyAlignment(signalContext, result.signal);
        const patternLabel = getPatternLabel(signalContext);
        const exitReason = simResult.exitReason || (simResult.outcome === "WIN" ? "tp_hit" : "sl_hit");

        const slDistance = Math.abs(params.price - params.stopLossPrice);
        const tpDistance = Math.abs(params.takeProfitPrice - params.price);
        const rr = slDistance > 0 ? tpDistance / slDistance : 0;
        const risk = balance * tradingService.maxRiskPerTrade;
        const reward = risk * rr;
        const pnl = simResult.outcome === "WIN" ? reward : -risk;

        if (simResult.outcome === "WIN") {
            balance += reward;
            grossProfit += reward;
            wins++;
        } else {
            balance -= risk;
            grossLoss += risk;
            losses++;
        }

        balance = Number(balance.toFixed(2));
        tradingService.setAccountBalance(balance);
        equityCurve.push(balance);

        const tradeResult = {
            time: entryCandle.timestamp,
            signal: result.signal,
            entry: params.price,
            SL: params.stopLossPrice,
            TP: params.takeProfitPrice,
            rr: Number(rr.toFixed(2)),
            risk,
            reward,
            outcome: simResult.outcome,
            exitReason,
            exitTime: simResult.hitTime,
            balance,
            pnl: Number(pnl.toFixed(2)),
            patternLabel,
            alignment: alignmentMeta,
            atr: indicators.m5?.atr ?? null,
            h1Atr: indicators.h1?.atr ?? null,
            entryReason: result.reason || "pattern+tf_alignment",
            signalContext: {
                m5Trend: signalContext.m5Trend ?? null,
                m15Trend: signalContext.m15Trend ?? null,
                h1Trend: signalContext.h1Trend ?? null,
                h4Trend: signalContext.h4Trend ?? null,
            },
        };

        if (simResult.hitTime) {
            const durationMin = (new Date(simResult.hitTime) - new Date(entryCandle.timestamp)) / 60000;
            if (!Number.isNaN(durationMin)) {
                tradeResult.durationMin = durationMin;
                if (simResult.outcome === "WIN") {
                    totalDuration += durationMin;
                }
            }
        }

        if (simResult.outcome === "WIN") {
            profitableStream.write(JSON.stringify(tradeResult) + "\n");
        }

        results.push(tradeResult);
        outputStream.write(JSON.stringify(tradeResult) + "\n");
    }

    outputStream.end();
    profitableStream.end();

    const endTime = new Date();
    const avgDuration = wins ? totalDuration / wins : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
    const drawdown = calculateMaxDrawdown(equityCurve);

    const summary = {
        pair,
        processedCandles,
        signals,
        wins,
        losses,
        winRate: signals ? (wins / signals) * 100 : 0,
        riskPerTrade: tradingService.maxRiskPerTrade,
        finalBalance: balance,
        grossProfit: Number(grossProfit.toFixed(2)),
        grossLoss: Number(grossLoss.toFixed(2)),
        profitFactor: profitFactor != null ? Number(profitFactor.toFixed(2)) : null,
        avgHoldMinutes: Number(avgDuration.toFixed(2)),
        maxDrawdown: {
            absolute: Number(drawdown.absolute.toFixed(2)),
            percent: Number(drawdown.percent.toFixed(2)),
        },
        rejections: rejectionReasons,
        directions: directionCounts,
        files: {
            trades: outputFile,
            profitable: profitableFile,
            summary: summaryFile,
            evolutionResult: evolutionResultFile,
            improvements: evolutionImprovementFile,
        },
        startedAt: startTime.toISOString(),
        finishedAt: endTime.toISOString(),
        equitySamples: equityCurve.length,
    };

    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    const resultPayload = buildResultPayload({
        pair,
        trades: results,
        summary,
        equityCurve,
        previousResult,
        iteration: iterationNumber,
    });
    const activeRules = getPairRules(pair);
    const improvementsPayload = buildImprovementsPayload({
        pair,
        iteration: resultPayload.iteration,
        previousImprovements: improvementsBaseline,
        previousResult,
        newResult: resultPayload,
        integrationLog,
        activeRules,
    });

    fs.writeFileSync(evolutionResultFile, JSON.stringify(resultPayload, null, 2));
    fs.writeFileSync(evolutionImprovementFile, JSON.stringify(improvementsPayload, null, 2));
    console.log("\n--- PHASE 3: Evolved reporting ---");
    console.log(`Result journal: ${evolutionResultFile}`);
    console.log(`Improvement plan: ${evolutionImprovementFile}`);

    console.log(`✅ Backtest finished for ${pair}`);
    console.log(`Processed (unique M5): ${processedCandles}`);
    console.log(`Signals generated: ${signals}`);
    console.log(`Saved results to: ${outputFile}`);

    console.log(`\n=== ${pair} BACKTEST SUMMARY ===`);
    console.log(`Start: ${startTime.toISOString()}`);
    console.log(`End: ${endTime.toISOString()}`);
    console.log(`Signals: ${signals}`);
    console.log(`Profitable: ${wins}`);
    console.log(`Unprofitable: ${losses}`);
    console.log(`Win Rate: ${summary.winRate.toFixed(2)}%`);
    console.log(`Avg Hold: ${summary.avgHoldMinutes.toFixed(2)} min`);
    console.log(`Profit Factor: ${summary.profitFactor ?? "N/A"}`);
    console.log(
        `Max Drawdown: ${summary.maxDrawdown.absolute.toFixed(2)} (${summary.maxDrawdown.percent.toFixed(2)}%)`
    );
    console.log(`Profitable trades saved to: ${profitableFile}`);
    console.log(`Summary saved to: ${summaryFile}`);
    clearPairRuleOverrides(pair);
}

runBacktest();
