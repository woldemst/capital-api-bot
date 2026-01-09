import {
    placePosition,
    updateTrailingStop,
    getDealConfirmation,
    getAllowedTPRange,
    closePosition as apiClosePosition,
    getHistorical,
    getOpenPositions,
} from "../api.js";
import { RISK, ANALYSIS } from "../config.js";
import { calcIndicators } from "../indicators/indicators.js";
import logger from "../utils/logger.js";
import { logTradeClose, logTradeOpen, tradeTracker } from "../utils/tradeLogger.js";
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
        this.dealIds = new Set();
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

    async getPositionContext(dealId) {
        try {
            const positions = await getOpenPositions();
            const match = positions?.positions?.find((p) => p?.position?.dealId === dealId || p?.dealId === dealId);
            if (!match) return null;

            const symbol = match?.market?.epic || match?.position?.epic || match?.market?.instrumentName || null;
            const direction = match?.position?.direction;

            const bid = match?.market?.bid;
            const ask = match?.market?.offer ?? match?.market?.ask;
            const price =
                direction === "BUY" && Number.isFinite(ask)
                    ? ask
                    : direction === "SELL" && Number.isFinite(bid)
                    ? bid
                    : Number.isFinite(bid) && Number.isFinite(ask)
                    ? (bid + ask) / 2
                    : bid ?? ask ?? null;

            return { symbol, direction, price };
        } catch (error) {
            logger.warn(`[ClosePos] Could not fetch position context for ${dealId}: ${error.message}`);
            return null;
        }
    }

    // ============================================================
    //               ATR-Based Trade Parameters
    // ============================================================
    async calculateTradeParameters(signal, symbol, bid, ask, context, indicators) {
        const price = signal === "BUY" ? ask : bid;
        const { last } = context;

        const isJPY = symbol.includes("JPY");
        const pip = isJPY ? 0.01 : 0.0001;

        // --- Candle characteristics ---
        const candleSize = last.high - last.low;
        const spread = Math.abs(ask - bid);

        // You can tweak these:
        const candleBufferFactor = 0.25; // 25% of candle size
        const extraBufferPips = 2; // fixed pip buffer
        const rr = 1.5; // risk:reward

        const candleBuffer = candleSize * candleBufferFactor;
        const extraBuffer = extraBufferPips * pip;

        let stopLossPrice;
        let takeProfitPrice;

        if (signal === "BUY") {
            // SL below the low of the signal candle
            stopLossPrice = last.low - candleBuffer - spread - extraBuffer;

            const slDistance = price - stopLossPrice;
            if (slDistance <= 0) {
                throw new Error(`[Trade Params] Invalid BUY SL distance for ${symbol}`);
            }

            takeProfitPrice = price + slDistance * rr;
        } else {
            // SELL: SL above the high of the signal candle
            stopLossPrice = last.high + candleBuffer + spread + extraBuffer;

            const slDistance = stopLossPrice - price;
            if (slDistance <= 0) {
                throw new Error(`[Trade Params] Invalid SELL SL distance for ${symbol}`);
            }

            takeProfitPrice = price - slDistance * rr;
        }

        // --- Risk management & position size ---
        const slDistance = Math.abs(price - stopLossPrice);
        const slPips = slDistance / pip;

        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;

        // Simple pip-based model (approx): 1 pip move ≈ pip fraction of price
        // This is not exact CFD contract math, but good enough for backtesting & scaling.
        const pipValuePerUnit = pip / price;
        const lossPerUnitAtSL = slPips * pipValuePerUnit;

        let size = riskAmount / lossPerUnitAtSL;

        // Normalize size: 100-unit step, minimum 100
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        // --- Respect broker TP constraints if available ---
        try {
            const tpRange = await getAllowedTPRange(symbol, signal, price);
            if (tpRange) {
                const { minDistance, maxDistance } = tpRange; // in price units
                const tpDistance = Math.abs(takeProfitPrice - price);

                // If TP too close or too far, clamp it to allowed range but keep the direction.
                if (tpDistance < minDistance || (maxDistance && tpDistance > maxDistance)) {
                    const directionFactor = signal === "BUY" ? 1 : -1;
                    const clampedDistance = Math.min(Math.max(tpDistance, minDistance), maxDistance || tpDistance);
                    takeProfitPrice = price + directionFactor * clampedDistance;
                }
            }
        } catch (e) {
            logger.warn(`[Trade Params] Could not adjust TP to broker range for ${symbol}: ${e.message}`);
        }

        logger.info(
            `[Trade Params] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice}
            TP: ${takeProfitPrice}
            CandleSize: ${candleSize}
            Spread: ${spread}
            SL_pips: ${slPips.toFixed(1)}
            RR: ${(Math.abs(takeProfitPrice - price) / slDistance).toFixed(2)}:1
            Size: ${size}`
        );

        return { size, price, stopLossPrice, takeProfitPrice };
    }

    // async calculateTradeParameters(signal, symbol, bid, ask, indicators) {
    //     // Use ATR from the entry timeframe (M15)
    //     const price = signal === "BUY" ? ask : bid;
    //     // const atr = await this.calculateATR(symbol); // Already uses M15 timeframe
    //     const atr = indicators?.m15?.atr;

    //     // ATR-based dynamic stops/TPs
    //     const stopLossDistance = 1.5 * atr;
    //     const takeProfitDistance = 3 * atr;
    //     const stopLossPrice = signal === "BUY" ? price - stopLossDistance : price + stopLossDistance;
    //     const takeProfitPrice = signal === "BUY" ? price + takeProfitDistance : price - takeProfitDistance;
    //     const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
    //     logger.info(`[calculateTradeParameters] ATR: ${atr}, Size: ${size}`);

    //     //     // --- Respect broker TP constraints if available ---
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
    //     const slDistance = Math.abs(price - stopLossPrice);

    //     logger.info(
    //         `[Trade Params] ${symbol} ${signal}:
    //             Entry: ${price}
    //             SL: ${stopLossPrice}
    //             TP: ${takeProfitPrice}
    //             RR: ${(Math.abs(takeProfitPrice - price) / slDistance).toFixed(2)}:1
    //             Size : ${size}`
    //     );
    //     return { size, price, stopLossPrice, takeProfitPrice };
    // }

    positionSize(balance, price, stopLossPrice, symbol) {
        const isJPY = symbol.includes("JPY");
        const pip = isJPY ? 0.01 : 0.0001;

        // --- Risk management & position size ---
        const slDistance = Math.abs(price - stopLossPrice);
        const slPips = slDistance / pip;

        const riskAmount = (balance * this.maxRiskPerTrade) / MAX_POSITIONS;

        // Simple pip-based model (approx): 1 pip move ≈ pip fraction of price
        // This is not exact CFD contract math, but good enough for backtesting & scaling.
        const pipValuePerUnit = pip / price;
        const lossPerUnitAtSL = slPips * pipValuePerUnit;

        let size = riskAmount / lossPerUnitAtSL;
        if (size < 100) size = 100;

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
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, context, indicators);

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

            console.log("confirmation", confirmation);
            const affectedDealId = confirmation?.affectedDeals?.find((d) => d?.status === "OPENED")?.dealId;
            // or: const affectedDealId = confirmation?.affectedDeals?.[0]?.dealId;

            try {
                if (!affectedDealId) {
                    logger.warn(`[Order] Missing dealId for ${symbol}, skipping trade log.`);
                } else {
                    // const indicatorSnapshot = this.buildIndicatorSnapshot(indicators, price, symbol);
                    const entryPrice = confirmation?.level ?? price;
                    const logTimestamp = new Date().toISOString();

                    logTradeOpen({
                        dealId: affectedDealId,
                        symbol,
                        signal,
                        entryPrice,
                        stopLoss: stopLossPrice.toFixed(5),
                        takeProfit: takeProfitPrice.toFixed(5),
                        // indicators: indicatorSnapshot,
                        indicators: indicators,
                        timestamp: logTimestamp,
                    });

                    tradeTracker.registerOpenDeal(affectedDealId, symbol);
                    // track open deal in memory
                }
            } catch (logError) {
                logger.error(`[Order] Failed to log open trade for ${symbol}:`, logError);
            }

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
            if (this.dealIds.size >= MAX_POSITIONS) {
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
        const requestedReason = label || "manual_close";
        let symbol;
        let priceHint;
        let indicatorSnapshot = null;
        let closePayload;
        let confirmation;

        try {
            const context = await this.getPositionContext(dealId);
            if (context) {
                symbol = context.symbol;
                priceHint = context.price;
            }
        } catch (contextError) {
            logger.warn(`[ClosePos] Could not capture close snapshot for ${dealId}: ${contextError.message}`);
        }

        try {
            if (symbol) {
                indicatorSnapshot = await tradeTracker.getCloseIndicators(symbol);
            }
        } catch (snapshotError) {
            logger.warn(`[ClosePos] Could not capture close indicators for ${dealId}: ${snapshotError.message}`);
        }

        try {
            closePayload = await apiClosePosition(dealId);
            logger.info(`[ClosePos] Raw close payload for ${dealId}:`, closePayload);
        } catch (err) {
            logger.error(`[ClosePos] Error closing deal ${dealId}:`, err);
            return;
        }

        try {
            if (closePayload?.dealReference) {
                try {
                    confirmation = await getDealConfirmation(closePayload.dealReference);
                    logger.info(`[ClosePos] Close confirmation for ${dealId}:`, confirmation);
                } catch (confirmError) {
                    logger.warn(`[ClosePos] Close confirmation failed for ${dealId}: ${confirmError.message}`);
                }
            }

            const toNumber = (value) => {
                if (value === undefined || value === null || value === "") return null;
                const num = typeof value === "number" ? value : Number(value);
                return Number.isFinite(num) ? num : null;
            };

            const firstNumber = (...values) => {
                for (const value of values) {
                    const num = toNumber(value);
                    if (num !== null) return num;
                }
                return null;
            };

            const brokerPrice = firstNumber(
                confirmation?.closeLevel,
                confirmation?.level,
                confirmation?.dealLevel,
                confirmation?.price,
                closePayload?.closeLevel,
                closePayload?.level,
                closePayload?.price,
                priceHint
            );

            const brokerReason =
                confirmation?.reason ??
                confirmation?.status ??
                confirmation?.dealStatus ??
                closePayload?.reason ??
                closePayload?.status ??
                null;

            const finalReason = brokerReason || requestedReason || "unknown";

            logger.info("[ClosePos] Derived closeReason", {
                dealId,
                requestedReason,
                brokerReason,
                finalReason,
                closePrice: brokerPrice,
                priceHint,
                hasConfirmation: Boolean(confirmation),
            });

            const updated = logTradeClose({
                dealId,
                symbol,
                closePrice: brokerPrice ?? priceHint ?? null,
                closeReason: finalReason,
                indicators: indicatorSnapshot,
                timestamp: new Date().toISOString(),
            });
            if (updated) tradeTracker.markDealClosed(dealId);
        } catch (logErr) {
            logger.error(`[ClosePos] Failed to log closure for ${dealId}:`, logErr);
        }
    }
}

export default new TradingService();
