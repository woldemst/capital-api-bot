import { ATR } from "technicalindicators";
import fs from "fs";

import { placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition, getHistorical } from "../api.js";
import { RISK, ANALYSIS } from "../config.js";
import logger from "../utils/logger.js";
import { getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import Strategy from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
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
    setAvailableMargin(m) {
        this.availableMargin = m;
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    // ============================================================
    //               ATR-Based Trade Parameters
    // ============================================================
    // async calculateTradeParameters(signal, symbol, bid, ask, context, indicators) {
    //     const price = signal === "BUY" ? ask : bid;
    //     const { last } = context;

    //     const isJPY = symbol.includes("JPY");
    //     const pip = isJPY ? 0.01 : 0.0001;

    //     // --- Candle characteristics ---
    //     const candleSize = last.high - last.low;
    //     const spread = Math.abs(ask - bid);

    //     // You can tweak these:
    //     const candleBufferFactor = 0.25; // 25% of candle size
    //     const extraBufferPips = 2; // fixed pip buffer
    //     const rr = 1.5; // risk:reward

    //     const candleBuffer = candleSize * candleBufferFactor;
    //     const extraBuffer = extraBufferPips * pip;

    //     let stopLossPrice;
    //     let takeProfitPrice;

    //     if (signal === "BUY") {
    //         // SL below the low of the signal candle
    //         stopLossPrice = last.low - candleBuffer - spread - extraBuffer;

    //         const slDistance = price - stopLossPrice;
    //         if (slDistance <= 0) {
    //             throw new Error(`[Trade Params] Invalid BUY SL distance for ${symbol}`);
    //         }

    //         takeProfitPrice = price + slDistance * rr;
    //     } else {
    //         // SELL: SL above the high of the signal candle
    //         stopLossPrice = last.high + candleBuffer + spread + extraBuffer;

    //         const slDistance = stopLossPrice - price;
    //         if (slDistance <= 0) {
    //             throw new Error(`[Trade Params] Invalid SELL SL distance for ${symbol}`);
    //         }

    //         takeProfitPrice = price - slDistance * rr;
    //     }

    //     // --- Risk management & position size ---
    //     const slDistance = Math.abs(price - stopLossPrice);
    //     const slPips = slDistance / pip;

    //     const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;

    //     // Simple pip-based model (approx): 1 pip move ≈ pip fraction of price
    //     // This is not exact CFD contract math, but good enough for backtesting & scaling.
    //     const pipValuePerUnit = pip / price;
    //     const lossPerUnitAtSL = slPips * pipValuePerUnit;

    //     let size = riskAmount / lossPerUnitAtSL;

    //     // Normalize size: 100-unit step, minimum 100
    //     size = Math.floor(size / 100) * 100;
    //     if (size < 100) size = 100;

    //     // --- Respect broker TP constraints if available ---
    //     try {
    //         const tpRange = await getAllowedTPRange(symbol, signal, price);
    //         if (tpRange) {
    //             const { minDistance, maxDistance } = tpRange; // in price units
    //             const tpDistance = Math.abs(takeProfitPrice - price);

    //             // If TP too close or too far, clamp it to allowed range but keep the direction.
    //             if (tpDistance < minDistance || (maxDistance && tpDistance > maxDistance)) {
    //                 const directionFactor = signal === "BUY" ? 1 : -1;
    //                 const clampedDistance = Math.min(Math.max(tpDistance, minDistance), maxDistance || tpDistance);
    //                 takeProfitPrice = price + directionFactor * clampedDistance;
    //             }
    //         }
    //     } catch (e) {
    //         logger.warn(`[Trade Params] Could not adjust TP to broker range for ${symbol}: ${e.message}`);
    //     }

    //     logger.info(
    //         `[Trade Params] ${symbol} ${signal}:
    //         Entry: ${price}
    //         SL: ${stopLossPrice}
    //         TP: ${takeProfitPrice}
    //         CandleSize: ${candleSize}
    //         Spread: ${spread}
    //         SL_pips: ${slPips.toFixed(1)}
    //         RR: ${(Math.abs(takeProfitPrice - price) / slDistance).toFixed(2)}:1
    //         Size: ${size}`
    //     );

    //     return { size, price, stopLossPrice, takeProfitPrice };
    // }

    async calculateTradeParameters(signal, symbol, bid, ask) {
        // Use ATR from the entry timeframe (M15)
        const price = signal === "BUY" ? ask : bid;
        const atr = await this.calculateATR(symbol); // Already uses M15 timeframe
        // ATR-based dynamic stops/TPs
        const stopLossDistance = 1.5 * atr;
        const takeProfitDistance = 3 * atr;
        const stopLossPrice = signal === "BUY" ? price - stopLossDistance : price + stopLossDistance;
        const takeProfitPrice = signal === "BUY" ? price + takeProfitDistance : price - takeProfitDistance;
        const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
        logger.info(`[calculateTradeParameters] ATR: ${atr}, Size: ${size}`);

        return { size, price, stopLossPrice, takeProfitPrice };
    }

    // ============================================================
    //                    ATR Calculation
    // ============================================================
    async calculateATR(symbol) {
        try {
            const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.M15, 30); // Request more bars for robustness
            if (!data?.prices || data.prices.length < 21) {
                logger.warn(`[ATR] Insufficient data for ATR calculation on ${symbol} (got ${data?.prices?.length || 0} bars). Using fallback value.`);
                return 0.001; // Fallback ATR value
            }
            // Use mid price for ATR calculation for consistency
            const highs = data.prices.map((b) => {
                if (b.high && typeof b.high === "object" && b.high.bid != null && b.high.ask != null) return (b.high.bid + b.high.ask) / 2;
                if (typeof b.high === "number") return b.high;
                return b.high?.bid ?? b.high?.ask ?? 0;
            });
            const lows = data.prices.map((b) => {
                if (b.low && typeof b.low === "object" && b.low.bid != null && b.low.ask != null) return (b.low.bid + b.low.ask) / 2;
                if (typeof b.low === "number") return b.low;
                return b.low?.bid ?? b.low?.ask ?? 0;
            });
            const closes = data.prices.map((b) => {
                if (b.close && typeof b.close === "object" && b.close.bid != null && b.close.ask != null) return (b.close.bid + b.close.ask) / 2;
                if (typeof b.close === "number") return b.close;
                return b.close?.bid ?? b.close?.ask ?? 0;
            });
            const atrArr = ATR.calculate({ period: 21, high: highs, low: lows, close: closes });
            return atrArr.length ? atrArr[atrArr.length - 1] : 0.001;
        } catch (error) {
            logger.error("[ATR] Error:", error);
            return 0.001;
        }
    }

    positionSize(balance, entryPrice, stopLossPrice, symbol) {
        // Strict risk management: never risk more than 2% of equity per trade
        const riskAmount = balance * 0.02; // 2% rule
        const pipValue = this.getPipValue(symbol);
        if (!pipValue || pipValue <= 0) {
            logger.error("Invalid pip value calculation");
            return 100; // Fallback with warning
        }
        const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
        if (stopLossPips === 0) return 0;
        // Calculate size so that (entry - stop) * size = riskAmount
        let size = riskAmount / (stopLossPips * pipValue);
        size = size * 1000;
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;
        // --- Margin check for 5 simultaneous trades (no max positions from config, just divide by 5) ---
        const leverage = RISK.LEVERAGE;
        const marginRequired = (size * entryPrice) / leverage;
        const availableMargin = balance;
        const maxMarginPerTrade = availableMargin / 5;
        if (marginRequired > maxMarginPerTrade) {
            size = Math.floor((maxMarginPerTrade * leverage) / entryPrice / 100) * 100;
            if (size < 100) size = 100;
            logger.info(`[PositionSize] Adjusted for margin: New size: ${size}`);
        }
        logger.info(
            `[PositionSize] Strict 2%% rule: Raw size: ${
                riskAmount / (stopLossPips * pipValue)
            }, Final size: ${size}, Margin required: ${marginRequired}, Max per trade: ${maxMarginPerTrade}`
        );
        return size;
    }
    // Add pip value determination
    getPipValue(symbol) {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    // ============================================================
    //                    Place the Trade
    // ============================================================
    async executeTrade(symbol, signal, bid, ask, indicators, candles, context) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask);

            const pos = await placePosition(symbol, signal, size, price, stopLossPrice, takeProfitPrice);

            if (!pos?.dealReference) {
                logger.error(`[Order] Missing deal reference for ${symbol}`);
                return;
            }

            const confirmation = await getDealConfirmation(pos.dealReference);
            if (!["ACCEPTED", "OPEN"].includes(confirmation.dealStatus)) {
                logger.error(`[Order] Not placed: ${confirmation.reason}`);
                return;
            }

            logger.info(`[Order] OPENED ${symbol} ${signal} size=${size} entry=${price} SL=${stopLossPrice} TP=${takeProfitPrice}`);

            this.openTrades.push(symbol);
        } catch (error) {
            logger.error(`[Order] Error placing order for ${symbol}:`, error);
        }
    }

    // ============================================================
    //                   MAIN PRICE LOOP
    // ============================================================
    async processPrice({ symbol, indicators, candles, bid, ask }) {
        try {
            if (this.openTrades.length >= MAX_POSITIONS) {
                logger.info(`[ProcessPrice] Max positions reached.`);
                return;
            }
            if (this.isSymbolTraded(symbol)) {
                logger.debug(`[ProcessPrice] ${symbol} already in market.`);
                return;
            }

            const { signal, reason, context } = Strategy.getSignal({
                symbol,
                indicators,
                candles,
                bid,
                ask,
            });

            if (!signal) {
                logger.debug(`[Signal] ${symbol}: no signal (${reason})`);
                return;
            }

            logger.info(`[Signal] ${symbol}: ${signal}`);
            await this.executeTrade(symbol, signal, bid, ask, indicators, candles, context);
        } catch (err) {
            logger.error(`[ProcessPrice] Error:`, err);
        }
    }

    // ============================================================
    //               Trailing Stop (Improved)
    // ============================================================
    async updateTrailingStopIfNeeded(position, indicators) {
        const { dealId, direction, entryPrice, stopLoss, takeProfit, currentPrice, symbol } = position;

        if (!dealId) return;

        // --- Trend misalignment → Breakeven exit ---
        const m5 = indicators.m5;
        const m15 = indicators.m15;
        if (m5 && m15) {
            const m5Trend = Strategy.pickTrend(m5, { symbol, timeframe: "M5", atr: m5.atr });
            const m15Trend = Strategy.pickTrend(m15, { symbol, timeframe: "M15", atr: m15.atr });

            const broken =
                (direction === "BUY" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
                (direction === "SELL" && (m5Trend === "bullish" || m15Trend === "bullish"));

            if (broken) {
                await this.softExitToBreakeven(position);
                return;
            }
        }

        const tpDist = Math.abs(takeProfit - entryPrice);
        const activation = direction === "BUY" ? entryPrice + tpDist * 0.7 : entryPrice - tpDist * 0.7;

        const activated = (direction === "BUY" && currentPrice >= activation) || (direction === "SELL" && currentPrice <= activation);

        if (!activated) return;

        const trailDist = tpDist * 0.2;
        let newSL = direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;

        if ((direction === "BUY" && newSL <= stopLoss) || (direction === "SELL" && newSL >= stopLoss)) return;

        try {
            await updateTrailingStop(dealId, currentPrice, newSL, null, direction.toUpperCase(), symbol, true);
            logger.info(`[Trail] Updated SL → ${newSL} for ${dealId}`);
        } catch (error) {
            logger.error(`[Trail] Error updating trailing stop:`, error);
        }
    }

    // ============================================================
    //               Breakeven Soft Exit
    // ============================================================
    async softExitToBreakeven(position) {
        const { dealId, entryPrice, direction, symbol } = position;

        const newSL = entryPrice;
        try {
            await updateTrailingStop(dealId, entryPrice, newSL, null, direction, symbol, true);

            logger.info(`[SoftExit] ${symbol}: misalignment → moved SL to breakeven for ${dealId}`);
        } catch (e) {
            logger.error(`[SoftExit] Error updating SL to breakeven:`, e);
        }
    }

    // ============================================================
    //                     Close Position
    // ============================================================
    async closePosition(dealId, label) {
        try {
            await apiClosePosition(dealId);
            logger.info(`[API] Closed ${dealId}`);

            const logPath = getCurrentTradesLogPath();
            fs.appendFileSync(
                logPath,
                JSON.stringify({
                    time: new Date().toISOString(),
                    id: dealId,
                    type: label,
                }) + "\n"
            );
        } catch (err) {
            logger.error(`[ClosePos] Error closing deal ${dealId}:`, err);
        }
    }
}

export default new TradingService();
