import { getHistorical } from "./api.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";

// Backtest trading strategy using historical data
async function backtest(symbol, timeframe = "HOUR", count = 100) {
    logger.info(`[Backtest] Fetching ${count} ${timeframe} candles for ${symbol}...`);
    const { prices: candles } = await getHistorical(symbol, timeframe, count);

    if (!candles || candles.length < 2) {
        logger.warn(`[Backtest] Not enough candles for ${symbol}`);
        return [];
    }

    let trades = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];

        // Calculate indicators for current window
        const indicators = await calcIndicators(candles.slice(0, i + 1), symbol, timeframe);

        // Generate signal using tradingService
        const signalObj = tradingService.generateSignal(indicators, candles.slice(0, i + 1));
        if (signalObj && signalObj.signal) {
            trades.push({
                time: curr.timestamp,
                signal: signalObj.signal,
                price: curr.close,
                reason: signalObj.reason,
            });
            logger.info(`[Backtest] ${signalObj.signal} at ${curr.timestamp} (${curr.close})`);
        }
    }

    logger.info(`[Backtest] Completed for ${symbol}. Total signals: ${trades.length}`);
    return trades;
}

export default backtest;
