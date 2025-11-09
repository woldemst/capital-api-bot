import fs from "fs";
import path from "path";
import { collectPairData } from "./lib/collector.js";
import { buildExperimentGrid, baselineConfig } from "./lib/experimentConfig.js";
import { runSimulationForPair } from "./lib/simulator.js";
import { buildOverallMetrics, analyzePatterns, buildSummaryJson } from "./lib/analyzer.js";
import { formatCsvRow } from "./lib/helpers.js";

const LOG_VERSION = 1;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function listPairs(analysisDir) {
    return fs
        .readdirSync(analysisDir)
        .filter((file) => file.endsWith("_combined.jsonl"))
        .map((file) => file.replace("_combined.jsonl", ""))
        .sort();
}

function isImproved(baseline, candidate) {
    if (!candidate || !candidate.trades) return false;
    const pfBase = baseline.profitFactor ?? 0;
    const pfCand = candidate.profitFactor ?? 0;
    const expBase = baseline.expectancy ?? -Infinity;
    const expCand = candidate.expectancy ?? -Infinity;
    const ddBase = baseline.maxDrawdown?.absolute ?? Infinity;
    const ddCand = candidate.maxDrawdown?.absolute ?? Infinity;
    return pfCand > pfBase && expCand > expBase && ddCand <= ddBase;
}

function buildConfigMap(grid) {
    const map = new Map();
    grid.forEach((cfg) => map.set(cfg.id, cfg));
    map.set(baselineConfig.id, baselineConfig);
    return map;
}

function tradeColumns() {
    return [
        "run_id",
        "version",
        "trade_id",
        "symbol",
        "side",
        "entry_time",
        "entry_price",
        "exit_time",
        "exit_price",
        "sl",
        "tp",
        "exit_reason",
        "risk_reward_at_open",
        "heat_pips",
        "mae_pips",
        "mfe_pips",
        "duration_minutes",
        "profit_pips",
        "r_multiple",
        "soft_exit_saved",
        "soft_exit_outcome",
        "m5_prev_open",
        "m5_prev_high",
        "m5_prev_low",
        "m5_prev_close",
        "m5_prev_volume",
        "m5_last_open",
        "m5_last_high",
        "m5_last_low",
        "m5_last_close",
        "m5_last_volume",
        "m5_close_open",
        "m5_close_high",
        "m5_close_low",
        "m5_close_close",
        "m5_close_volume",
        "m15_ema20",
        "m15_ema50",
        "m15_ema200",
        "m15_rsi",
        "m15_macd_hist",
        "m15_atr",
        "m15_trend",
        "h1_ema20",
        "h1_ema50",
        "h1_ema200",
        "h1_rsi",
        "h1_macd_hist",
        "h1_atr",
        "h1_trend",
        "close_m15_ema20",
        "close_m15_ema50",
        "close_m15_ema200",
        "close_m15_rsi",
        "close_m15_macd_hist",
        "close_m15_atr",
        "close_m15_trend",
        "close_h1_ema20",
        "close_h1_ema50",
        "close_h1_ema200",
        "close_h1_rsi",
        "close_h1_macd_hist",
        "close_h1_atr",
        "close_h1_trend",
    ];
}

function serializeNumber(value, precision = 5) {
    if (typeof value !== "number" || Number.isNaN(value)) return "";
    return Number(value.toFixed(precision));
}

function writeTradesCsv(trades, filePath, runId) {
    ensureDir(path.dirname(filePath));
    const columns = tradeColumns();
    const header = columns.join(",") + "\n";
    const rows = trades
        .map((trade) => {
            const row = {
                run_id: runId,
                version: LOG_VERSION,
                trade_id: trade.tradeId,
                symbol: trade.symbol,
                side: trade.direction,
                entry_time: trade.entryTime,
                entry_price: serializeNumber(trade.entryPrice),
                exit_time: trade.exitTime,
                exit_price: serializeNumber(trade.exitPrice),
                sl: serializeNumber(trade.stopLoss),
                tp: serializeNumber(trade.takeProfit),
                exit_reason: trade.exitReason,
                risk_reward_at_open: serializeNumber(trade.riskRewardAtOpen, 2),
                heat_pips: serializeNumber(trade.heat, 2),
                mae_pips: serializeNumber(trade.mae, 2),
                mfe_pips: serializeNumber(trade.mfe, 2),
                duration_minutes: trade.durationMinutes ?? "",
                profit_pips: serializeNumber(trade.profitPips, 2),
                r_multiple: serializeNumber(trade.rMultiple, 2),
                soft_exit_saved: trade.softExitSaved ? 1 : 0,
                soft_exit_outcome: trade.softExitOutcome || "",
                m5_prev_open: serializeNumber(trade.m5Prev?.open),
                m5_prev_high: serializeNumber(trade.m5Prev?.high),
                m5_prev_low: serializeNumber(trade.m5Prev?.low),
                m5_prev_close: serializeNumber(trade.m5Prev?.close),
                m5_prev_volume: trade.m5Prev?.volume ?? "",
                m5_last_open: serializeNumber(trade.m5Last?.open),
                m5_last_high: serializeNumber(trade.m5Last?.high),
                m5_last_low: serializeNumber(trade.m5Last?.low),
                m5_last_close: serializeNumber(trade.m5Last?.close),
                m5_last_volume: trade.m5Last?.volume ?? "",
                m5_close_open: serializeNumber(trade.closeM5?.open),
                m5_close_high: serializeNumber(trade.closeM5?.high),
                m5_close_low: serializeNumber(trade.closeM5?.low),
                m5_close_close: serializeNumber(trade.closeM5?.close),
                m5_close_volume: trade.closeM5?.volume ?? "",
                m15_ema20: serializeNumber(trade.entryM15?.ema20),
                m15_ema50: serializeNumber(trade.entryM15?.ema50),
                m15_ema200: serializeNumber(trade.entryM15?.ema200),
                m15_rsi: serializeNumber(trade.entryM15?.rsi, 2),
                m15_macd_hist: serializeNumber(trade.entryM15?.macdHist, 4),
                m15_atr: serializeNumber(trade.entryM15?.atr, 5),
                m15_trend: trade.entryM15?.trend || "",
                h1_ema20: serializeNumber(trade.entryH1?.ema20),
                h1_ema50: serializeNumber(trade.entryH1?.ema50),
                h1_ema200: serializeNumber(trade.entryH1?.ema200),
                h1_rsi: serializeNumber(trade.entryH1?.rsi, 2),
                h1_macd_hist: serializeNumber(trade.entryH1?.macdHist, 4),
                h1_atr: serializeNumber(trade.entryH1?.atr, 5),
                h1_trend: trade.entryH1?.trend || "",
                close_m15_ema20: serializeNumber(trade.closeM15?.ema20),
                close_m15_ema50: serializeNumber(trade.closeM15?.ema50),
                close_m15_ema200: serializeNumber(trade.closeM15?.ema200),
                close_m15_rsi: serializeNumber(trade.closeM15?.rsi, 2),
                close_m15_macd_hist: serializeNumber(trade.closeM15?.macdHist, 4),
                close_m15_atr: serializeNumber(trade.closeM15?.atr, 5),
                close_m15_trend: trade.closeM15?.trend || "",
                close_h1_ema20: serializeNumber(trade.closeH1?.ema20),
                close_h1_ema50: serializeNumber(trade.closeH1?.ema50),
                close_h1_ema200: serializeNumber(trade.closeH1?.ema200),
                close_h1_rsi: serializeNumber(trade.closeH1?.rsi, 2),
                close_h1_macd_hist: serializeNumber(trade.closeH1?.macdHist, 4),
                close_h1_atr: serializeNumber(trade.closeH1?.atr, 5),
                close_h1_trend: trade.closeH1?.trend || "",
            };
            return formatCsvRow(columns, row);
        })
        .join("");

    fs.writeFileSync(filePath, header + rows, "utf8");
}

function writeConfigSuggestion(filePath, runId, defaults, overrides) {
    const payload = {
        runId,
        generatedAt: new Date().toISOString(),
        defaults,
        overrides,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function renderPatternsMarkdown(runId, overallMetrics, patternInsights, experimentSummary, nextSteps) {
    const lines = [];
    lines.push(`# Experiment Run ${runId}`);
    lines.push("");
    lines.push(`**Exec Summary**`);
    lines.push(
        `- Trades: ${overallMetrics.trades} | Win% ${overallMetrics.winRate}% | PF ${overallMetrics.profitFactor} | Expectancy ${overallMetrics.expectancy}R | Max DD ${overallMetrics.maxDrawdown.absolute}R`
    );
    lines.push(
        `- Soft exits triggered ${patternInsights.softExit.triggered}, saved ${patternInsights.softExit.saved} (${patternInsights.softExit.saveRate}% avoided SL)`
    );
    lines.push("");
    lines.push(`**Cross-TF Patterns**`);
    lines.push(`- H1 trend aligned win rate: ${patternInsights.h1Trend.aligned?.winRate ?? 0}% vs counter ${patternInsights.h1Trend.counter?.winRate ?? 0}%`);
    lines.push(`- M15 trend aligned win rate: ${patternInsights.m15Trend.aligned?.winRate ?? 0}% vs counter ${patternInsights.m15Trend.counter?.winRate ?? 0}%`);
    lines.push(
        `- H1 RSI bands → Low: ${patternInsights.h1RSI.low?.winRate ?? 0}% | Mid: ${patternInsights.h1RSI.mid?.winRate ?? 0}% | High: ${patternInsights.h1RSI.high?.winRate ?? 0}%`
    );
    lines.push(
        `- ATR sweet spot (5-12 pips) win rate: ${patternInsights.h1ATR.mid?.winRate ?? 0}% | low ${patternInsights.h1ATR.low?.winRate ?? 0}% | high ${patternInsights.h1ATR.high?.winRate ?? 0}%`
    );
    lines.push(`- Session win rates: ${Object.entries(patternInsights.sessions)
        .map(([session, stats]) => `${session} ${stats.winRate}%`)
        .join(" | ")}`);
    lines.push("");
    lines.push(`**Experiment Grid Snapshot**`);
    experimentSummary.forEach((row) => lines.push(`- ${row}`));
    lines.push("");
    lines.push(`**Next Steps**`);
    nextSteps.forEach((step) => lines.push(`- ${step}`));
    return lines.join("\n");
}

async function main() {
    const runId = `grid_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    const analysisDir = path.join("backtest", "analysis");
    const pairs = listPairs(analysisDir);
    console.log(`Pairs detected: ${pairs.join(", ")}`);

    const pairDataMap = {};
    for (const pair of pairs) {
        console.log(`\n[Collect] ${pair}`);
        pairDataMap[pair] = await collectPairData(pair, { analysisDir });
        console.log(`  Trades detected: ${pairDataMap[pair].trades.length}`);
    }

    const experimentGrid = buildExperimentGrid();
    const configMap = buildConfigMap(experimentGrid);
    const pairMetrics = {};
    const configTotals = {};

    for (const pair of pairs) {
        const data = pairDataMap[pair];
        const baselineResult = runSimulationForPair(data, baselineConfig);
        pairMetrics[pair] = { baseline: baselineResult, configs: {} };

        for (const config of experimentGrid) {
            const result = runSimulationForPair(data, config);
            pairMetrics[pair].configs[config.id] = result;
            if (!configTotals[config.id]) {
                configTotals[config.id] = {
                    trades: 0,
                    netR: 0,
                    grossProfit: 0,
                    grossLoss: 0,
                    wins: 0,
                    losses: 0,
                    pairsImproved: 0,
                };
            }
            configTotals[config.id].trades += result.metrics.trades;
            configTotals[config.id].netR += result.metrics.netR;
            configTotals[config.id].grossProfit += result.metrics.grossProfit;
            configTotals[config.id].grossLoss += result.metrics.grossLoss;
            configTotals[config.id].wins += result.metrics.wins;
            configTotals[config.id].losses += result.metrics.losses;
            if (isImproved(baselineResult.metrics, result.metrics)) {
                configTotals[config.id].pairsImproved += 1;
            }
        }
    }

    const perPairSelection = {};
    let improvedPairCount = 0;
    for (const pair of pairs) {
        const { baseline, configs } = pairMetrics[pair];
        let bestConfigId = baselineConfig.id;
        let bestMetrics = baseline.metrics;
        let improved = false;
        for (const [configId, result] of Object.entries(configs)) {
            if (!result.metrics.trades) continue;
            if (isImproved(baseline.metrics, result.metrics)) {
                if (!improved || (result.metrics.profitFactor ?? 0) > (bestMetrics.profitFactor ?? 0)) {
                    improved = true;
                    bestConfigId = configId;
                    bestMetrics = result.metrics;
                }
            }
        }
        if (improved) improvedPairCount++;
        perPairSelection[pair] = bestConfigId;
    }

    const totalPairs = pairs.length;
    let overallBestConfigId = baselineConfig.id;
    let bestScore = -Infinity;
    const experimentSummary = [];
    for (const [configId, totals] of Object.entries(configTotals)) {
        if (!totals.trades) continue;
        const expectancy = totals.netR / totals.trades;
        const profitFactor = totals.grossLoss < 0 ? totals.grossProfit / Math.abs(totals.grossLoss) : null;
        const improvementShare = totals.pairsImproved / totalPairs;
        const score = (expectancy || 0) * ((profitFactor || 1) + improvementShare);
        experimentSummary.push(
            `${configId}: trades=${totals.trades}, exp=${expectancy.toFixed(2)}R, PF=${profitFactor?.toFixed(2) ?? "n/a"}, improved ${(improvementShare * 100).toFixed(0)}%`
        );
        if (score > bestScore && improvementShare >= 0.7) {
            bestScore = score;
            overallBestConfigId = configId;
        }
    }

    const resultsDir = path.join("results", runId);
    const tradesDir = path.join(resultsDir, "trades");
    ensureDir(tradesDir);

    const finalResults = [];
    const allTrades = [];
    const overrides = {};

    for (const pair of pairs) {
        const selectedConfigId = perPairSelection[pair] || overallBestConfigId;
        const cfg = configMap.get(selectedConfigId) || baselineConfig;
        if (selectedConfigId !== overallBestConfigId) {
            overrides[pair] = cfg;
        }
        const result = runSimulationForPair(pairDataMap[pair], cfg, { collectTrades: true });
        finalResults.push({ ...result, configId: selectedConfigId });
        if (result.trades) {
            result.trades.forEach((trade) => allTrades.push({ ...trade, configId: selectedConfigId }));
            writeTradesCsv(result.trades, path.join(tradesDir, `${pair}.csv`), runId);
        }
    }

    const overallMetrics = buildOverallMetrics(allTrades);
    const patternInsights = analyzePatterns(allTrades);
    const summaryPayload = buildSummaryJson({ runId, perPairResults: finalResults, overallMetrics, patternInsights });
    fs.writeFileSync(path.join(resultsDir, "summary.json"), JSON.stringify(summaryPayload, null, 2));

    const defaultsConfig = configMap.get(overallBestConfigId) || baselineConfig;
    writeConfigSuggestion(path.join(resultsDir, "config_suggestion.json"), runId, defaultsConfig, overrides);

    const nextSteps = [
        "Replay best config with live spreads to confirm slippage impact",
        "Forward-test ATR band and RSI gate toggles during NY open",
        "A/B soft-exit aggressiveness on news-filtered days",
    ];
    const patternsMd = renderPatternsMarkdown(runId, overallMetrics, patternInsights, experimentSummary.slice(0, 10), nextSteps);
    fs.writeFileSync(path.join(resultsDir, "patterns.md"), patternsMd, "utf8");

    console.log(`\nRun completed. Results stored under ${resultsDir}`);
    console.log(`Improved pairs: ${improvedPairCount}/${totalPairs}`);
}

main().catch((error) => {
    console.error("Experiment grid failed", error);
    process.exit(1);
});
