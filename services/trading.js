import { RISK } from "../config.js";
import { placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";

import logger from "../utils/logger.js";
import { getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import fs from "fs";
import Strategy, { getPairRules } from "../strategies/strategies.js";

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
    async calculateTradeParameters(signal, symbol, bid, ask, context = {}) {
        const price = signal === "BUY" ? ask : bid;
        const { last, indicators } = context;
        const pairRules = getPairRules(symbol);

        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        const baseRange = Math.abs((last?.high ?? price) - (last?.low ?? price)) || pip * (symbol.includes("JPY") ? 6 : 15);
        const rawAtr = indicators?.m5?.atr;
        const atr = rawAtr && Number.isFinite(rawAtr) && rawAtr > 0 ? rawAtr : baseRange;

        const isJpy = symbol.includes("JPY");
        const atrRules = pairRules?.atr || {};
        const slMultiplier = atrRules.slMultiplier ?? (isJpy ? 1.4 : 1.15);
        const tpMultiplier = atrRules.tpMultiplier ?? (isJpy ? 1.05 : 1.25);
        const minPipDistance = pip * (symbol.includes("JPY") ? 8 : 15);

        const slDistance = Math.max(atr * slMultiplier, minPipDistance);
        const tpDistance = slDistance * tpMultiplier;

        let stopLossPrice, takeProfitPrice;

        if (signal === "BUY") {
            stopLossPrice = price - slDistance;
            takeProfitPrice = price + tpDistance;
        } else {
            stopLossPrice = price + slDistance;
            takeProfitPrice = price - tpDistance;
        }

        // ------------------------------------------------------------
        //                 Risk-Based Position Sizing
        // ------------------------------------------------------------
        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / MAX_POSITIONS;
        const pipValuePerUnit = pip / price;
        const slPips = slDistance / pip;

        let size = riskAmount / (slPips * pipValuePerUnit);
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        const rr = tpDistance / slDistance;

        logger.info(
            `[TradeParams] ${symbol} ${signal}
             Entry: ${price}
             SL: ${stopLossPrice}
             TP: ${takeProfitPrice}
             ATR: ${atr}
             SLdist(pips): ${slPips.toFixed(2)}
             RR: ${rr.toFixed(2)}
             Size: ${size}`
        );

        return { size, price, stopLossPrice, takeProfitPrice, atr, rr, pairRules };
    }

    // ============================================================
    //                    Place the Trade
    // ============================================================
    async executeTrade(symbol, signal, bid, ask, indicators, candles, context) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, {
                last: context.last,
                indicators,
            });

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
            await this.processSignal(symbol, signal, bid, ask, candles, indicators, context);
        } catch (err) {
            logger.error(`[ProcessPrice] Error:`, err);
        }
    }

    // ============================================================
    //                   Process the Signal
    // ============================================================
    async processSignal(symbol, signal, bid, ask, candles, indicators, context) {
        try {
            await this.executeTrade(symbol, signal, bid, ask, indicators, candles, context);
        } catch (err) {
            logger.error(`[Signal] Failed to process signal:`, err);
        }
    }

    // ============================================================
    //               Breakeven Soft Exit (NEW)
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
