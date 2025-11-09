import { ANALYSIS, RISK } from "../config.js";
import { placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition, getHistorical } from "../api.js";
import logger from "../utils/logger.js";
import { recordTradeOpen, recordTradeClose } from "../utils/tradeLogger.js";
import Strategy from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;
const { TIMEFRAMES } = ANALYSIS;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.lastTradeTimestamps = {};
        this.maxRiskPerTrade = PER_TRADE;
        this.dailyLoss = 0;
        this.dailyLossLimitPct = 0.05;
        this.tradeSnapshots = new Map();
        this.pendingClosures = new Set();
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

    getPipSize(symbol = "") {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    cloneCandles(series = []) {
        if (!Array.isArray(series)) return [];
        return series.map((candle) => ({ ...candle }));
    }

    getLastCandle(series = []) {
        if (!Array.isArray(series) || !series.length) return null;
        return series[series.length - 1];
    }

    buildEntrySnapshot(candles = {}) {
        return {
            m5Series: this.cloneCandles(candles?.m5Candles ?? []),
            m15Candle: this.getLastCandle(candles?.m15Candles ?? []),
            h1Candle: this.getLastCandle(candles?.h1Candles ?? []),
        };
    }

    async captureCloseSnapshot(symbol) {
        if (!symbol) {
            return { m5Series: [], m15Candle: null, h1Candle: null };
        }

        try {
            const [m5Data, m15Data, h1Data] = await Promise.all([
                getHistorical(symbol, TIMEFRAMES.M5, 50),
                getHistorical(symbol, TIMEFRAMES.M15, 10),
                getHistorical(symbol, TIMEFRAMES.H1, 10),
            ]);
            return {
                m5Series: m5Data?.prices ?? [],
                m15Candle: this.getLastCandle(m15Data?.prices ?? []),
                h1Candle: this.getLastCandle(h1Data?.prices ?? []),
            };
        } catch (error) {
            logger.error(`[TradeLog] Failed to capture close snapshot for ${symbol}:`, error);
            return { m5Series: [], m15Candle: null, h1Candle: null };
        }
    }

    buildProfitSummary(trade, closePrice) {
        if (!trade || closePrice == null || trade.entryPrice == null) {
            return { priceDiff: null, pips: null, result: "UNKNOWN" };
        }

        const direction = (trade.direction || "BUY").toUpperCase();
        const pipSize = this.getPipSize(trade.symbol || "");
        const directionalDiff = direction === "BUY" ? closePrice - trade.entryPrice : trade.entryPrice - closePrice;
        const priceDiff = Number.isFinite(directionalDiff) ? Number(directionalDiff.toFixed(6)) : null;
        const pips = priceDiff != null && pipSize ? Number((priceDiff / pipSize).toFixed(2)) : null;
        let result = "UNKNOWN";
        if (priceDiff != null) {
            if (priceDiff > 0) result = "PROFIT";
            else if (priceDiff < 0) result = "LOSS";
            else result = "BREAKEVEN";
        }

        return { priceDiff, pips, result };
    }

    inferCloseReason(trade, closePrice, providedReason) {
        if (providedReason) return providedReason;
        if (!trade || closePrice == null) return "UNKNOWN";

        const tolerance = this.getPipSize(trade.symbol || "") * 2;
        if (trade.takeProfit != null && Math.abs(closePrice - trade.takeProfit) <= tolerance) {
            return "TP";
        }
        if (trade.stopLoss != null && Math.abs(closePrice - trade.stopLoss) <= tolerance) {
            return "SL";
        }
        return "UNKNOWN";
    }

    registerTradeSnapshot({ dealId, symbol, direction, size, entryPrice, stopLossPrice, takeProfitPrice, candles, context }) {
        if (!dealId || !symbol) {
            logger.warn("[TradeLog] Unable to register trade snapshot: missing dealId or symbol.");
            return;
        }

        const entrySnapshot = this.buildEntrySnapshot(candles);
        const entryRecord = {
            id: dealId,
            symbol,
            direction,
            size,
            entry: {
                time: new Date().toISOString(),
                price: entryPrice,
                stopLoss: stopLossPrice,
                takeProfit: takeProfitPrice,
                candles: {
                    m5: entrySnapshot.m5Series,
                    m15: entrySnapshot.m15Candle,
                    h1: entrySnapshot.h1Candle,
                },
                strategyContext: context ?? null,
            },
            close: null,
        };

        try {
            recordTradeOpen(entryRecord);
            logger.info(`[TradeLog] Recorded entry for ${symbol} (${dealId})`);
        } catch (error) {
            logger.error(`[TradeLog] Failed to record entry for ${symbol} (${dealId}):`, error);
        }

        this.tradeSnapshots.set(dealId, {
            symbol,
            direction,
            size,
            entryPrice,
            stopLoss: stopLossPrice,
            takeProfit: takeProfitPrice,
            entryTime: entryRecord.entry.time,
        });
    }

    async finalizeTrade(dealId, { reason, closePrice, source = "monitor_loop" } = {}) {
        if (!dealId) return;
        if (this.pendingClosures.has(dealId)) return;

        const snapshot = this.tradeSnapshots.get(dealId);
        if (!snapshot) {
            logger.warn(`[TradeLog] No snapshot found for deal ${dealId}, skipping close log.`);
            return;
        }

        this.pendingClosures.add(dealId);
        try {
            const closeSnapshot = await this.captureCloseSnapshot(snapshot.symbol);
            const latestM5 = this.getLastCandle(closeSnapshot.m5Series);
            const resolvedClosePrice = closePrice ?? latestM5?.close ?? null;
            const closeRecord = {
                time: new Date().toISOString(),
                price: resolvedClosePrice,
                reason: this.inferCloseReason(snapshot, resolvedClosePrice, reason),
                candles: {
                    m5: latestM5,
                    m15: closeSnapshot.m15Candle,
                    h1: closeSnapshot.h1Candle,
                },
                profit: this.buildProfitSummary(snapshot, resolvedClosePrice),
                meta: {
                    source,
                },
            };

            recordTradeClose(dealId, closeRecord);
            logger.info(`[TradeLog] Recorded close for ${snapshot.symbol} (${dealId}) via ${closeRecord.reason || "UNKNOWN"}`);
        } catch (error) {
            logger.error(`[TradeLog] Failed to finalize trade ${dealId}:`, error);
        } finally {
            this.pendingClosures.delete(dealId);
            this.tradeSnapshots.delete(dealId);
        }
    }

    async handleDetectedClosedTrade(meta = {}) {
        const dealId = meta?.dealId;
        if (!dealId) return;
        if (!this.tradeSnapshots.has(dealId) || this.pendingClosures.has(dealId)) {
            return;
        }
        await this.finalizeTrade(dealId, { source: meta?.source || "monitor_loop" });
    }

    async calculateTradeParameters(signal, symbol, bid, ask, candles, context) {
        const pip = this.getPipSize(symbol);
        const recommended = context?.entrySetup;
        const { last } = recommended ?? context ?? {};

        let price = recommended?.entryPrice ?? (signal === "BUY" ? ask : bid);
        let stopLossPrice = recommended?.stopLoss;
        let takeProfitPrice = recommended?.takeProfit;

        if (stopLossPrice == null || takeProfitPrice == null) {
            // Fallback to candle-referenced SL/TP when no recommendation is provided
            if (!last) {
                throw new Error("Missing candle context for parameter calculation");
            }
            const candleSize = Math.max(last.high - last.low, pip * 6);
            if (signal === "BUY") {
                stopLossPrice = last.low - pip * 2;
                takeProfitPrice = price + candleSize * 2;
            } else {
                stopLossPrice = last.high + pip * 2;
                takeProfitPrice = price - candleSize * 2;
            }
        } else {
            // Guard against inverted SL/TP from context
            const minDistance = pip * 3;
            if (signal === "BUY") {
                if (stopLossPrice >= price - minDistance) {
                    stopLossPrice = price - minDistance;
                }
                if (takeProfitPrice <= price + minDistance) {
                    const rr = recommended?.rr ?? 1.8;
                    takeProfitPrice = price + Math.abs(price - stopLossPrice) * rr;
                }
            } else {
                if (stopLossPrice <= price + minDistance) {
                    stopLossPrice = price + minDistance;
                }
                if (takeProfitPrice >= price - minDistance) {
                    const rr = recommended?.rr ?? 1.8;
                    takeProfitPrice = price - Math.abs(price - stopLossPrice) * rr;
                }
            }
        }

        const slDistance = Math.abs(price - stopLossPrice);
        if (slDistance < pip * 3) {
            throw new Error("Stop loss distance too tight for position sizing");
        }

        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;
        const pipValuePerUnit = pip / price;
        const slPips = slDistance / pip;
        let size = riskAmount / (slPips * pipValuePerUnit);
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        const rrRatio = Math.abs(takeProfitPrice - price) / slDistance;
        logger.info(`[Trade Params] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice}
            TP: ${takeProfitPrice}
            RR: ${rrRatio.toFixed(2)}:1
            Size: ${size}
        `);

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

    async executeTrade(symbol, signal, bid, ask, indicators, candles, context) {
        if (!context?.prev) {
            logger.warn(`[${symbol}] Missing context for signal ${signal}, skipping trade.`);
            return;
        }
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, candles, context);
            // const { SL, TP } = await this.validateTPandSL(symbol, signal, price, stopLossPrice, takeProfitPrice);
            const position = await placePosition(symbol, signal, size, price, stopLossPrice, takeProfitPrice);

            if (!position?.dealReference) {
                logger.error(`[trading.js][Order] Deal reference is missing: ${JSON.stringify(position)}`);
                return;
            }
            const confirmation = await getDealConfirmation(position.dealReference);

            if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
                this.openTrades.push(symbol);
            } else {
                logger.info(
                    `[trading.js][Order] Placed position: ${symbol} ${signal} size=${size} entry=${price} SL=${stopLossPrice} TP=${takeProfitPrice} ref=${position.dealReference}`
                );
                const dealId = confirmation.dealId || confirmation.dealReference || position.dealReference;
                if (dealId) {
                    this.registerTradeSnapshot({
                        dealId,
                        symbol,
                        direction: signal?.toUpperCase(),
                        size,
                        entryPrice: price,
                        stopLossPrice,
                        takeProfitPrice,
                        candles,
                        context,
                    });
                } else {
                    logger.warn(`[TradeLog] Missing dealId for ${symbol} ${signal}, unable to log entry.`);
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

        // --- SOFT EXIT: if trend alignment breaks (M5 vs M15) ---
        const { m5, m15 } = indicators || {};
        if (m5 && m15) {
            const m5Trend = Strategy.trendFrom(m5.ema20, m5.ema50);
            const m15Trend = Strategy.trendFrom(m15.ema20, m15.ema50);

            const alignmentBroken =
                (direction === "BUY" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
                (direction === "SELL" && (m5Trend === "bullish" || m15Trend === "bullish"));

            if (alignmentBroken) {
                logger.info(`[SoftExit] ${symbol}: Trend misalignment detected (M5=${m5Trend}, M15=${m15Trend}). Closing position.`);
                await this.closePosition(dealId, "soft_exit");
                return;
            }
        }

        // --- Activation logic: 70% of TP ---
        const tpDistance = Math.abs(takeProfit - entryPrice);
        const activationLevel = direction === "BUY" ? entryPrice + tpDistance * 0.7 : entryPrice - tpDistance * 0.7;

        const reachedActivation = direction === "BUY" ? currentPrice >= activationLevel : currentPrice <= activationLevel;

        if (!reachedActivation) {
            logger.debug(`[TrailingStop] Position ${dealId} has not yet reached 70% TP activation.`);
            return;
        }

        // --- Trailing stop at 20% of TP distance from current price ---
        const trailDistance = tpDistance * 0.2;
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
            logger.info(`[TrailingStop] Updated stop to ${newStop.toFixed(5)} (10% TP logic) for ${dealId}`);
        } catch (error) {
            logger.error(`[TrailingStop] Error updating trailing stop for ${dealId}:`, error);
        }
    }

    async closePartialPosition(dealId, size) {
        try {
            await apiClosePosition(dealId, size);

            // remove from internal list
            this.openTrades = this.openTrades.filter((s) => s !== dealId && s !== symbol);
            logger.info(`[PartialTP] Successfully closed ${size} units for ${dealId}`);
        } catch (error) {
            logger.error(`[PartialTP] Failed to close partial position for ${dealId}:`, error);
        }
    }

    // --- Close position by dealId ---
    async closePosition(dealId, result) {
        const metadata =
            typeof result === "string"
                ? { reason: result, type: result }
                : result && typeof result === "object"
                ? result
                : {};

        try {
            await apiClosePosition(dealId);
            logger.info(`[API] Closed position for dealId: ${dealId}`);
            await this.finalizeTrade(dealId, {
                reason: metadata.type || metadata.reason,
                closePrice: metadata.closePrice,
                source: metadata.source || "manual_close",
            });
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
