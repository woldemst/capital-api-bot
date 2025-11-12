import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import Strategy from "../strategies/strategies.js";
import { RISK } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAIR = "EURJPY";
const INPUT_FILE = path.resolve(__dirname, "analysis", `${PAIR}_combined.jsonl`);
const RESULT_FILE = path.resolve(__dirname, `result_${PAIR}.json`);
const IMPROVEMENTS_FILE = path.resolve(__dirname, `improvements_${PAIR}.json`);

const MAX_BUF = 200;
const MIN_BARS = 60;
const LOOKAHEAD = 120;
const START_BALANCE = 1000;

const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"];

function roundPrice(price, symbol) {
    const decimals = symbol.includes("JPY") ? 3 : 5;
    return Number(price.toFixed(decimals));
}

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

function buildFutureContexts(allLines, startIdx, limit) {
    const contexts = [];
    const seen = new Set();
    for (let i = startIdx + 1; i < allLines.length; i++) {
        const row = allLines[i];
        const m5 = row?.M5;
        if (!m5?.timestamp || seen.has(m5.timestamp)) {
            continue;
        }
        contexts.push(row);
        seen.add(m5.timestamp);
        if (contexts.length >= limit) break;
    }
    return contexts;
}

function minutesBetween(start, end) {
    if (!start || !end) return null;
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;
    return (endTime - startTime) / 60000;
}

function oppositeDirection(signal) {
    return signal === "BUY" ? "bearish" : "bullish";
}

function determineAlignment(signal, h1Trend, h4Trend) {
    const desired = signal === "BUY" ? "bullish" : "bearish";
    const h1Aligned = h1Trend === desired;
    const h4Aligned = h4Trend === desired;
    if (h1Aligned && h4Aligned) return "full";
    if (h1Aligned || h4Aligned) return "partial";
    return "divergent";
}

function summarizeArray(values) {
    const filtered = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
    if (!filtered.length) return null;
    const sum = filtered.reduce((acc, val) => acc + val, 0);
    const avg = sum / filtered.length;
    const min = Math.min(...filtered);
    const max = Math.max(...filtered);
    return {
        samples: filtered.length,
        average: Number(avg.toFixed(4)),
        min: Number(min.toFixed(4)),
        max: Number(max.toFixed(4)),
    };
}

function calculateTradeParameters(signal, symbol, entryPrice, candle, balance) {
    if (!candle) return null;
    const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
    const spread = pip; // assume 1 pip spread for backtest
    const buffer = 2 * pip;
    const candleSize = Math.max((candle.high ?? entryPrice) - (candle.low ?? entryPrice), pip);
    const slBuffer = candleSize * 0.25 + spread + buffer;

    let stopLossPrice;
    let takeProfitPrice;
    if (signal === "BUY") {
        stopLossPrice = (candle.low ?? entryPrice) - slBuffer;
        const riskDistance = entryPrice - stopLossPrice;
        takeProfitPrice = entryPrice + riskDistance * 1.5;
    } else {
        stopLossPrice = (candle.high ?? entryPrice) + slBuffer;
        const riskDistance = stopLossPrice - entryPrice;
        takeProfitPrice = entryPrice - riskDistance * 1.5;
    }

    const stopDistance = Math.abs(entryPrice - stopLossPrice);
    if (!stopDistance) return null;

    const riskPerPosition = (balance * RISK.PER_TRADE) / RISK.MAX_POSITIONS;
    const rr = Math.abs(takeProfitPrice - entryPrice) / stopDistance;

    return {
        price: roundPrice(entryPrice, symbol),
        stopLossPrice: roundPrice(stopLossPrice, symbol),
        takeProfitPrice: roundPrice(takeProfitPrice, symbol),
        rr: Number(rr.toFixed(2)),
        risk: Number(riskPerPosition.toFixed(2)),
        slPips: Number((stopDistance / pip).toFixed(2)),
    };
}

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
    const percent = peakValue ? (maxDrop / peakValue) * 100 : 0;
    return {
        absolute: Number(maxDrop.toFixed(2)),
        percent: Number(percent.toFixed(2)),
    };
}

function simulateTradeResultDetailed(futureContexts, params, signal, entryTime) {
    const opposite = oppositeDirection(signal);
    for (const ctx of futureContexts) {
        const candle = ctx?.M5;
        if (!candle) continue;
        const timestamp = candle.timestamp;
        if (!timestamp) continue;

        if (signal === "BUY") {
            if (candle.low <= params.stopLossPrice) {
                return { outcome: "LOSS", reason: "stop_loss_hit", hitTime: timestamp, durationMin: minutesBetween(entryTime, timestamp) };
            }
            if (candle.high >= params.takeProfitPrice) {
                return { outcome: "WIN", reason: "take_profit_hit", hitTime: timestamp, durationMin: minutesBetween(entryTime, timestamp) };
            }
        } else {
            if (candle.high >= params.stopLossPrice) {
                return { outcome: "LOSS", reason: "stop_loss_hit", hitTime: timestamp, durationMin: minutesBetween(entryTime, timestamp) };
            }
            if (candle.low <= params.takeProfitPrice) {
                return { outcome: "WIN", reason: "take_profit_hit", hitTime: timestamp, durationMin: minutesBetween(entryTime, timestamp) };
            }
        }

        const h1Trend = Strategy.pickTrend(ctx.H1, { symbol: PAIR, timeframe: "H1" });
        const h4Trend = Strategy.pickTrend(ctx.H4, { symbol: PAIR, timeframe: "H4" });
        if (h1Trend === opposite && h4Trend === opposite) {
            return { outcome: "LOSS", reason: "trend_change_exit", hitTime: timestamp, durationMin: minutesBetween(entryTime, timestamp) };
        }

        const heldMinutes = minutesBetween(entryTime, timestamp);
        if (heldMinutes != null && heldMinutes >= RISK.MAX_HOLD_TIME) {
            return { outcome: "LOSS", reason: "soft_exit_timeout", hitTime: timestamp, durationMin: heldMinutes };
        }
    }

    const fallbackTime = futureContexts.at(-1)?.M5?.timestamp ?? null;
    return { outcome: "LOSS", reason: "soft_exit_timeout", hitTime: fallbackTime, durationMin: minutesBetween(entryTime, fallbackTime) };
}

function analyzeStructure(records) {
    const fieldCounts = {};
    const missingCounts = {};
    const firstRow = records[0] ?? {};
    const structure = {
        totalRows: records.length,
        timerange: {
            start: firstRow?.time ?? null,
            end: records[records.length - 1]?.time ?? null,
        },
        uniqueM5: 0,
    };

    const seenM5 = new Set();
    for (const tf of TIMEFRAMES) {
        missingCounts[tf] = 0;
    }

    for (const row of records) {
        for (const tf of TIMEFRAMES) {
            const obj = row?.[tf];
            if (!obj) {
                missingCounts[tf]++;
                continue;
            }
            if (!fieldCounts[tf]) {
                fieldCounts[tf] = Object.keys(obj).length;
            }
        }
        const m5Ts = row?.M5?.timestamp;
        if (m5Ts) {
            seenM5.add(m5Ts);
        }
    }
    structure.uniqueM5 = seenM5.size;
    structure.fieldsPerTimeframe = fieldCounts;
    structure.missingPerTimeframe = missingCounts;
    return structure;
}

async function loadDataset(filePath) {
    const records = [];
    const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            records.push(JSON.parse(trimmed));
        } catch (_err) {
            // skip malformed line
        }
    }
    return records;
}

function collectVolatilityStats(entryCandle, indicators, volatilityStats, entryPrice) {
    if (indicators.m5?.atr) volatilityStats.m5.push(indicators.m5.atr);
    if (indicators.m15?.atr) volatilityStats.m15.push(indicators.m15.atr);
    if (indicators.h1?.atr) volatilityStats.h1.push(indicators.h1.atr);
    if (indicators.h4?.atr) volatilityStats.h4.push(indicators.h4.atr);
    const referenceEntry = entryPrice ?? entryCandle?.close ?? entryCandle?.open ?? 0;
    const candleRange = (entryCandle?.high ?? referenceEntry) - (entryCandle?.low ?? referenceEntry);
    if (!Number.isNaN(candleRange)) volatilityStats.range.push(candleRange);
}

function prepareWeaknesses(stats) {
    const weaknesses = [];
    if (!stats.trades && stats.rejectionReasons.tf_misaligned) {
        weaknesses.push({
            issue: "Strategy never entered a trade on EURJPY",
            evidence: `${stats.rejectionReasons.tf_misaligned} opportunities rejected for timeframe misalignment`,
            interpretation: "Current EMA gap requirement keeps both M5 and M15 in 'neutral' for this pair.",
        });
        return weaknesses;
    }
    const totalLosses = stats.losses || 1;
    const stopShare = (stats.lossReasons.stop_loss_hit || 0) / totalLosses;
    if (stopShare > 0.45) {
        weaknesses.push({
            issue: "Stops are hit before price reaches targets",
            evidence: `${(stopShare * 100).toFixed(1)}% of losses triggered at stop_loss`,
            interpretation: "SL buffer may be too tight for EURJPY volatility or entries occur after exhaustion.",
        });
    }
    const trendShare = (stats.lossReasons.trend_change_exit || 0) / totalLosses;
    if (trendShare > 0.15) {
        weaknesses.push({
            issue: "Trend flips invalidate trades shortly after entry",
            evidence: `${(trendShare * 100).toFixed(1)}% of losses caused by trend_change_exit`,
            interpretation: "Need stronger H1/H4 confirmation before committing.",
        });
    }
    const timeoutShare = (stats.lossReasons.soft_exit_timeout || 0) / totalLosses;
    if (timeoutShare > 0.1) {
        weaknesses.push({
            issue: "Trades frequently stall without reaching TP",
            evidence: `${(timeoutShare * 100).toFixed(1)}% of losses exit via soft timeout`,
            interpretation: "Entry timing or RR may not match pair's structure.",
        });
    }
    const divergentShare = stats.alignment.divergent.trades ? stats.alignment.divergent.trades / stats.trades : 0;
    if (divergentShare > 0.15) {
        weaknesses.push({
            issue: "Entries taken against higher timeframe direction",
            evidence: `${(divergentShare * 100).toFixed(1)}% of trades ignored H1/H4 alignment`,
            interpretation: "Needs stricter top-down alignment rules.",
        });
    }
    return weaknesses;
}

function buildRecommendations(stats) {
    const recs = [];
    if (!stats.trades && stats.rejectionReasons.tf_misaligned) {
        recs.push({
            timeframe: "H1",
            suggestion: "Allow neutral H1 trend when EMA slopes support the M5 direction.",
            rationale: "All sampled candles show H1 EMA gaps below the 10% threshold, so filter blocks every setup.",
        });
        recs.push({
            timeframe: "H4",
            suggestion: "Switch to slope-based confirmation on H4 instead of large absolute EMA gap.",
            rationale: "H4 EMA differences stay within 0.3 yen, never clearing the current ~17 pip requirement.",
        });
    }
    const alignment = stats.alignment;
    const fullWinRate = alignment.full.trades ? alignment.full.wins / alignment.full.trades : 0;
    const divergentWinRate = alignment.divergent.trades ? alignment.divergent.wins / alignment.divergent.trades : 0;
    if (fullWinRate > divergentWinRate) {
        recs.push({
            timeframe: "H1/H4",
            suggestion: "Require EMA alignment with entry direction before allowing new trades.",
            rationale: `Full alignment win rate ${(fullWinRate * 100).toFixed(1)}% vs ${(divergentWinRate * 100).toFixed(1)}% when divergent.`,
        });
    }
    if ((stats.rejectionReasons.tf_misaligned || 0) > (stats.trades * 0.2)) {
        recs.push({
            timeframe: "M5/M15",
            suggestion: "Reduce EMA gap requirement for JPY pairs to avoid excessive TF misalignment rejections.",
            rationale: `tf_misaligned prevented ${(stats.rejectionReasons.tf_misaligned || 0)} setups, dominating missed signals.`,
        });
    }
    if ((stats.rejectionReasons.low_volume || 0) > 0) {
        recs.push({
            timeframe: "M5",
            suggestion: "Blend candle structure with relative volume instead of hard 20% drop filter.",
            rationale: "Low volume filter skipped trades even in quiet Asian sessions for EURJPY.",
        });
    }
    if ((stats.lossReasons.stop_loss_hit || 0) > (stats.losses * 0.4)) {
        recs.push({
            timeframe: "Pair-specific",
            suggestion: "Widen SL buffer or incorporate ATR multiplier tuned for JPY volatility.",
            rationale: "Stop-loss hits account for majority of losses; ATR median indicates higher noise.",
        });
    }
    return recs;
}

function deriveHigherTimeframeInsights(stats) {
    const toPct = (part, total) => (total ? Number(((part / total) * 100).toFixed(2)) : 0);
    return {
        h1: {
            trades: stats.alignment.partial.trades + stats.alignment.full.trades,
            fullAlignmentWinRate: toPct(stats.alignment.full.wins, stats.alignment.full.trades),
        },
        h4: {
            partialWinRate: toPct(stats.alignment.partial.wins, stats.alignment.partial.trades),
            divergentShare: toPct(stats.alignment.divergent.trades, stats.trades),
        },
        filteredReasons: {
            tf_misaligned: stats.rejectionReasons.tf_misaligned || 0,
            h1_filter_blocked: stats.rejectionReasons.h1_filter_blocked || 0,
        },
    };
}

function buildResultPayload(structure, stats, trades, balance, equityCurve) {
    const profitFactor = stats.grossLoss > 0 ? stats.grossProfit / stats.grossLoss : null;
    const avgHold =
        stats.holdDurations.length > 0
            ? stats.holdDurations.reduce((sum, val) => sum + val, 0) / stats.holdDurations.length
            : 0;
    const drawdown = calculateMaxDrawdown(equityCurve);
    const patternSummary = Object.entries(stats.patternOutcomes).reduce((acc, [pattern, info]) => {
        acc[pattern] = {
            trades: info.trades,
            winRate: info.trades ? Number(((info.wins / info.trades) * 100).toFixed(2)) : 0,
        };
        return acc;
    }, {});
    const alignmentSummary = Object.entries(stats.alignment).reduce((acc, [key, info]) => {
        acc[key] = {
            trades: info.trades,
            wins: info.wins,
            winRate: info.trades ? Number(((info.wins / info.trades) * 100).toFixed(2)) : 0,
        };
        return acc;
    }, {});

    const tradeSamples = trades.slice(0, 5).map((trade) => ({
        time: trade.time,
        signal: trade.signal,
        outcome: trade.outcome,
        reason: trade.exitReason,
        rr: trade.rr,
        durationMin: trade.durationMin,
    }));

    const bestTrade = trades.reduce((best, trade) => {
        if (!best) return trade;
        return trade.outcome === "WIN" && trade.reward > (best.reward || 0) ? trade : best;
    }, null);
    const worstTrade = trades.reduce((worst, trade) => {
        if (!worst) return trade;
        return trade.outcome === "LOSS" && trade.risk > (worst.risk || 0) ? trade : worst;
    }, null);

    return {
        pair: PAIR,
        dataset: structure,
        performance: {
            trades: stats.trades,
            wins: stats.wins,
            losses: stats.losses,
            winRate: stats.trades ? Number(((stats.wins / stats.trades) * 100).toFixed(2)) : 0,
            finalBalance: Number(balance.toFixed(2)),
            startingBalance: START_BALANCE,
            grossProfit: Number(stats.grossProfit.toFixed(2)),
            grossLoss: Number(stats.grossLoss.toFixed(2)),
            profitFactor: profitFactor != null ? Number(profitFactor.toFixed(2)) : null,
            avgHoldMinutes: Number(avgHold.toFixed(2)),
            closureReasons: stats.closureReasons,
            directionSplit: stats.directionCounts,
            rejectionReasons: stats.rejectionReasons,
            patternSummary,
            higherTimeframeAlignment: alignmentSummary,
            maxDrawdown: drawdown,
            volatility: {
                m5Atr: summarizeArray(stats.volatility.m5),
                m15Atr: summarizeArray(stats.volatility.m15),
                h1Atr: summarizeArray(stats.volatility.h1),
                h4Atr: summarizeArray(stats.volatility.h4),
                entryRange: summarizeArray(stats.volatility.range),
            },
        },
        tradeSamples,
        notableTrades: {
            best: bestTrade,
            worst: worstTrade,
        },
    };
}

function buildImprovementsPayload(structure, stats, higherTfInsights) {
    const weaknesses = prepareWeaknesses(stats);
    const recommendations = buildRecommendations(stats);

    return {
        pair: PAIR,
        summary: {
            tradesAnalyzed: stats.trades,
            closureReasons: stats.closureReasons,
            missedTrades: stats.rejectionReasons,
            higherTimeframeInsights: higherTfInsights,
        },
        strategyWeaknesses: weaknesses,
        missedTradeReasons: Object.entries(stats.rejectionReasons).map(([reason, count]) => ({
            reason,
            count,
        })),
        missedTradeSamples: stats.rejectionSamples,
        recommendations,
        higherTimeframePatterns: {
            profitableAlignment: higherTfInsights,
            filteredSignals: higherTfInsights.filteredReasons,
        },
        keepPairDecision: {
            keep: stats.finalBalance > START_BALANCE && stats.winRate >= 45,
            rationale:
                stats.finalBalance > START_BALANCE
                    ? "Equity ended above starting balance; focus on filtering divergent trades."
                    : "Net performance negative; remove until alignment filters added.",
        },
        structureNotes: structure,
    };
}

function initializeStats() {
    return {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        finalBalance: START_BALANCE,
        grossProfit: 0,
        grossLoss: 0,
        closureReasons: {},
        rejectionReasons: {},
        rejectionSamples: {},
        directionCounts: { BUY: 0, SELL: 0 },
        patternOutcomes: {},
        alignment: {
            full: { trades: 0, wins: 0 },
            partial: { trades: 0, wins: 0 },
            divergent: { trades: 0, wins: 0 },
        },
        holdDurations: [],
        lossReasons: {},
        volatility: { m5: [], m15: [], h1: [], h4: [], range: [] },
    };
}

async function run() {
    const dataset = await loadDataset(INPUT_FILE);
    if (!dataset.length) {
        throw new Error(`No data found at ${INPUT_FILE}`);
    }

    const structure = analyzeStructure(dataset);
    const m5Buffer = [];
    const m15Buffer = [];
    const h1Buffer = [];
    const h4Buffer = [];

    const stats = initializeStats();
    const trades = [];
    const equityCurve = [START_BALANCE];
    let balance = START_BALANCE;

    for (let idx = 0; idx < dataset.length; idx++) {
        const row = dataset[idx];
        const { M1, M5, M15, H1, H4 } = row;
        if (!M5 || !M15 || !H1 || !H4) continue;

        const m5Updated = pushUnique(m5Buffer, M5);
        pushUnique(m15Buffer, M15);
        pushUnique(h1Buffer, H1);
        pushUnique(h4Buffer, H4);

        if (!m5Updated) continue;
        if (m5Buffer.length < MIN_BARS || m15Buffer.length < MIN_BARS || h1Buffer.length < MIN_BARS || h4Buffer.length < MIN_BARS) {
            continue;
        }

        const indicators = { m1: M1, m5: M5, m15: M15, h1: H1, h4: H4 };
        const candles = {
            m5Candles: m5Buffer.slice(),
            m15Candles: m15Buffer.slice(),
            h1Candles: h1Buffer.slice(),
            h4Candles: h4Buffer.slice(),
            m1Candles: M1 ? [M1] : [],
        };

        const result = Strategy.getSignal({ symbol: PAIR, indicators, candles });
        if (!result?.signal) {
            const reason = result?.reason || "no_signal";
            stats.rejectionReasons[reason] = (stats.rejectionReasons[reason] || 0) + 1;
            if (!stats.rejectionSamples[reason]) {
                stats.rejectionSamples[reason] = [];
            }
            if (stats.rejectionSamples[reason].length < 5) {
                stats.rejectionSamples[reason].push({
                    time: M5.timestamp,
                    m5Trend: Strategy.pickTrend(indicators.m5, { symbol: PAIR, timeframe: "M5" }),
                    m15Trend: Strategy.pickTrend(indicators.m15, { symbol: PAIR, timeframe: "M15" }),
                    h1Trend: Strategy.pickTrend(indicators.h1, { symbol: PAIR, timeframe: "H1" }),
                    h4Trend: Strategy.pickTrend(indicators.h4, { symbol: PAIR, timeframe: "H4" }),
                    details: result?.context || null,
                });
            }
            continue;
        }

        const entryCandle = candles.m5Candles[candles.m5Candles.length - 1];
        const entryPrice = entryCandle?.close ?? entryCandle?.open;
        if (!entryPrice) continue;

        const params = calculateTradeParameters(result.signal, PAIR, entryPrice, entryCandle, balance);
        if (!params) continue;

        const futureContexts = buildFutureContexts(dataset, idx, LOOKAHEAD);
        if (futureContexts.length < 2) continue;

        const entryTrends = {
            m5Trend: result.context?.m5Trend ?? Strategy.pickTrend(indicators.m5, { symbol: PAIR, timeframe: "M5" }),
            m15Trend: result.context?.m15Trend ?? Strategy.pickTrend(indicators.m15, { symbol: PAIR, timeframe: "M15" }),
            h1Trend: result.context?.h1Trend ?? Strategy.pickTrend(indicators.h1, { symbol: PAIR, timeframe: "H1" }),
            h4Trend: Strategy.pickTrend(indicators.h4, { symbol: PAIR, timeframe: "H4" }),
        };

        const simResult = simulateTradeResultDetailed(futureContexts, params, result.signal, entryCandle.timestamp);

        stats.trades++;
        stats.directionCounts[result.signal] = (stats.directionCounts[result.signal] || 0) + 1;
        stats.closureReasons[simResult.reason] = (stats.closureReasons[simResult.reason] || 0) + 1;
        if (simResult.outcome === "LOSS") {
            stats.lossReasons[simResult.reason] = (stats.lossReasons[simResult.reason] || 0) + 1;
        }

        const rr = params.rr;
        const risk = params.risk;
        const reward = risk * rr;

        if (simResult.outcome === "WIN") {
            balance += reward;
            stats.grossProfit += reward;
            stats.wins++;
        } else {
            balance -= risk;
            stats.grossLoss += risk;
            stats.losses++;
        }

        balance = Number(balance.toFixed(2));
        equityCurve.push(balance);
        if (simResult.durationMin != null) {
            stats.holdDurations.push(simResult.durationMin);
        }

        const pattern = result.context?.pattern || result.context?.engulfing || result.context?.pinBar || "indecision";
        if (!stats.patternOutcomes[pattern]) {
            stats.patternOutcomes[pattern] = { trades: 0, wins: 0 };
        }
        stats.patternOutcomes[pattern].trades++;
        if (simResult.outcome === "WIN") {
            stats.patternOutcomes[pattern].wins++;
        }

        const alignKey = determineAlignment(result.signal, entryTrends.h1Trend, entryTrends.h4Trend);
        stats.alignment[alignKey].trades++;
        if (simResult.outcome === "WIN") {
            stats.alignment[alignKey].wins++;
        }

        const tradeRecord = {
            time: entryCandle.timestamp,
            signal: result.signal,
            entry: params.price,
            entryHigh: entryCandle.high,
            entryLow: entryCandle.low,
            stopLoss: params.stopLossPrice,
            takeProfit: params.takeProfitPrice,
            rr,
            risk: Number(risk.toFixed(2)),
            reward: Number(reward.toFixed(2)),
            outcome: simResult.outcome,
            exitReason: simResult.reason,
            exitTime: simResult.hitTime,
            durationMin: simResult.durationMin,
            entryTrends,
            pattern,
        };
        trades.push(tradeRecord);
        collectVolatilityStats(entryCandle, indicators, stats.volatility, entryPrice);
    }

    stats.finalBalance = balance;
    stats.winRate = stats.trades ? (stats.wins / stats.trades) * 100 : 0;

    const higherTfInsights = deriveHigherTimeframeInsights(stats);
    const resultPayload = buildResultPayload(structure, stats, trades, balance, equityCurve);
    const improvementsPayload = buildImprovementsPayload(structure, stats, higherTfInsights);

    fs.writeFileSync(RESULT_FILE, JSON.stringify(resultPayload, null, 2));
    fs.writeFileSync(IMPROVEMENTS_FILE, JSON.stringify(improvementsPayload, null, 2));

    console.log(`Saved ${RESULT_FILE} and ${IMPROVEMENTS_FILE}`);
}

run().catch((err) => {
    console.error("[singlePairAnalyzer] Failed:", err);
    process.exit(1);
});
