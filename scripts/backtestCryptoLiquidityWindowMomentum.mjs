import fs from "node:fs";
import path from "node:path";

import { runReplayBacktest } from "../intraday/step7ReviewBacktest.js";
import { STRATEGIES } from "../config.js";
import { CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID } from "../strategies/cryptoLiquidityWindowMomentum.js";

const STRATEGY_CONFIG = STRATEGIES?.CRYPTO_LIQUIDITY_WINDOW_MOMENTUM || {};
const TARGET_SYMBOLS = (STRATEGY_CONFIG?.symbols || ["BTCUSD", "SOLUSD", "XRPUSD", "DOGEUSD", "ETHUSD"]).map((s) => String(s).toUpperCase());
const PRICE_DIR = path.join(process.cwd(), "backtest", "prices");
const REPORT_DIR = path.join(process.cwd(), "backtest", "reports", "crypto-lwm");

function priceFileForSymbol(symbol) {
    return path.join(PRICE_DIR, `${symbol}.jsonl`);
}

function collectPriceFiles() {
    const files = TARGET_SYMBOLS.map(priceFileForSymbol).filter((filePath) => fs.existsSync(filePath));
    if (!files.length) {
        throw new Error(`No price files found in ${PRICE_DIR} for ${TARGET_SYMBOLS.join(", ")}`);
    }
    return files;
}

function fmtPct(x) {
    return Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(2)}%` : "n/a";
}

function fmtNum(x, digits = 2) {
    return Number.isFinite(Number(x)) ? Number(x).toFixed(digits) : "n/a";
}

async function main() {
    const priceFiles = collectPriceFiles();
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const minuteLogOutputPath = path.join(REPORT_DIR, `${CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID}-minute.jsonl`);
    const tradeLogOutputPath = path.join(REPORT_DIR, `${CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID}-trades.jsonl`);
    for (const p of [minuteLogOutputPath, tradeLogOutputPath]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const { report, reportPath, snapshotsProcessed, tradeLogs } = await runReplayBacktest({
        strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
        config: STRATEGY_CONFIG,
        priceFiles,
        outputDir: REPORT_DIR,
        minuteLogOutputPath,
        tradeLogOutputPath,
    });

    const metrics = report?.metrics || {};
    console.log("=== CRYPTO_LIQUIDITY_WINDOW_MOMENTUM Backtest Summary ===");
    console.log(`Strategy: ${report?.strategyId}`);
    console.log(`Snapshots: ${snapshotsProcessed}`);
    console.log(`Trades: ${metrics.tradeCount ?? tradeLogs.length}`);
    console.log(`Win rate: ${fmtPct(metrics.winrate)}`);
    console.log(`Profit factor: ${fmtNum(metrics.profitFactor, 2)}`);
    console.log(`Avg R: ${fmtNum(metrics.avgR, 3)}`);
    console.log(`Max drawdown: ${fmtPct(metrics.maxDrawdown)}`);
    console.log(`Net PnL: ${fmtNum(metrics.netPnl, 2)}`);
    console.log(`Report: ${reportPath}`);
    console.log(`Minute log: ${minuteLogOutputPath}`);
    console.log(`Trade log: ${tradeLogOutputPath}`);
}

main().catch((error) => {
    console.error("[backtestCryptoLiquidityWindowMomentum] Failed:", error);
    process.exit(1);
});

