import yahooFinance from "yahoo-finance2";
import { ANALYSIS } from "./config.js";
import tradingService from "./services/trading.js";
import Strategy from "./strategies/strategies.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";
import fs from "fs";

const backtestSymbols = [
    "EURUSD",
    "GBPUSD",
    "EURGBP",
    "USDCHF",
    "EURJPY",
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "USDCAD",
    "AUDUSD",
    "NZDUSD",
    "AUDJPY",
    "NZDJPY",
    "USDJPY",
    "EURJPY",
    "AUDUSD",
    "NZDUSD",
];
// Helper to map your symbols to Yahoo Finance tickers
function mapSymbol(symbol) {
    // Forex: EURUSD -> EURUSD=X, GBPUSD -> GBPUSD=X, etc.
    if (/^[A-Z]{6}$/.test(symbol)) return symbol + "=X";
    // Add more mappings for stocks/crypto if needed
    return symbol;
}

// Fetch candles from Yahoo Finance
async function fetchYahooCandles(symbol, interval, start, end) {
    const yfSymbol = mapSymbol(symbol);
    // Yahoo Finance chart() supports: "1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d", "5d", "1wk", "1mo", "3mo"
    const validIntervals = ["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d", "5d", "1wk", "1mo", "3mo"];
    if (!validIntervals.includes(interval)) throw new Error(`Interval ${interval} not supported by Yahoo chart API`);
    const queryOptions = {
        period1: new Date(start),
        period2: new Date(end),
        interval,
    };
    // Use chart() instead of historical()
    const result = await yahooFinance.chart(yfSymbol, queryOptions);
    // Map to your candle format
    return result.quotes.map((c, i) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        timestamp: new Date(result.timestamp[i] * 1000),
    }));
}

// Main backtest function
async function backtest(symbol, start = ANALYSIS.BACKTESTING.START_DATE, end = ANALYSIS.BACKTESTING.END_DATE) {
    logger.info(`[Backtest] Fetching Yahoo candles for ${symbol}...`);
    const h1Candles = await fetchYahooCandles(symbol, "60m", start, end);
    const m15Candles = await fetchYahooCandles(symbol, "15m", start, end);
    const m5Candles = await fetchYahooCandles(symbol, "5m", start, end);
    const m1Candles = await fetchYahooCandles(symbol, "1m", start, end);

    console.log(`Fetched ${h1Candles.length} H1, ${m15Candles.length} M15, ${m5Candles.length} M5, ${m1Candles.length} M1 candles for ${symbol}`);
    let trades = [];
    // for (let i = 50; i < h1Candles.length; i++) {
    //     // Get slices for each timeframe
    //     const h1Slice = h1Candles.slice(i - 50, i + 1);
    //     const m15Slice = m15Candles.filter(c => c.timestamp <= h1Candles[i].timestamp).slice(-50);
    //     const m5Slice = m5Candles.filter(c => c.timestamp <= h1Candles[i].timestamp).slice(-50);
    //     const m1Slice = m1Candles.filter(c => c.timestamp <= h1Candles[i].timestamp).slice(-50);

    //     // Calculate indicators for each timeframe
    //     const indicators = {
    //         h1: await calcIndicators(h1Slice, symbol, ANALYSIS.TIMEFRAMES.H1),
    //         m15: await calcIndicators(m15Slice, symbol, ANALYSIS.TIMEFRAMES.M15),
    //         m5: await calcIndicators(m5Slice, symbol, ANALYSIS.TIMEFRAMES.M5),
    //         m1: await calcIndicators(m1Slice, symbol, ANALYSIS.TIMEFRAMES.M1),
    //     };

    //     // Compose candles object
    //     const candles = {
    //         h1: h1Slice,
    //         m15: m15Slice,
    //         m5: m5Slice,
    //         m1: m1Slice,
    //     };

    //     // Try all strategies for this bar
    //     const strategiesToTest = ["checkBreakout", "checkMeanReversion", "checkPullbackHybrid"];
    //     for (const strategy of strategiesToTest) {
    //         const { signal, reason } = Strategy.applyFilter(
    //             Strategy.getSignal({ symbol, strategy, indicators, candles }).signal,
    //             strategy,
    //             candles,
    //             indicators
    //         );
    //         trades.push({
    //             time: h1Candles[i].timestamp,
    //             symbol,
    //             strategy,
    //             signal,
    //             reason,
    //             price: h1Candles[i].close,
    //         });
    //     }
    // }

    logger.info(`[Backtest] Completed for ${symbol}. Total signals: ${trades.length}`);
    return trades;
}

// Run backtest for all symbols and save results
async function runAndSaveBacktest() {
    const results = {};
    for (const symbol of backtestSymbols) {
        results[symbol] = await backtest(symbol, ANALYSIS.BACKTESTING.START_DATE, ANALYSIS.BACKTESTING.END_DATE);
    }
    // Save to file
    fs.writeFileSync("backtest-results.json", JSON.stringify(results, null, 2));
    logger.info("[Backtest] Results saved to backtest-results.json");
}

if (process.argv[1].endsWith("backtest.js")) {
    runAndSaveBacktest();
}

export default backtest;
