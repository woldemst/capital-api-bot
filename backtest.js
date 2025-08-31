import yahooFinance from "yahoo-finance2";
import { SYMBOLS, ANALYSIS } from "./config.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";
import fs from "fs";

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
    const queryOptions = {
        period1: new Date(start),
        period2: new Date(end),
        interval,
    };
    const result = await yahooFinance.historical(yfSymbol, queryOptions);
    // Map to your candle format
    return result.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        timestamp: c.date,
    }));
}

// Main backtest function
async function backtest(symbol, start = ANALYSIS.BACKTESTING.START_DATE, end = ANALYSIS.BACKTESTING.END_DATE) {
    logger.info(`[Backtest] Fetching Yahoo candles for ${symbol}...`);
    // Fetch all timeframes
    const d1Candles = await fetchYahooCandles(symbol, "1d", start, end);
    const h4Candles = await fetchYahooCandles(symbol, "4h", start, end);
    const h1Candles = await fetchYahooCandles(symbol, "1h", start, end);

    if (h1Candles.length < 2) {
        logger.warn(`[Backtest] Not enough H1 candles for ${symbol}`);
        return [];
    }

    let trades = [];
    for (let i = 50; i < h1Candles.length; i++) {
        // Start after enough candles for indicators
        const d1Slice = d1Candles.filter((c) => c.timestamp <= h1Candles[i].timestamp).slice(-50);
        const h4Slice = h4Candles.filter((c) => c.timestamp <= h1Candles[i].timestamp).slice(-50);
        const h1Slice = h1Candles.slice(i - 50, i + 1);

        // Calculate indicators for each timeframe
        const d1Trend = (await calcIndicators(d1Slice, symbol, ANALYSIS.TIMEFRAMES.D1)).trend;
        const h4Trend = (await calcIndicators(h4Slice, symbol, ANALYSIS.TIMEFRAMES.H4)).trend;
        const h1Ind = await calcIndicators(h1Slice, symbol, ANALYSIS.TIMEFRAMES.H1);

        // Compose indicators object as in your live bot
        const indicators = {
            d1Trend,
            h4Trend,
            h1: h1Ind,
        };

        const prev = h1Slice[h1Slice.length - 2];
        const last = h1Slice[h1Slice.length - 1];

        // Generate signal using tradingService
        const signalObj = tradingService.generateSignal(indicators, prev, last);
        if (signalObj && signalObj.signal) {
            trades.push({
                time: last.timestamp,
                signal: signalObj.signal,
                price: last.close,
                reason: signalObj.reason,
            });
            logger.info(`[Backtest] ${signalObj.signal} at ${last.timestamp} (${last.close})`);
        }
    }

    logger.info(`[Backtest] Completed for ${symbol}. Total signals: ${trades.length}`);
    return trades;
}

// Run backtest for all symbols and save results
async function runAndSaveBacktest() {
    const results = {};
    for (const symbol of SYMBOLS) {
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
