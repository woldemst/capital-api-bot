import fs from "node:fs";
import path from "node:path";

import { runReplayBacktest } from "../intraday/step7ReviewBacktest.js";
import { CRYPTO_SYMBOLS, SESSION_SYMBOLS } from "../intraday/config.js";

const REPORT_DIR = path.join(process.cwd(), "backtest", "reports", "intraday7");
const PRICE_DIR = path.join(process.cwd(), "backtest", "prices");

const TARGET_UNIVERSE = new Set([...Object.values(SESSION_SYMBOLS).flat(), ...CRYPTO_SYMBOLS].map((s) => String(s).toUpperCase()));

const VARIANTS = [
    {
        strategyId: "INTRADAY7_DEFAULT",
        label: "Default 7-step config",
        config: {},
    },
    {
        strategyId: "INTRADAY7_RESEARCH_A",
        label: "Balanced relaxed trigger",
        config: {
            guardrails: { maxTradesPerDay: 15 },
            context: { adxTrendMin: 16, adxRangeMax: 22 },
            setup: { trendPullbackZonePct: 0.003, trendRsiMin: 28, trendRsiMax: 72 },
            trigger: { displacementAtrMultiplier: 0.5, requireDisplacement: false, requireStructureBreak: true },
            risk: { rr: 1.8 },
        },
    },
    {
        strategyId: "INTRADAY7_RESEARCH_B",
        label: "Aggressive permissive",
        config: {
            guardrails: { maxTradesPerDay: 15 },
            context: { adxTrendMin: 14, adxRangeMax: 24 },
            setup: { trendPullbackZonePct: 0.006, trendRsiMin: 22, trendRsiMax: 78 },
            trigger: { displacementAtrMultiplier: 0.3, requireDisplacement: false, requireStructureBreak: false },
            risk: { rr: 1.4 },
        },
    },
    {
        strategyId: "INTRADAY7_RESEARCH_C",
        label: "Stricter trend quality",
        config: {
            guardrails: { maxTradesPerDay: 15 },
            context: { adxTrendMin: 18, adxRangeMax: 20 },
            setup: { trendPullbackZonePct: 0.002, trendRsiMin: 30, trendRsiMax: 70 },
            trigger: { displacementAtrMultiplier: 0.7, requireDisplacement: true, requireStructureBreak: true },
            risk: { rr: 2.0 },
        },
    },
];

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
    if (!values.length) return null;
    const arr = [...values].sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function sum(values) {
    let s = 0;
    for (const v of values) s += v;
    return s;
}

function formatPct(x, digits = 2) {
    return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "n/a";
}

function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

function parseReasonValue(reasons, prefix) {
    if (!Array.isArray(reasons)) return null;
    const hit = reasons.find((r) => typeof r === "string" && r.startsWith(prefix));
    if (!hit) return null;
    return hit.slice(prefix.length);
}

function hasReason(reasons, exact) {
    return Array.isArray(reasons) && reasons.includes(exact);
}

function parseTradeLine(obj) {
    const entryTs = String(obj.entryTimestamp || "");
    const tsMs = Date.parse(entryTs);
    const hourUtc = Number.isFinite(tsMs) ? new Date(tsMs).getUTCHours() : null;
    const reasons = Array.isArray(obj.reasons) ? obj.reasons : [];
    const pnl = toNum(obj.pnl);
    const rMultiple = toNum(obj.rMultiple);
    const spreadOnEntry = toNum(obj.spreadOnEntry);
    const entryPrice = toNum(obj.entryPrice);
    const spreadBps = Number.isFinite(spreadOnEntry) && Number.isFinite(entryPrice) && entryPrice !== 0 ? (spreadOnEntry / entryPrice) * 10000 : null;

    return {
        strategyId: obj.strategyId,
        tradeId: obj.tradeId,
        symbol: String(obj.symbol || "").toUpperCase(),
        side: String(obj.side || "").toUpperCase(),
        entryTimestamp: entryTs,
        exitTimestamp: String(obj.exitTimestamp || ""),
        entryTsMs: tsMs,
        hourUtc,
        day: Number.isFinite(tsMs) ? new Date(tsMs).toISOString().slice(0, 10) : null,
        closeReason: String(obj.closeReason || "unknown"),
        pnl,
        pnlPct: toNum(obj.pnlPct),
        rMultiple,
        regimeType: String(obj?.regime?.type || "UNKNOWN"),
        regimeScore: toNum(obj?.regime?.score),
        setupType: String(obj?.setup?.type || "NONE"),
        setupScore: toNum(obj?.setup?.score),
        triggerScore: toNum(obj?.trigger?.score),
        session: parseReasonValue(reasons, "session=") || "UNKNOWN",
        overlap: parseReasonValue(reasons, "overlap=") || null,
        emaSet: parseReasonValue(reasons, "ema_set=") || null,
        volRegime: parseReasonValue(reasons, "vol=") || null,
        stopSource: hasReason(reasons, "stop_from_atr")
            ? "ATR"
            : hasReason(reasons, "stop_from_spread")
              ? "SPREAD"
              : hasReason(reasons, "stop_from_min_pct")
                ? "MIN_PCT"
                : "UNKNOWN",
        hasFvg: hasReason(reasons, "fvg_detected"),
        hasDisplacement: hasReason(reasons, "displacement_candle"),
        hasStructureBreak: hasReason(reasons, "minor_structure_break"),
        newsWindowActive: Boolean(obj?.newsFlags?.newsWindowActive),
        spreadBps,
        isWin: Number.isFinite(pnl) ? pnl > 0 : false,
        isLoss: Number.isFinite(pnl) ? pnl < 0 : false,
    };
}

function loadTradesForStrategy(strategyId) {
    const filePath = path.join(REPORT_DIR, `${strategyId}-trades.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    const trades = [];
    for (const line of lines) {
        try {
            trades.push(parseTradeLine(JSON.parse(line)));
        } catch {
            // Ignore malformed line.
        }
    }
    return trades;
}

function stats(trades) {
    const count = trades.length;
    const pnlVals = trades.map((t) => t.pnl).filter(Number.isFinite);
    const rVals = trades.map((t) => t.rMultiple).filter(Number.isFinite);
    const wins = trades.filter((t) => t.isWin).length;
    const losses = trades.filter((t) => t.isLoss).length;
    const grossProfit = sum(trades.map((t) => (Number.isFinite(t.pnl) && t.pnl > 0 ? t.pnl : 0)));
    const grossLossAbs = Math.abs(sum(trades.map((t) => (Number.isFinite(t.pnl) && t.pnl < 0 ? t.pnl : 0))));
    return {
        count,
        wins,
        losses,
        winRate: count ? wins / count : null,
        netPnl: pnlVals.length ? sum(pnlVals) : null,
        profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : null,
        avgR: rVals.length ? mean(rVals) : null,
        medianR: median(rVals),
        avgSpreadBps: mean(trades.map((t) => t.spreadBps).filter(Number.isFinite)),
    };
}

function groupStats(trades, keyFn, { minCount = 1 } = {}) {
    return [...groupBy(trades, keyFn).entries()]
        .map(([key, rows]) => ({ key, ...stats(rows) }))
        .filter((row) => row.count >= minCount)
        .sort((a, b) => {
            const byPf = (b.profitFactor ?? -Infinity) - (a.profitFactor ?? -Infinity);
            if (byPf !== 0) return byPf;
            const byAvgR = (b.avgR ?? -Infinity) - (a.avgR ?? -Infinity);
            if (byAvgR !== 0) return byAvgR;
            const byNet = (b.netPnl ?? -Infinity) - (a.netPnl ?? -Infinity);
            if (byNet !== 0) return byNet;
            return b.count - a.count;
        });
}

function readVariantReports() {
    const files = fs.existsSync(REPORT_DIR) ? fs.readdirSync(REPORT_DIR) : [];
    return files
        .filter((f) => f.startsWith("backtest-") && f.endsWith(".json"))
        .map((f) => {
            const data = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), "utf8"));
            return {
                strategyId: data.strategyId,
                reportPath: path.join(REPORT_DIR, f),
                metrics: data.metrics,
                bySymbol: data.bySymbol,
            };
        });
}

function rankVariants(reports) {
    return [...reports].sort((a, b) => {
        const aM = a.metrics || {};
        const bM = b.metrics || {};
        const byPf = (bM.profitFactor ?? -Infinity) - (aM.profitFactor ?? -Infinity);
        if (byPf !== 0) return byPf;
        const byNet = (bM.netPnl ?? -Infinity) - (aM.netPnl ?? -Infinity);
        if (byNet !== 0) return byNet;
        const byDd = (aM.maxDrawdown ?? 0) - (bM.maxDrawdown ?? 0);
        if (byDd !== 0) return byDd;
        return (bM.tradeCount ?? 0) - (aM.tradeCount ?? 0);
    });
}

function formatNum(x, digits = 2) {
    return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

function summarizeBestVariant(trades) {
    const profitable = (rows) => rows.filter((r) => r.count >= 5);
    const topBySymbol = profitable(groupStats(trades, (t) => t.symbol, { minCount: 5 }));
    const topByHour = profitable(groupStats(trades, (t) => String(t.hourUtc).padStart(2, "0"), { minCount: 3 }));
    const topBySession = profitable(groupStats(trades, (t) => t.session || "UNKNOWN", { minCount: 3 }));
    const topBySetup = profitable(groupStats(trades, (t) => `${t.setupType}|${t.side}`, { minCount: 3 }));
    const topBySymbolHour = profitable(groupStats(trades, (t) => `${t.symbol}@${String(t.hourUtc).padStart(2, "0")}Z`, { minCount: 3 }));
    const topByPattern = profitable(
        groupStats(
            trades,
            (t) =>
                [
                    t.session || "UNKNOWN",
                    t.side,
                    t.hasFvg ? "FVG" : "NO_FVG",
                    t.hasStructureBreak ? "MSB" : "NO_MSB",
                    t.hasDisplacement ? "DISP" : "NO_DISP",
                    t.volRegime || "vol=?",
                    t.stopSource,
                ].join("|"),
            { minCount: 3 },
        ),
    );
    const triggerScoreBins = profitable(
        groupStats(
            trades,
            (t) => {
                const v = toNum(t.triggerScore);
                if (!Number.isFinite(v)) return "null";
                if (v < 0.7) return "<0.70";
                if (v < 0.9) return "0.70-0.89";
                return ">=0.90";
            },
            { minCount: 3 },
        ),
    );
    const regimeScoreBins = profitable(
        groupStats(
            trades,
            (t) => {
                const v = toNum(t.regimeScore);
                if (!Number.isFinite(v)) return "null";
                if (v < 0.7) return "<0.70";
                if (v < 0.9) return "0.70-0.89";
                return ">=0.90";
            },
            { minCount: 3 },
        ),
    );

    return {
        overall: stats(trades),
        topBySymbol,
        topByHour,
        topBySession,
        topBySetup,
        topBySymbolHour,
        topByPattern,
        triggerScoreBins,
        regimeScoreBins,
    };
}

async function runBacktests() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const files = fs
        .readdirSync(PRICE_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .filter((f) => TARGET_UNIVERSE.has(path.basename(f, ".jsonl").toUpperCase()))
        .sort()
        .map((f) => path.join(PRICE_DIR, f));

    const runResults = [];
    for (const variant of VARIANTS) {
        const minuteLogOutputPath = path.join(REPORT_DIR, `${variant.strategyId}-minute.jsonl`);
        const tradeLogOutputPath = path.join(REPORT_DIR, `${variant.strategyId}-trades.jsonl`);
        if (fs.existsSync(minuteLogOutputPath)) fs.unlinkSync(minuteLogOutputPath);
        if (fs.existsSync(tradeLogOutputPath)) fs.unlinkSync(tradeLogOutputPath);

        const { report, reportPath } = await runReplayBacktest({
            strategyId: variant.strategyId,
            config: variant.config,
            priceFiles: files,
            outputDir: REPORT_DIR,
            minuteLogOutputPath,
            tradeLogOutputPath,
            startingEquity: 10000,
        });
        runResults.push({
            strategyId: variant.strategyId,
            label: variant.label,
            reportPath,
            metrics: report.metrics,
        });
    }
    return runResults;
}

function analyzeExistingBacktests() {
    const reports = readVariantReports();
    if (!reports.length) {
        throw new Error(`No backtest reports found in ${REPORT_DIR}`);
    }

    const ranked = rankVariants(reports);
    const bestVariant = ranked[0];
    const bestTrades = loadTradesForStrategy(bestVariant.strategyId);
    const bestSummary = summarizeBestVariant(bestTrades);

    const analysisReport = {
        generatedAt: new Date().toISOString(),
        scope: {
            source: "backtest/prices/*.jsonl",
            universe: [...TARGET_UNIVERSE].sort(),
            note: "Replay backtest on minute snapshots with intraday 7-step engine, SL/TP fill check on M1 bars when available.",
        },
        variants: ranked.map((r) => ({
            strategyId: r.strategyId,
            metrics: r.metrics,
            reportPath: r.reportPath,
        })),
        bestVariant: {
            strategyId: bestVariant.strategyId,
            metrics: bestVariant.metrics,
            tradeCount: bestTrades.length,
            patterns: bestSummary,
        },
    };

    const outPath = path.join(REPORT_DIR, "intraday7-research-analysis.json");
    fs.writeFileSync(outPath, JSON.stringify(analysisReport, null, 2));
    return { analysisReport, outPath };
}

function printSummary(analysisReport, outPath) {
    console.log("=== Intraday 7-Step Replay Research ===");
    console.log("Variant ranking:");
    for (const v of analysisReport.variants) {
        const m = v.metrics || {};
        console.log(
            `- ${v.strategyId}: trades=${m.tradeCount}, winRate=${formatPct(m.winrate)}, PF=${formatNum(m.profitFactor, 2)}, ` +
                `avgR=${formatNum(m.avgR, 3)}, netPnl=${formatNum(m.netPnl, 2)}, maxDD=${formatPct(m.maxDrawdown)}`,
        );
    }

    const best = analysisReport.bestVariant;
    const p = best.patterns;
    console.log("");
    console.log(`Best variant: ${best.strategyId}`);
    console.log(
        `- Overall: trades=${p.overall.count}, winRate=${formatPct(p.overall.winRate)}, PF=${formatNum(p.overall.profitFactor, 2)}, ` +
            `avgR=${formatNum(p.overall.avgR, 3)}, netPnl=${formatNum(p.overall.netPnl, 2)}`,
    );

    console.log("Top symbols (best variant):");
    for (const row of p.topBySymbol.slice(0, 8)) {
        console.log(
            `- ${row.key}: n=${row.count}, winRate=${formatPct(row.winRate)}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, net=${formatNum(row.netPnl, 2)}`,
        );
    }

    console.log("Top sessions:");
    for (const row of p.topBySession.slice(0, 6)) {
        console.log(`- ${row.key}: n=${row.count}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, winRate=${formatPct(row.winRate)}`);
    }

    console.log("Top UTC hours:");
    for (const row of p.topByHour.slice(0, 8)) {
        console.log(`- ${row.key}Z: n=${row.count}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, winRate=${formatPct(row.winRate)}`);
    }

    console.log("Top setup+signal combos:");
    for (const row of p.topBySetup.slice(0, 6)) {
        console.log(`- ${row.key}: n=${row.count}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, net=${formatNum(row.netPnl, 2)}`);
    }

    console.log("Top symbol-hour windows:");
    for (const row of p.topBySymbolHour.slice(0, 12)) {
        console.log(`- ${row.key}: n=${row.count}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, net=${formatNum(row.netPnl, 2)}`);
    }

    console.log("Top condition patterns:");
    for (const row of p.topByPattern.slice(0, 12)) {
        console.log(`- ${row.key}: n=${row.count}, PF=${formatNum(row.profitFactor, 2)}, avgR=${formatNum(row.avgR, 3)}, winRate=${formatPct(row.winRate)}`);
    }

    console.log(`Saved analysis report: ${outPath}`);
}

async function main() {
    const mode = String(process.argv[2] || "run+analyze").toLowerCase();
    if (mode === "run" || mode === "run+analyze") {
        await runBacktests();
    }
    const { analysisReport, outPath } = analyzeExistingBacktests();
    printSummary(analysisReport, outPath);
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});

