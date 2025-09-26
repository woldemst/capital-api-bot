import { RISK } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult, getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import fs from "fs";
import Strategy from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.lastTradeTimestamps = {};
        this.maxRiskPerTrade = PER_TRADE;
        this.dailyLoss = 0;
        this.dailyLossLimitPct = 0.05;
    }

    setAccountBalance(balance) {
        this.accountBalance = balance;
    }
    setOpenTrades(trades) {
        this.openTrades = trades;
    }

    setAvailableMargin(margin) {
        this.availableMargin = margin;
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    // --- Price rounding ---
    roundPrice(price, symbol, decimals) {
        const d = typeof decimals === "number" ? decimals : symbol.includes("JPY") ? 3 : 5;
        return Number(Number(price).toFixed(d));
    }

    // --- Position size + achievable SL/TP for M1 ---
    async calculateTradeParameters(signal, symbol, bid, ask, context = {}, indicators = {}) {
        try {
            const price = signal === "BUY" ? ask : bid;

            // ATR-based SL calculation
            const atr = indicators.m5.atr;
            const atrMuliplier = 1.8;

            // Extract prev and signal candle data from context
            const { prevHigh, prevLow, prevOpen, prevClose } = context;

            // Calculate the body of the signal candle (last closed candle)
            const signalBody = Math.abs(prevClose - prevOpen);
            const buffer = symbol.includes("JPY") ? 0.03 : 0.0003; // Small buffer for SL

            let stopLossPrice, takeProfitPrice;
            const rr = 2; // Reward-to-risk ratio
            if (signal === "BUY") {
                stopLossPrice = prevLow - atrMuliplier * atr;
                takeProfitPrice = price + rr * (price - stopLossPrice);
                // // SL just under previous candle's low
                // stopLossPrice = prevLow - buffer;
                // // TP = entry + 2 * body of signal candle
                // takeProfitPrice = price + 2 * signalBody;
            } else if (signal === "SELL") {
                stopLossPrice = prevHigh + atrMult * atr;
                takeProfitPrice = price + rr * (stopLossPrice - price);
                // // SL just above previous candle's high
                // stopLossPrice = prevHigh + buffer;
                // // TP = entry - 2 * body of signal candle
                // takeProfitPrice = price - 2 * signalBody;
            }

            // Fetch allowed decimals
            const allowed = await getAllowedTPRange(symbol);
            const decimals = allowed?.decimals ?? (symbol.includes("JPY") ? 3 : 5);

            // Round prices
            stopLossPrice = this.roundPrice(stopLossPrice, symbol, decimals);
            takeProfitPrice = this.roundPrice(takeProfitPrice, symbol, decimals);

            // Calculate position size (unchanged)
            const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
            const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;
            const slDistance = Math.abs(price - stopLossPrice);
            const pipValue = pip / price;
            let size = Math.floor(riskAmount / ((slDistance / pip) * pipValue) / 100) * 100;
            if (size < 100) size = 100; // Minimum size

            logger.info(`[Trade Parameters] ${symbol} ${signal}:
                Entry: ${price}
                SL: ${stopLossPrice}
                TP: ${takeProfitPrice}
                Size: ${size}
                ATR: ${atr}
                Signal Candle Body: ${signalBody}`);

            return { size, price, stopLossPrice, takeProfitPrice };
        } catch (error) {
            logger.error(`[trading.js][calculateTradeParameters] Error calculating trade parameters for ${symbol}:`, error);
            throw error;
        }
    }

    // --- TP/SL validation (unchanged) ---
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        logger.info(`[TP/SL Validation] Symbol: ${symbol}, Direction: ${direction}`);
        logger.info(`[TP/SL Validation] Entry: ${entryPrice}, SL: ${stopLossPrice}, TP: ${takeProfitPrice}`);

        const allowed = await getAllowedTPRange(symbol);
        const decimals = allowed?.decimals ?? (symbol.includes("JPY") ? 3 : 5);

        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;

        // Normalize direction to uppercase
        const dir = direction.toUpperCase();

        const minSLDistance = allowed?.minSLDistancePrice || 0;
        const minTPDistance = allowed?.minTPDistancePrice || 0;

        // Add explicit SL side check and adjust if invalid or too close
        if (dir === "BUY") {
            if (newSL >= entryPrice) {
                newSL = entryPrice - minSLDistance;
            }
            if (Math.abs(entryPrice - newSL) < minSLDistance) {
                newSL = entryPrice - minSLDistance;
            }
            if (Math.abs(newTP - entryPrice) < minTPDistance) {
                newTP = entryPrice + minTPDistance;
            }
        } else if (dir === "SELL") {
            if (newSL <= entryPrice) {
                newSL = entryPrice + minSLDistance;
            }
            if (Math.abs(entryPrice - newSL) < minSLDistance) {
                newSL = entryPrice + minSLDistance;
            }
            if (Math.abs(entryPrice - newTP) < minTPDistance) {
                newTP = entryPrice - minTPDistance;
            }
        }

        // Runde Preise ggf. auf die erlaubte Tickgröße
        newSL = this.roundPrice(newSL, symbol, decimals);
        newTP = this.roundPrice(newTP, symbol, decimals);

        logger.info(`[TP/SL Validation] Final SL: ${newSL}, Final TP: ${newTP}`);
        return { SL: newSL, TP: newTP };
    }

    async executeTrade(symbol, signal, bid, ask, indicators = {}, context = {}) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, context, indicators);
            const { SL, TP } = await this.validateTPandSL(symbol, signal, price, stopLossPrice, takeProfitPrice);
            const position = await placePosition(symbol, signal, size, price, SL, TP);

            if (!position?.dealReference) {
                logger.error(`[trading.js][Order] Deal reference is missing: ${JSON.stringify(position)}`);
                return;
            }

            const confirmation = await getDealConfirmation(position.dealReference);

            // Check the status of the deal confirmation
            if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
            } else {
                logger.info(
                    `[trading.js][Order] Placed position: ${symbol} ${signal} size=${size} entry=${price} SL=${stopLossPrice} TP=${takeProfitPrice} ref=${position.dealReference}`
                );

                try {
                    const logPath = getCurrentTradesLogPath();
                    const logEntry = {
                        time: new Date().toISOString(),
                        id: position.dealReference,
                        symbol,
                        direction: signal.toLowerCase(),
                        entry: price,
                        sl: SL,
                        tp: TP,
                        size,
                        indicators,
                        result: null,
                    };
                    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
                    logger.info(`[TradeLog] Logged opened trade ${position.dealReference} to ${logPath}`);
                } catch (err) {
                    logger.error("[TradeLog] Failed to append opened trade:", err);
                }
            }
        } catch (error) {
            logger.error(`[trading.js][Order] Error placing trade for ${symbol}:`, error);
        }
    }

    //  Main price processing ---
    async processPrice({ symbol, indicators, candles, bid, ask }) {
        try {
            // TODO !!
            // Check trading conditions
            // if (this.dailyLoss <= -this.accountBalance * this.dailyLossLimitPct) {
            //     logger.warn(`[Risk] Daily loss limit (${this.dailyLossLimitPct * 100}%) hit. Skip all new trades today.`);
            //     return;
            // }

            logger.info(`[ProcessPrice] Open trades: ${this.openTrades.length}/${MAX_POSITIONS} | Balance: ${this.accountBalance}€`);
            if (this.openTrades.length >= MAX_POSITIONS) {
                logger.info(`[ProcessPrice] Max trades (${MAX_POSITIONS}) reached. Skipping ${symbol}.`);
                return;
            }
            if (this.isSymbolTraded(symbol)) {
                logger.warn(`[ProcessPrice] ${symbol} already has an open position.`);
                return;
            }
            const { signal, context, reason } = Strategy.getSignal({ symbol, indicators, candles });

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found`);
                await this.processSignal(symbol, signal, bid, ask, indicators, context);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found for reason: ${reason}`);
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    // --- Signal processing ---
    async processSignal(symbol, signal, bid, ask, indicators = {}, constext = {}) {
        try {
            await this.executeTrade(symbol, signal, bid, ask, indicators, constext);
            logger.info(`[Signal] Successfully processed ${signal.toUpperCase()} signal for ${symbol}`);
        } catch (error) {
            // Check if the error message contains 'Not placed'
            if (error.message.includes("Not placed")) {
                logger.error(`[trading.js][Signal] Order placement failed for ${signal} signal on ${symbol}:`, error);
            } else {
                logger.error(`[trading.js][Signal] Failed to process ${signal} signal for ${symbol}:`, error);
            }
        }
    }

    // --- Trailing stop logic (unchanged) ---
    async updateTrailingStopIfNeeded(position) {
        const { dealId, direction, entryPrice, takeProfit, stopLoss, currentPrice, size } = position;

        if (!dealId) {
            logger.warn(`[TrailingStop] No dealId for position, skipping update.`);
            return;
        }

        const tpDistance = Math.abs(takeProfit - entryPrice);

        // Calculate profit targets
        const tp50 = direction === "BUY" ? entryPrice + tpDistance * 0.5 : entryPrice - tpDistance * 0.5;

        const tp80 = direction === "BUY" ? entryPrice + tpDistance * 0.8 : entryPrice - tpDistance * 0.8;

        // Check if price reached 50% of target
        const reached50TP = direction === "BUY" ? currentPrice >= tp50 : currentPrice <= tp50;

        // Check if price reached 80% of target
        const reached80TP = direction === "BUY" ? currentPrice >= tp80 : currentPrice <= tp80;

        try {
            // First target: Close 50% at 1:1 R:R
            if (reached50TP && size > 100) {
                const partialSize = Math.floor(size / 2 / 100) * 100;
                if (partialSize >= 100) {
                    await this.closePartialPosition(dealId, partialSize);
                    logger.info(`[PartialTP] Closed ${partialSize} units at 50% target for ${dealId}`);
                }
            }

            // Second target: Trail remaining with tighter stop
            if (reached80TP) {
                const trailingBuffer = tpDistance * 0.1; // 10% of original TP distance
                const newStop = direction === "BUY" ? currentPrice - trailingBuffer : currentPrice + trailingBuffer;

                const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;

                if (shouldUpdate) {
                    await updateTrailingStop(
                        dealId,
                        currentPrice,
                        entryPrice,
                        takeProfit,
                        direction.toUpperCase(),
                        position.symbol || position.market,
                        true // enable trailing
                    );
                    logger.info(`[TrailingStop] Updated stop to ${newStop} for ${dealId}`);
                }
            }
        } catch (error) {
            logger.error(`[TrailingStop] Error updating stops for ${dealId}:`, error);
        }
    }

    async closePartialPosition(dealId, size) {
        try {
            // Add your broker's API call to close partial position
            await apiClosePosition(dealId, size);
            logger.info(`[PartialTP] Successfully closed ${size} units for ${dealId}`);
        } catch (error) {
            logger.error(`[PartialTP] Failed to close partial position for ${dealId}:`, error);
        }
    }

    // --- Close position by dealId ---
    async closePosition(dealId, result) {
        try {
            await apiClosePosition(dealId);
            logger.info(`[API] Closed position for dealId: ${dealId}`);
            if (result) logTradeResult(dealId, result);
        } catch (error) {
            logger.error(`[trading.js][API] Failed to close position for dealId: ${dealId}`, error);
        }
    }
}

export default new TradingService();
