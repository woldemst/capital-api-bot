import { MetricsAccumulator } from "./simulator.js";
import { trendOpposite, getSessionInfo } from "./helpers.js";

export function buildOverallMetrics(allTrades) {
    const acc = new MetricsAccumulator();
    allTrades.forEach((trade) => acc.add(trade));
    return acc.finalize();
}

function bucketize(value, thresholds) {
    if (value == null) return "unknown";
    const [low, high] = thresholds;
    if (value < low) return "low";
    if (value > high) return "high";
    return "mid";
}

export function analyzePatterns(trades) {
    const summary = {
        h1Trend: { aligned: { wins: 0, total: 0 }, counter: { wins: 0, total: 0 } },
        m15Trend: { aligned: { wins: 0, total: 0 }, counter: { wins: 0, total: 0 } },
        h1RSI: { low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 } },
        m15RSI: { low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 } },
        h1ATR: { low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 } },
        sessions: {},
        softExit: { triggered: 0, saved: 0 },
        pairNuances: {},
    };

    trades.forEach((trade) => {
        const win = trade.rMultiple > 0;
        const h1TrendAligned = !trendOpposite(trade.direction, trade.entryH1?.trend);
        const m15TrendAligned = !trendOpposite(trade.direction, trade.entryM15?.trend);

        const updateBucket = (bucket, key) => {
            const node = bucket[key];
            if (!node) return;
            node.total += 1;
            if (win) node.wins += 1;
        };

        updateBucket(summary.h1Trend, h1TrendAligned ? "aligned" : "counter");
        updateBucket(summary.m15Trend, m15TrendAligned ? "aligned" : "counter");

        const h1RsiBucket = bucketize(trade.entryH1?.rsi, [45, 60]);
        const m15RsiBucket = bucketize(trade.entryM15?.rsi, [45, 60]);
        updateBucket(summary.h1RSI, h1RsiBucket);
        updateBucket(summary.m15RSI, m15RsiBucket);

        const atrPips = trade.entryH1?.atr && trade.pipSize ? trade.entryH1.atr / trade.pipSize : null;
        const atrBucket = bucketize(atrPips, [5, 12]);
        updateBucket(summary.h1ATR, atrBucket);

        const session = getSessionInfo(trade.entryTime).session || "unknown";
        if (!summary.sessions[session]) {
            summary.sessions[session] = { wins: 0, total: 0 };
        }
        summary.sessions[session].total += 1;
        if (win) summary.sessions[session].wins += 1;

        if (!summary.pairNuances[trade.symbol]) {
            summary.pairNuances[trade.symbol] = { wins: 0, total: 0, asia: 0, london: 0, ny: 0 };
        }
        summary.pairNuances[trade.symbol].total += 1;
        if (win) summary.pairNuances[trade.symbol].wins += 1;
        if (session === "asia") summary.pairNuances[trade.symbol].asia += 1;
        if (session === "london") summary.pairNuances[trade.symbol].london += 1;
        if (session === "new_york") summary.pairNuances[trade.symbol].ny += 1;

        if (trade.exitReason === "soft_exit") {
            summary.softExit.triggered += 1;
            if (trade.softExitSaved) summary.softExit.saved += 1;
        }
    });

    const computeWinRate = (node) => {
        if (!node || !node.total) return 0;
        return Number(((node.wins / node.total) * 100).toFixed(2));
    };

    const formatBuckets = (bucket) =>
        Object.entries(bucket).reduce((acc, [key, value]) => {
            acc[key] = { winRate: computeWinRate(value), trades: value.total };
            return acc;
        }, {});

    return {
        h1Trend: formatBuckets(summary.h1Trend),
        m15Trend: formatBuckets(summary.m15Trend),
        h1RSI: formatBuckets(summary.h1RSI),
        m15RSI: formatBuckets(summary.m15RSI),
        h1ATR: formatBuckets(summary.h1ATR),
        sessions: formatBuckets(summary.sessions),
        softExit: {
            triggered: summary.softExit.triggered,
            saved: summary.softExit.saved,
            saveRate: summary.softExit.triggered
                ? Number(((summary.softExit.saved / summary.softExit.triggered) * 100).toFixed(2))
                : null,
        },
        pairNuances: Object.entries(summary.pairNuances).reduce((acc, [pair, stats]) => {
            acc[pair] = {
                winRate: stats.total ? Number(((stats.wins / stats.total) * 100).toFixed(2)) : 0,
                trades: stats.total,
                sessionBias: {
                    asia: stats.asia,
                    london: stats.london,
                    new_york: stats.ny,
                },
            };
            return acc;
        }, {}),
    };
}

export function buildSummaryJson({ runId, perPairResults, overallMetrics, patternInsights }) {
    const symbols = perPairResults.map((entry) => ({
        symbol: entry.pair,
        configId: entry.configId,
        metrics: entry.metrics,
        rejections: entry.rejections,
    }));
    return {
        runId,
        generatedAt: new Date().toISOString(),
        symbols,
        overall: overallMetrics,
        patterns: patternInsights,
    };
}
