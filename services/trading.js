import { RISK } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult, getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import fs from "fs";
import Strategy from "../strategies/strategies.js";

const {
    PER_TRADE,
    MAX_POSITIONS,
    BUFFER_PIPS = 1,
    ATR_MULTIPLIER = 2,
    RISK_REWARD: CONFIG_RISK_REWARD,
    REWARD_RATIO: ALT_REWARD_RATIO,
} = RISK;
const TARGET_REWARD_RATIO = CONFIG_RISK_REWARD || ALT_REWARD_RATIO || 2;

const CANDLE_FIELD_MAP = {
    open: ["open", "Open", "o", "O"],
    high: ["high", "High", "h", "H"],
    low: ["low", "Low", "l", "L"],
    close: ["close", "Close", "c", "C"],
};

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function readCandleValue(candle, field) {
    if (!candle) return null;
    const keys = CANDLE_FIELD_MAP[field] || [field];
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(candle, key)) {
            const num = toNumber(candle[key]);
            if (num != null) return num;
        }
    }
    return null;
}

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
    async calculateTradeParameters(signal, symbol, bid, ask, candles, context = {}) {
        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        const buffer = BUFFER_PIPS * pip;

        const price = signal === "BUY" ? toNumber(ask) : toNumber(bid);
        if (price == null) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Missing price data (bid/ask).`);
            return null;
        }

        const history = Array.isArray(candles?.m5Candles) ? candles.m5Candles : Array.isArray(candles?.M5) ? candles.M5 : [];
        const prevCandle = context?.prev ?? (history.length >= 3 ? history[history.length - 3] : null);
        const lastCandle = context?.last ?? (history.length >= 2 ? history[history.length - 2] : null);

        if (!prevCandle || !lastCandle) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Insufficient candle context for SL/TP calculation.`);
            return null;
        }

        const prevLow = readCandleValue(prevCandle, "low");
        const prevHigh = readCandleValue(prevCandle, "high");
        const lastLow = readCandleValue(lastCandle, "low");
        const lastHigh = readCandleValue(lastCandle, "high");

        if ([prevLow, prevHigh, lastLow, lastHigh].some((v) => v == null)) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Candle values missing for SL/TP calculation.`);
            return null;
        }

        const swingLow = Math.min(prevLow, lastLow);
        const swingHigh = Math.max(prevHigh, lastHigh);

        let stopLossPrice = signal === "BUY" ? swingLow - buffer : swingHigh + buffer;
        if (signal === "BUY" && stopLossPrice >= price) stopLossPrice = price - buffer;
        if (signal === "SELL" && stopLossPrice <= price) stopLossPrice = price + buffer;

        let slDistance = Math.abs(price - stopLossPrice);
        const minSlDistance = pip * 4;
        if (slDistance < minSlDistance) {
            stopLossPrice = signal === "BUY" ? price - minSlDistance : price + minSlDistance;
            slDistance = Math.abs(price - stopLossPrice);
        }

        const atr = typeof context?.atr === "number" ? context.atr : null;
        if (atr != null && slDistance > atr * ATR_MULTIPLIER) {
            logger.warn(
                `[Trade Parameters] ${symbol} ${signal}: SL distance (${slDistance.toFixed(5)}) exceeds ATR cap (${(atr * ATR_MULTIPLIER).toFixed(5)}).`
            );
            return null;
        }

        let takeProfitPrice = signal === "BUY" ? price + slDistance * TARGET_REWARD_RATIO : price - slDistance * TARGET_REWARD_RATIO;

        stopLossPrice = this.roundPrice(stopLossPrice, symbol);
        takeProfitPrice = this.roundPrice(takeProfitPrice, symbol);

        slDistance = Math.abs(price - stopLossPrice);
        if (slDistance <= 0) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Invalid SL distance after rounding.`);
            return null;
        }

        let tpDistance = Math.abs(takeProfitPrice - price);
        const desiredTpDistance = slDistance * TARGET_REWARD_RATIO;

        if (tpDistance < desiredTpDistance) {
            const adjustedTarget = signal === "BUY" ? price + desiredTpDistance : price - desiredTpDistance;
            takeProfitPrice = this.roundPrice(adjustedTarget, symbol);
            tpDistance = Math.abs(takeProfitPrice - price);
        }

        if (tpDistance <= slDistance) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Unable to achieve target risk-reward after rounding.`);
            return null;
        }

        const slPips = slDistance / pip;
        const pipValuePerUnit = pip / price;

        if (!Number.isFinite(slPips) || slPips <= 0 || !Number.isFinite(pipValuePerUnit) || pipValuePerUnit <= 0) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Invalid pip calculations.`);
            return null;
        }

        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;
        if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
            logger.warn(`[Trade Parameters] ${symbol} ${signal}: Risk amount calculation failed (balance ${this.accountBalance}).`);
            return null;
        }

        let size = riskAmount / (slPips * pipValuePerUnit);
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        let estimatedRisk = slPips * pipValuePerUnit * size;
        if (estimatedRisk > riskAmount * 1.05) {
            const adjustedSize = Math.floor((riskAmount / (slPips * pipValuePerUnit)) / 100) * 100;
            if (adjustedSize < 100) {
                logger.warn(`[Trade Parameters] ${symbol} ${signal}: Position size too small after risk adjustment.`);
                return null;
            }
            size = adjustedSize;
            estimatedRisk = slPips * pipValuePerUnit * size;
        }

        const riskReward = tpDistance / slDistance;

        logger.info(
            `[Trade Parameters] ${symbol} ${signal}: Entry=${price.toFixed(5)} SL=${stopLossPrice.toFixed(5)} (${slPips.toFixed(
                1
            )} pips) TP=${takeProfitPrice.toFixed(5)} RR=${riskReward.toFixed(2)} Size=${size} Risk=${estimatedRisk.toFixed(2)}`
        );

        return { size, price, stopLossPrice, takeProfitPrice };
    }

    // --- TP/SL validation (unchanged) ---
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        logger.info(`[TP/SL Validation] Symbol: ${symbol}, Direction: ${direction}`);
        logger.info(`[TP/SL Validation] Entry: ${entryPrice}, SL: ${stopLossPrice}, TP: ${takeProfitPrice}`);

        const allowed = await getAllowedTPRange(symbol);

        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;

        const decimals = allowed?.decimals ?? (symbol.includes("JPY") ? 3 : 5);
        const minSLDistancePrice = allowed?.minSLDistancePrice ?? (allowed?.minSLDistance || 0) * Math.pow(10, -decimals);
        const minTPDistancePrice = allowed?.minTPDistancePrice ?? (allowed?.minTPDistance || 0) * Math.pow(10, -decimals);

        let slDistance = Math.abs(entryPrice - newSL);

        if (slDistance < minSLDistancePrice) {
            if (direction === "BUY") {
                newSL = entryPrice - minSLDistancePrice;
            } else {
                newSL = entryPrice + minSLDistancePrice;
            }
            newSL = this.roundPrice(newSL, symbol);
            slDistance = Math.abs(entryPrice - newSL);
        }

        if (slDistance <= 0) {
            throw new Error("Invalid stop-loss distance after validation.");
        }

        let desiredTpDistance = slDistance * TARGET_REWARD_RATIO;
        if (minTPDistancePrice && desiredTpDistance < minTPDistancePrice) {
            desiredTpDistance = minTPDistancePrice;
        }

        const targetTP = direction === "BUY" ? entryPrice + desiredTpDistance : entryPrice - desiredTpDistance;
        newTP = this.roundPrice(targetTP, symbol);

        let tpDistance = Math.abs(entryPrice - newTP);
        if (tpDistance < desiredTpDistance) {
            const adjusted = direction === "BUY" ? entryPrice + desiredTpDistance : entryPrice - desiredTpDistance;
            newTP = this.roundPrice(adjusted, symbol);
            tpDistance = Math.abs(entryPrice - newTP);
        }

        const finalRR = tpDistance / slDistance;
        if (finalRR < TARGET_REWARD_RATIO) {
            const adjusted = direction === "BUY" ? entryPrice + slDistance * TARGET_REWARD_RATIO : entryPrice - slDistance * TARGET_REWARD_RATIO;
            newTP = this.roundPrice(adjusted, symbol);
            tpDistance = Math.abs(entryPrice - newTP);
        }

        logger.info(`[TP/SL Validation] Final SL: ${newSL}, Final TP: ${newTP}, RR=${(tpDistance / slDistance).toFixed(2)}`);
        return { SL: newSL, TP: newTP };
    }

    async executeTrade(symbol, signal, bid, ask, indicators, candles, context) {
        try {
            const tradeParams = await this.calculateTradeParameters(signal, symbol, bid, ask, candles, context);
            if (!tradeParams) {
                logger.info(`[trading.js][Order] Skipped ${symbol} ${signal}: Trade parameters invalid.`);
                return;
            }
            const { size, price, stopLossPrice, takeProfitPrice } = tradeParams;
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
                // try {
                //     const logPath = getCurrentTradesLogPath();
                //     if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "");
                //     const logEntry = {
                //         time: new Date().toISOString(),
                //         id: position.dealReference,
                //         symbol,
                //         direction: signal.toLowerCase(),
                //         entry: price,
                //         sl: SL,
                //         tp: TP,
                //         size,
                //         indicators,
                //         result: null,
                //     };
                //     fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
                //     logger.info(`[TradeLog] Logged opened trade ${position.dealReference}`);
                // } catch (err) {
                //     logger.error("[TradeLog] Failed to append opened trade:", err);
                // }
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
            const { signal, reason, context } = Strategy.getSignal({ symbol, indicators, candles, bid, ask });

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found`);
                await this.processSignal(symbol, signal, bid, ask, candles, indicators, context);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found for reason: ${reason}`);
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    // --- Signal processing ---
    async processSignal(symbol, signal, bid, ask, candles, indicators = {}, context) {
        try {
            await this.executeTrade(symbol, signal, bid, ask, indicators, candles, context);
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

    async updateTrailingStopIfNeeded(position, indicators) {
        const { dealId, direction, entryPrice, stopLoss, takeProfit, currentPrice, symbol } = position;

        if (!dealId) {
            logger.warn(`[TrailingStop] No dealId for position, skipping update.`);
            return;
        }

        // --- Activation logic: pct of TP ---
        const activationPct = 0.6;
        const trailPct = 0.25;
        const tpDistance = Math.abs(takeProfit - entryPrice);
        const activationLevel = direction === "BUY" ? entryPrice + tpDistance * activationPct : entryPrice - tpDistance * activationPct;

        const reachedActivation = direction === "BUY" ? currentPrice >= activationLevel : currentPrice <= activationLevel;

        if (!reachedActivation) {
            logger.debug(`[TrailingStop] Position ${dealId} has not yet reached ${Math.round(activationPct * 100)}% TP activation.`);
            return;
        }

        // --- Trailing stop at percentage of TP distance from current price ---
        const trailDistance = tpDistance * trailPct;
        let newStop;
        if (direction === "BUY") {
            newStop = currentPrice - trailDistance; 
            // Don't move SL backwards
            if (newStop <= stopLoss) return;
        } else {
            newStop = currentPrice + trailDistance;
            if (newStop >= stopLoss) return;
        }

        try {
            await updateTrailingStop(
                dealId,
                currentPrice,
                newStop,
                null, // takeProfit not needed for trailing
                direction.toUpperCase(),
                symbol,
                true
            );
            logger.info(`[TrailingStop] Updated stop to ${newStop.toFixed(5)} (${Math.round(trailPct * 100)}% trail) for ${dealId}`);
        } catch (error) {
            logger.error(`[TrailingStop] Error updating trailing stop for ${dealId}:`, error);
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
            // if (result) logTradeResult(dealId, result);
            try {
                const logPath = getCurrentTradesLogPath();
                const closeEntry = {
                    time: new Date().toISOString(),
                    id: dealId,
                    resultType: result?.type || result,
                    closePrice: result?.closePrice || null,
                    profitPips: result?.profitPips || null,
                };
                fs.appendFileSync(logPath, JSON.stringify(closeEntry) + "\n");
                logger.info(`[TradeLog] Logged closed trade result for ${dealId}: ${result?.type || result}`);
            } catch (err) {
                logger.error("[TradeLog] Failed to log trade result:", err);
            }
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
