import {
    placePosition,
    updateTrailingStop,
    getDealConfirmation,
    closePosition as apiClosePosition,
    closePositionPartially,
    getOpenPositions,
    getHistorical,
} from "../../api.js";
import { RISK } from "../../config.js";
import logger from "../../utils/logger.js";
import { logTradeClose, logTradeManagementEvent, logTradeOpen, tradeTracker } from "../../utils/tradeLogger.js";
import Strategy from "../../strategies/strategies.js";

const { MAX_POSITIONS } = RISK;

class BaseTradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
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

    normalizeDirection(direction) {
        return String(direction || "").toUpperCase();
    }

    oppositeDirection(direction) {
        const dir = this.normalizeDirection(direction);
        if (dir === "BUY") return "SELL";
        if (dir === "SELL") return "BUY";
        return null;
    }

    toNumber(value) {
        if (value === undefined || value === null || value === "") return null;
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    }

    firstNumber(...values) {
        for (const value of values) {
            const num = this.toNumber(value);
            if (num !== null) return num;
        }
        return null;
    }

    resolveMarketPrice(direction, bid, ask) {
        const dir = this.normalizeDirection(direction);
        if (dir === "BUY" && Number.isFinite(ask)) return ask;
        if (dir === "SELL" && Number.isFinite(bid)) return bid;
        if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
        return bid ?? ask ?? null;
    }

    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    getTpProgress(direction, entryPrice, takeProfit, currentPrice) {
        const entry = Number(entryPrice);
        const tp = Number(takeProfit);
        const price = Number(currentPrice);
        if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(price)) return null;
        const tpDist = Math.abs(tp - entry);
        if (tpDist <= 0) return null;
        const dir = this.normalizeDirection(direction);
        if (dir === "BUY") return (price - entry) / tpDist;
        if (dir === "SELL") return (entry - price) / tpDist;
        return null;
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    async syncOpenTradesFromBroker() {
        const res = await getOpenPositions();
        const positions = Array.isArray(res?.positions) ? res.positions : [];
        const symbols = positions.map((p) => p?.market?.epic ?? p?.position?.epic).filter(Boolean);
        this.openTrades = [...new Set(symbols)];
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
            const price = this.resolveMarketPrice(direction, bid, ask);

            return { symbol, direction, price };
        } catch (error) {
            logger.warn(`[ClosePos] Could not fetch position context for ${dealId}: ${error.message}`);
            return null;
        }
    }

    async calculateATR(symbol, timeframes) {
        try {
            const data = await getHistorical(symbol, timeframes.M15, 15);
            if (!data?.prices || data.prices.length < 14) {
                throw new Error("Insufficient data for ATR calculation");
            }

            const tr = [];
            const prices = data.prices;
            for (let i = 1; i < prices.length; i++) {
                const high = prices[i].highPrice?.ask || prices[i].high;
                const low = prices[i].lowPrice?.bid || prices[i].low;
                const prevClose = prices[i - 1].closePrice?.bid || prices[i - 1].close;
                const tr1 = high - low;
                const tr2 = Math.abs(high - prevClose);
                const tr3 = Math.abs(low - prevClose);
                tr.push(Math.max(tr1, tr2, tr3));
            }

            return tr.slice(-14).reduce((sum, val) => sum + val, 0) / 14;
        } catch (error) {
            logger.warn(`[ATR] Error for ${symbol}: ${error.message}`);
            return 0.001;
        }
    }

    // Must be implemented in symbol-specific services.
    async calculateTradeParameters() {
        throw new Error("calculateTradeParameters() must be implemented by subclass");
    }

    async executeTrade(symbol, signal, bid, ask, indicators, reason, context, timeframes) {
        try {
            const tradeParams = await this.calculateTradeParameters(signal, symbol, bid, ask, timeframes);
            if (!tradeParams) return;

            const { size, price, stopLossPrice, takeProfitPrice } = tradeParams;
            if (!Number.isFinite(size) || size <= 0) {
                logger.warn(`[Order] Skipping ${symbol}: invalid size ${size}`);
                return;
            }

            const pos = await placePosition(symbol, signal, size, price, stopLossPrice, takeProfitPrice);
            if (!pos?.dealReference) {
                logger.error(`[Order] Missing deal reference for ${symbol}`);
                return;
            }

            const confirmation = await getDealConfirmation(pos.dealReference);
            if (!["ACCEPTED", "OPEN"].includes(confirmation?.dealStatus)) {
                logger.error(`[Order] Not placed: ${confirmation?.reason || "unknown reason"}`);
                return;
            }

            logger.info(`[Order] OPENED ${symbol} ${signal} size=${size} entry=${price} SL=${stopLossPrice} TP=${takeProfitPrice}`);

            const affectedDealId = confirmation?.affectedDeals?.find((d) => d?.status === "OPENED")?.dealId;
            if (!affectedDealId) {
                logger.warn(`[Order] Missing dealId for ${symbol}, skipping trade log.`);
            } else {
                const entryPrice = confirmation?.level ?? price;
                const stopLossRounded = this.roundPrice(stopLossPrice, symbol);
                const takeProfitRounded = this.roundPrice(takeProfitPrice, symbol);

                logTradeOpen({
                    dealId: affectedDealId,
                    symbol,
                    signal,
                    openReason: reason,
                    entryPrice,
                    stopLoss: stopLossRounded,
                    takeProfit: takeProfitRounded,
                    indicatorsOnOpening: indicators,
                    timestamp: new Date().toISOString(),
                });

                tradeTracker.registerOpenDeal(affectedDealId, symbol);
            }

            this.openTrades.push(symbol);
        } catch (error) {
            logger.error(`[Order] Error placing order for ${symbol}:`, error);
        }
    }

    async processPrice({ symbol, indicators, candles, bid, ask, timeframes }) {
        try {
            await this.syncOpenTradesFromBroker();
            logger.info(`[ProcessPrice] Open trades: ${this.openTrades.length}/${MAX_POSITIONS} | Balance: ${this.accountBalance}€`);

            if (this.openTrades.length >= MAX_POSITIONS) {
                logger.info(`[ProcessPrice] Max trades reached. Skipping ${symbol}.`);
                return;
            }
            if (this.isSymbolTraded(symbol)) {
                logger.debug(`[ProcessPrice] ${symbol} already in market.`);
                return;
            }

            const result = Strategy.generateSignal({ symbol, indicators, bid, ask, candles });
            const { signal, reason = "", context = {} } = result;
            if (!signal) {
                const reasonCodes = Array.isArray(context?.reasonCodes) ? context.reasonCodes.filter(Boolean) : [];
                const regime = context?.regime ? ` | regime=${context.regime}` : "";
                const bias = context?.bias ? ` | bias=${context.bias}` : "";
                const codes = reasonCodes.length ? ` | codes=${reasonCodes.join(",")}` : "";
                logger.debug(`[Signal] ${symbol}: no signal (${reason})${regime}${bias}${codes}`);
                return;
            }

            logger.info(`[Signal] ${symbol}: ${signal}`);
            await this.executeTrade(symbol, signal, bid, ask, indicators, reason, context, timeframes);
        } catch (error) {
            logger.error("[ProcessPrice] Error:", error);
        }
    }

    async updateTrailingStopIfNeeded(position, indicators) {
        const { dealId, direction, entryPrice, stopLoss, takeProfit, currentPrice, symbol } = position;
        if (!dealId) return false;

        const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
        if (tpProgress === null || tpProgress < 0.7) return false;

        const m5 = indicators.m5;
        const m15 = indicators.m15;
        if (m5 && m15) {
            const m5Trend = Strategy.pickTrend(m5, { symbol, timeframe: "M5", atr: m5.atr });
            const m15Trend = Strategy.pickTrend(m15, { symbol, timeframe: "M15", atr: m15.atr });

            const broken =
                (direction === "BUY" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
                (direction === "SELL" && (m5Trend === "bullish" || m15Trend === "bullish"));

            if (broken) {
                return this.softExitToBreakeven(position);
            }
        }

        const entry = Number(entryPrice);
        const tp = Number(takeProfit);
        const price = Number(currentPrice);
        if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(price)) return false;
        const tpDist = Math.abs(tp - entry);
        if (tpDist <= 0) return false;

        const dir = this.normalizeDirection(direction);
        const activation = dir === "BUY" ? entry + tpDist * 0.7 : entry - tpDist * 0.7;
        const activated = (dir === "BUY" && price >= activation) || (dir === "SELL" && price <= activation);
        if (!activated) return false;

        const trailDist = tpDist * 0.2;
        const newSL = dir === "BUY" ? price - trailDist : price + trailDist;
        const stop = Number(stopLoss);
        if (Number.isFinite(stop)) {
            if ((dir === "BUY" && newSL <= stop) || (dir === "SELL" && newSL >= stop)) return false;
        }

        try {
            await updateTrailingStop(dealId, price, entry, tp, dir, symbol);
            logger.info(`[Trail] Updated SL -> ${newSL} for ${dealId}`);
            return true;
        } catch (error) {
            logger.error("[Trail] Error updating trailing stop:", error);
            return false;
        }
    }

    async softExitToBreakeven(position) {
        const { dealId, entryPrice, takeProfit, currentPrice, direction, symbol } = position;

        try {
            const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
            if (tpProgress === null || tpProgress < 0.7) {
                logger.info(`[SoftExit] Skipped breakeven: TP progress ${(tpProgress ?? 0).toFixed(2)} < 0.70 for ${dealId}`);
                return false;
            }

            await updateTrailingStop(dealId, currentPrice, entryPrice, takeProfit, direction, symbol);
            logger.info(`[SoftExit] ${symbol}: misalignment -> moved SL to breakeven for ${dealId}`);
            return true;
        } catch (error) {
            logger.error("[SoftExit] Error updating SL to breakeven:", error);
            return false;
        }
    }

    async closePartialPosition(position, sizeToClose, label = "partial_close") {
        const dealId = position?.dealId;
        const symbol = position?.symbol;
        const direction = this.normalizeDirection(position?.direction);
        const opposite = this.oppositeDirection(direction);
        const openSize = Number(position?.size);
        const requestedSize = Number(sizeToClose);

        if (!dealId || !opposite || !Number.isFinite(openSize) || !Number.isFinite(requestedSize) || requestedSize <= 0) {
            logger.warn(`[PartialClose] Invalid partial close request for ${symbol || "unknown"} (${dealId || "no-dealId"}).`);
            return false;
        }

        const closeSize = Math.min(requestedSize, openSize);
        if (!Number.isFinite(closeSize) || closeSize <= 0) return false;

        try {
            const response = await closePositionPartially({
                dealId,
                direction: opposite,
                size: closeSize,
                orderType: "MARKET",
            });

            logTradeManagementEvent({
                dealId,
                symbol,
                action: "PARTIAL_CLOSE",
                reasonCodes: [label],
                metrics: { closedSize: closeSize, openSize },
            });

            logger.info(`[PartialClose] ${symbol} ${dealId}: closed ${closeSize}/${openSize}`);
            return Boolean(response);
        } catch (error) {
            logger.error(`[PartialClose] Failed for ${symbol} ${dealId}:`, error.response?.data || error.message);
            return false;
        }
    }

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
        } catch (error) {
            logger.error(`[ClosePos] Error closing deal ${dealId}:`, error);
            return false;
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

            const brokerPrice = this.firstNumber(
                confirmation?.closeLevel,
                confirmation?.level,
                confirmation?.dealLevel,
                confirmation?.price,
                closePayload?.closeLevel,
                closePayload?.level,
                closePayload?.price,
                priceHint,
            );

            const brokerReason =
                confirmation?.reason ?? confirmation?.status ?? confirmation?.dealStatus ?? closePayload?.reason ?? closePayload?.status ?? null;

            const brokerReasonText = brokerReason ? String(brokerReason) : "";
            const requestedReasonText = requestedReason ? String(requestedReason) : "";
            const hasExplicitBrokerReason = /stop|sl|limit|tp|take|profit|loss/i.test(brokerReasonText);
            const hasGenericBrokerReason = /closed|close|deleted|cancel|rejected|filled|accepted/i.test(brokerReasonText);
            const finalReason = hasExplicitBrokerReason ? brokerReasonText : requestedReasonText || (!hasGenericBrokerReason && brokerReasonText) || "unknown";

            logTradeClose({
                dealId,
                symbol,
                closePrice: brokerPrice ?? priceHint ?? null,
                closeReason: finalReason,
                indicatorsOnClosing: indicatorSnapshot,
                timestamp: new Date().toISOString(),
            });

            tradeTracker.markDealClosed(dealId);
            return true;
        } catch (logError) {
            logger.error(`[ClosePos] Failed to log closure for ${dealId}:`, logError);
            return true;
        }
    }
}

export default BaseTradingService;
