import { placePosition, updateTrailingStop, getDealConfirmation, closePosition as apiClosePosition, getOpenPositions } from "../api.js";
import { RISK } from "../config.js";
import logger from "../utils/logger.js";
import { logTradeClose, logTradeOpen, tradeTracker } from "../utils/tradeLogger.js";
import Strategy from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;

class TradingService {
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
    setAvailableMargin(m) {
        this.availableMargin = m;
    }

    normalizeDirection(direction) {
        return String(direction || "").toUpperCase();
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

    getPipValue(symbol) {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
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

    // ============================================================
    //               ATR-Based Trade Parameters
    // ============================================================

    async resolveAtr(indicators, symbol) {
        const indicatorAtr = indicators?.m15?.atr ?? indicators?.m5?.atr ?? indicators?.h1?.atr;
        if (Number.isFinite(indicatorAtr) && indicatorAtr > 0) return indicatorAtr;
        logger.warn(`[ATR] Missing indicator ATR for ${symbol}; skipping trade.`);
        return null;
    }

    async calculateTradeParameters(signal, symbol, bid, ask, indicators) {
        const side = String(signal || "").toLowerCase();
        const isBuy = side === "buy";
        const price = isBuy ? ask : bid;
        const atr = await this.resolveAtr(indicators, symbol);
        if (!Number.isFinite(atr) || atr <= 0) {
            throw new Error(`[ATR] Invalid indicator ATR for ${symbol}`);
        }
        const stopLossPips = 1.5 * atr;
        const stopLossPrice = isBuy ? price - stopLossPips : price + stopLossPips;
        const takeProfitPips = 2 * stopLossPips; // 2:1 reward-risk ratio
        const takeProfitPrice = isBuy ? price + takeProfitPips : price - takeProfitPips;
        const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
        console.log(`[calculateTradeParameters] Size: ${size}`);

        // Trailing stop parameters
        const trailingStopParams = {
            activationPrice:
                isBuy
                    ? price + stopLossPips // Activate at 1R profit
                    : price - stopLossPips,
            trailingDistance: atr, // Trail by 1 ATR
        };

        return {
            size,
            price,
            stopLossPrice,
            takeProfitPrice,
            stopLossPips,
            takeProfitPips,
            trailingStopParams,
            partialTakeProfit: isBuy ? price + stopLossPips : price - stopLossPips,
        };
    }

    positionSize(balance, entryPrice, stopLossPrice, symbol) {
        const riskAmount = balance * PER_TRADE;
        const pipValue = this.getPipValue(symbol); // Dynamic pip value

        if (!pipValue || pipValue <= 0) {
            console.error("Invalid pip value calculation");
            return 100; // Fallback with warning
        }

        const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
        if (stopLossPips === 0) return 0;

        let size = riskAmount / (stopLossPips * pipValue);
        // Convert to units (assuming size is in lots, so multiply by 1000)
        size = size * 1000;
        // Floor to nearest 100
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        // --- Margin check for 5 simultaneous trades ---
        // Assume leverage is 30:1 for forex (can be adjusted)
        const leverage = 30;
        // Normalize JPY pricing (100x) to keep margin check consistent with non-JPY pairs
        const priceForMargin = symbol.includes("JPY") ? entryPrice / 100 : entryPrice;
        // Margin required = (size * entryPrice) / leverage
        const marginRequired = (size * priceForMargin) / leverage;
        // Use available margin from account (set by updateAccountInfo)
        const availableMargin = this.accountBalance; // You may want to use a more precise available margin if tracked
        // Ensure margin for one trade is no more than 1/5 of available
        const maxMarginPerTrade = availableMargin / 5;
        if (marginRequired > maxMarginPerTrade) {
            // Reduce size so marginRequired == maxMarginPerTrade
            size = Math.floor((maxMarginPerTrade * leverage) / priceForMargin / 100) * 100;
            if (size < 100) size = 100;
            console.log(`[PositionSize] Adjusted for margin: New size: ${size}`);
        }
        console.log(
            `[PositionSize] Raw size: ${riskAmount / (stopLossPips * pipValue)}, Final size: ${size}, Margin required: ${marginRequired}, Max per trade: ${maxMarginPerTrade}`,
        );
        return size;
    }

    // ============================================================
    //                    Place the Trade
    // ============================================================
    async executeTrade(symbol, signal, bid, ask, indicators, context) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, indicators);

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
                    const stopLossRounded = this.roundPrice(stopLossPrice, symbol);
                    const takeProfitRounded = this.roundPrice(takeProfitPrice, symbol);
                    const logTimestamp = new Date().toISOString();

                    logTradeOpen({
                        dealId: affectedDealId,
                        symbol,
                        signal,
                        entryPrice,
                        stopLoss: stopLossRounded,
                        takeProfit: takeProfitRounded,
                        indicatorsOnOpening: indicators,
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

            const { signal, reason = {}, context = {} } = result;

            if (!signal) {
                logger.debug(`[Signal] ${symbol}: no signal (${reason})`);
                return;
            }

            logger.info(`[Signal] ${symbol}: ${signal}`);
            await this.executeTrade(symbol, signal, bid, ask, indicators, context);
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

        const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
        if (tpProgress === null || tpProgress < 0.7) {
            return; // activate trailing stop only after 70% TP progress
        }

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

        const entry = Number(entryPrice);
        const tp = Number(takeProfit);
        const price = Number(currentPrice);
        if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(price)) return;
        const tpDist = Math.abs(tp - entry);
        if (tpDist <= 0) return;

        const dir = this.normalizeDirection(direction);
        const activation = dir === "BUY" ? entry + tpDist * 0.7 : entry - tpDist * 0.7;

        const activated = (dir === "BUY" && price >= activation) || (dir === "SELL" && price <= activation);

        if (!activated) return;

        const trailDist = tpDist * 0.2;
        let newSL = dir === "BUY" ? price - trailDist : price + trailDist;

        const stop = Number(stopLoss);
        if (Number.isFinite(stop)) {
            if ((dir === "BUY" && newSL <= stop) || (dir === "SELL" && newSL >= stop)) return;
        }

        try {
            await updateTrailingStop(dealId, price, entry, tp, dir, symbol);
            logger.info(`[Trail] Updated SL → ${newSL} for ${dealId}`);
        } catch (error) {
            logger.error(`[Trail] Error updating trailing stop:`, error);
        }
    }

    // ============================================================
    //               Breakeven Soft Exit
    // ============================================================
    async softExitToBreakeven(position) {
        const { dealId, entryPrice, takeProfit, currentPrice, direction, symbol } = position;

        const newSL = entryPrice;
        try {
            const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
            if (tpProgress === null || tpProgress < 0.7) {
                logger.info(`[SoftExit] Skipped breakeven: TP progress ${(tpProgress ?? 0).toFixed(2)} < 0.70 for ${dealId}`);
                return;
            }

            await updateTrailingStop(dealId, currentPrice, entryPrice, takeProfit, direction, symbol);

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
                indicatorsOnClosing: indicatorSnapshot,
                timestamp: new Date().toISOString(),
            });
            if (updated) tradeTracker.markDealClosed(dealId);
        } catch (logErr) {
            logger.error(`[ClosePos] Failed to log closure for ${dealId}:`, logErr);
        }
    }
}

export default new TradingService();
