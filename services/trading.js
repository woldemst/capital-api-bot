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
    async calculateTradeParameters(signal, symbol, bid, ask, context = {}) {
        try {
            const price = signal === "BUY" ? ask : bid;
            
            // Extract prev candle data from context
            const { prevHigh, prevLow } = context;
            if (!prevHigh || !prevLow) {
                throw new Error("Missing previous candle data for SL/TP calculation");
            }

            let stopLossPrice, slDistance, takeProfitPrice;
            const buffer = symbol.includes("JPY") ? 0.02 : 0.0002; // Small buffer for SL

            // Calculate SL and TP based on prev candle
            if (signal === "BUY") {
                stopLossPrice = prevLow - buffer;
                slDistance = price - stopLossPrice;
                takeProfitPrice = price + (slDistance * 2); // 1:2 risk/reward
            } else if (signal === "SELL") {
                stopLossPrice = prevHigh + buffer;
                slDistance = stopLossPrice - price;
                takeProfitPrice = price - (slDistance * 2); // 1:2 risk/reward
            }

            // Ensure minimum SL distance
            const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
            const minSlPips = symbol.includes("JPY") ? 5 : 3; // Reduced minimum SL
            const minSl = minSlPips * pip;

            if (Math.abs(slDistance) < minSl) {
                logger.info(`[Trade Parameters] SL distance ${slDistance} less than minimum ${minSl}, adjusting...`);
                if (signal === "BUY") {
                    stopLossPrice = price - minSl;
                    takeProfitPrice = price + (minSl * 2);
                } else {
                    stopLossPrice = price + minSl;
                    takeProfitPrice = price - (minSl * 2);
                }
                slDistance = minSl;
            }

            // Fetch allowed decimals
            const allowed = await getAllowedTPRange(symbol);
            const decimals = allowed?.decimals ?? (symbol.includes("JPY") ? 3 : 5);

            // Round prices
            stopLossPrice = this.roundPrice(stopLossPrice, symbol, decimals);
            takeProfitPrice = this.roundPrice(takeProfitPrice, symbol, decimals);

            // Calculate position size
            const maxSimultaneousTrades = MAX_POSITIONS;
            const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / maxSimultaneousTrades;
            const pipValue = pip / price;
            let size = Math.floor(riskAmount / ((slDistance / pip) * pipValue) / 100) * 100;
            if (size < 100) size = 100; // Minimum size

            logger.info(`[Trade Parameters] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice} (${slDistance.toFixed(5)} points)
            TP: ${takeProfitPrice}
            Size: ${size}
            Prev Candle High: ${prevHigh}
            Prev Candle Low: ${prevLow}`);

            return {
                size,
                price,
                stopLossPrice,
                takeProfitPrice,
            };
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

        // Berechne tatsächlichen Abstand
        const slDistance = Math.abs(entryPrice - stopLossPrice);
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
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, context);
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
    async processPrice(message) {
        const symbol = message?.symbol;
        try {
            const { indicators, h1Candles, m15Candles, m5Candles, m1Candles, bid, ask, strategy } = message;

            const candles = { h1: h1Candles, m15: m15Candles, m5: m5Candles, m1: m1Candles };

            //TODO
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
        const { dealId, direction, entryPrice, takeProfit, stopLoss, currentPrice } = position;

        const tpDistance = Math.abs(takeProfit - entryPrice);

        const tp80 = direction === "BUY" ? entryPrice + tpDistance * 0.8 : entryPrice - tpDistance * 0.8;

        const reached80TP = direction === "BUY" ? currentPrice >= tp80 : currentPrice <= tp80;
        if (!reached80TP) return;
        const trailingBuffer = tpDistance * 0.1;
        const newStop = direction === "BUY" ? currentPrice - trailingBuffer : currentPrice + trailingBuffer;
        const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;
        if (!shouldUpdate) return;
        try {
            await updateTrailingStop(
                dealId,
                currentPrice,
                entryPrice,
                takeProfit,
                direction.toUpperCase(),
                position.symbol || position.market,
                position.isTrailing || false
            );
            logger.info(`[TrailingStop] Updated trailing stop for ${dealId}: ${newStop}`);
        } catch (error) {
            logger.error(`[TrailingStop] Failed to update trailing stop for ${dealId}:`, error);
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
