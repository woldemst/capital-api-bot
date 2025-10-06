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
    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    // --- Position size + achievable SL/TP for M1 ---
    async calculateTradeParameters(signal, symbol, bid, ask, candles) {
        const { m1Candles } = candles;

        const price = signal === "BUY" ? ask : bid;

        // Use previous M1 candle for SL
        const prevCandle = m1Candles && m1Candles.length > 1 ? m1Candles[m1Candles.length - 2] : null;
        if (!prevCandle) throw new Error("Not enough M1 candles for SL calculation");

        const buffer = symbol.includes("JPY") ? 0.08 : 0.0008;
        let stopLossPrice, slDistance, takeProfitPrice;

        if (signal === "BUY") {
            stopLossPrice = prevCandle.low - buffer;
            slDistance = price - stopLossPrice;
            takeProfitPrice = price + slDistance * 1.8;
        } else {
            stopLossPrice = prevCandle.high + buffer;
            slDistance = stopLossPrice - price;
            takeProfitPrice = price - slDistance * 1.8;
        }

        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        const minSlPips = symbol.includes("JPY") ? 12 : 10;
        const minSl = minSlPips * pip;

        if (Math.abs(slDistance) < minSl) {
            if (signal === "BUY") {
                stopLossPrice = price - minSl;
                slDistance = price - stopLossPrice;
                takeProfitPrice = price + slDistance * 1.8;
            } else {
                stopLossPrice = price + minSl;
                slDistance = stopLossPrice - price;
                takeProfitPrice = price - slDistance * 1.8;
            }
        }

        // let size = (this.accountBalance * 0.02) / Math.abs(slDistance);
        // size = Math.floor(size / 100) * 100;
        // if (size < 100) size = 100;

        // Round SL/TP to valid decimals
        stopLossPrice = this.roundPrice(stopLossPrice, symbol);
        takeProfitPrice = this.roundPrice(takeProfitPrice, symbol);

        // --- FIXED: Proper pip-based sizing for all symbols ---
        const slPips = Math.abs(slDistance / pip); // SL distance in pips
        const pipValuePerUnit = pip / price; // pip value per unit (approx.)

        const maxSimultaneousTrades = MAX_POSITIONS;
        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / maxSimultaneousTrades;

        let size = riskAmount / (slPips * pipValuePerUnit);
        size = Math.floor(size / 100) * 100; // round down to nearest 100
        if (size < 100) size = 100; // enforce minimum

        logger.info(`[Trade Parameters] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice} (${slPips.toFixed(1)} pips)
            TP: ${takeProfitPrice}
            Size: ${size}
            PipValue/Unit: ${pipValuePerUnit.toFixed(8)} RiskAmount: ${riskAmount.toFixed(2)}`);

        return { size, price, stopLossPrice, takeProfitPrice };
    }

    // --- TP/SL validation (unchanged) ---
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        logger.info(`[TP/SL Validation] Symbol: ${symbol}, Direction: ${direction}`);
        logger.info(`[TP/SL Validation] Entry: ${entryPrice}, SL: ${stopLossPrice}, TP: ${takeProfitPrice}`);

        const allowed = await getAllowedTPRange(symbol);

        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;

        // Berechne tatsächlichen Abstand
        const slDistance = Math.abs(entryPrice - stopLossPrice);
        const minSLDistance = allowed?.minStopDistance || 0;

        // Wenn SL zu nah, passe ihn an
        if (slDistance < minSLDistance) {
            if (direction === "BUY") {
                newSL = entryPrice - minSLDistance;
            } else {
                newSL = entryPrice + minSLDistance;
            }
        }

        // Runde Preise ggf. auf die erlaubte Tickgröße
        newSL = this.roundPrice(newSL, symbol);
        newTP = this.roundPrice(newTP, symbol);

        logger.info(`[TP/SL Validation] Final SL: ${newSL}, Final TP: ${newTP}`);
        return { SL: newSL, TP: newTP };
    }

    async executeTrade(symbol, signal, bid, ask, indicators, candles) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, candles);
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
            // const { signal, reason } = Strategy.getSignal({ symbol, indicators, candles, trendAnalysis });

            const { signal, reason } = Strategy.legacyMultiTfStrategy({ indicators, bid, ask });

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found`);
                await this.processSignal(symbol, signal, bid, ask, candles, indicators);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found for reason: ${reason}`);
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    // --- Signal processing ---
    async processSignal(symbol, signal, bid, ask, candles, indicators = {}) {
        try {
            await this.executeTrade(symbol, signal, bid, ask, indicators, candles);
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

    // --- Improved trailing stop logic ---
    async updateTrailingStopIfNeeded(position, indicators) {
        const { dealId, direction, entryPrice, stopLoss, currentPrice, symbol } = position;

        if (!dealId) {
            logger.warn(`[TrailingStop] No dealId for position, skipping update.`);
            return;
        }

        // Use ATR from indicators (fallback to SL distance if missing)
        const atr = indicators.atr || Math.abs(entryPrice - stopLoss);

        // Activate trailing when price moves +1×ATR in profit
        const activationLevel = direction === "BUY" ? entryPrice + atr : entryPrice - atr;
        const reachedActivation = direction === "BUY" ? currentPrice >= activationLevel : currentPrice <= activationLevel;

        if (!reachedActivation) {
            logger.debug(`[TrailingStop] Position ${dealId} has not yet reached trailing activation level.`);
            return;
        }

        // Trailing stop: set new stop at ATR distance from current price
        const newStop = direction === "BUY" ? currentPrice - atr : currentPrice + atr;

        // Only update if new stop is better than previous
        const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;

        if (shouldUpdate) {
            try {
                await updateTrailingStop(
                    dealId,
                    currentPrice,
                    entryPrice,
                    null, // takeProfit not needed for trailing
                    direction.toUpperCase(),
                    symbol,
                    true // enable trailing
                );
                logger.info(`[TrailingStop] Updated stop to ${newStop} (ATR: ${atr}) for ${dealId}`);
            } catch (error) {
                logger.error(`[TrailingStop] Error updating stops for ${dealId}:`, error);
            }
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

    // --- Close all positions before weekend ---
    async closeAllPositionsBeforeWeekend(getOpenPositions) {
        const now = new Date();
        const day = now.getDay(); // 5 = Friday, 6 = Saturday, 0 = Sunday
        const hour = now.getHours();

        // If it's Friday after 20:00 (8pm), close all positions
        if (day === 5 && hour >= 20) {
            logger.info("[Weekend] Closing all positions before weekend.");
            try {
                const openPositions = await getOpenPositions();
                for (const pos of openPositions) {
                    await this.closePosition(pos.dealId);
                }
                logger.info("[Weekend] All positions closed before weekend.");
            } catch (error) {
                logger.error("[Weekend] Error closing positions before weekend:", error);
            }
        }
    }
}

export default new TradingService();
