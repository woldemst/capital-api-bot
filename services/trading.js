import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition, getHistorical } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult, getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import fs from "fs";
const { MAX_POSITIONS, RISK_PER_TRADE } = TRADING;

// Add a default required score for signals
const REQUIRED_SCORE = TRADING.REQUIRED_SCORE;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.lastTradeTimestamps = {};
        this.maxRiskPerTrade = RISK_PER_TRADE;
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

    detectPattern(trend, prev, last) {
        if (!prev || !last || !trend) return false;

        // Support both {open, close} and {o, c}
        const getOpen = (c) => (typeof c.o !== "undefined" ? c.o : c.open);
        const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

        if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) {
            return false;
        }

        const isBullish = (c) => getClose(c) > getOpen(c);
        const isBearish = (c) => getClose(c) < getOpen(c);

        const trendDirection = String(trend).toLowerCase();

        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            // red -> green in bullish trend
            return "bullish";
        }
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            // green -> red in bearish trend
            return "bearish";
        }
        return false;
    }

    generateSignal({ symbol, indicators, trendAnalysis, m1Candles, m5Candles, m15Candles, bid, ask, h1Candles }) {
        const { m1, m5, m15, h1 } = indicators || {};
        if (!m1 || !m5 || !m15 || !h1 || !m1Candles || !m5Candles || !m15Candles || !h1Candles) {
            logger.warn(`[Signal] Missing indicators/candles for ${symbol}`);
            return { signal: null, buyScore: 0, sellScore: 0, metrics: {} };
        }

        // --- 1) Determine H1 trend (EMA fast vs slow or isBullishTrend if provided) ---
        let h1Trend = "neutral";
        if (typeof h1.isBullishTrend === "boolean") {
            h1Trend = h1.isBullishTrend ? "bullish" : "bearish";
        } else if (typeof h1.emaFast === "number" && typeof h1.emaSlow === "number") {
            h1Trend = h1.emaFast > h1.emaSlow ? "bullish" : "bearish";
        } else if (trendAnalysis && typeof trendAnalysis.h1Trend === "string") {
            h1Trend = trendAnalysis.h1Trend.toLowerCase();
        }

        // --- 2) Take the last two CLOSED M15 candles: prev = second last, last = last closed ---
        if (m15Candles.length < 3) {
            return { signal: null, reason: "not_enough_m15_candles" };
        }
        const prev = m15Candles[m15Candles.length - 3]; // previous closed
        const last = m15Candles[m15Candles.length - 2]; // most recent closed

        const patternDir = this.detectPattern(h1Trend, prev, last);
        if (!patternDir) {
            logger.info(`[Signal Analysis] ${symbol}: No valid M15 pattern for H1 trend (${h1Trend}).`);
            return { signal: null, reason: "no_valid_pattern" };
        }

        // --- 3) Indicator confirmation (simple, fast to compute) ---
        const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

        // Use M15 RSI/MACD/ADX + H1 EMAs & EMA9 for momentum
        const rsi15 = typeof m15.rsi === "number" ? m15.rsi : null;
        const macd15 = m15.macd || null;
        const macd15Hist = macd15 && typeof macd15.histogram === "number" ? macd15.histogram : null;
        const adx15 = typeof m15.adx === "number" ? m15.adx : null;

        const ema9h1 = typeof h1.ema9 === "number" ? h1.ema9 : null;
        const ema21h1 = typeof h1.ema21 === "number" ? h1.ema21 : null;
        const emaFastH1 = typeof h1.emaFast === "number" ? h1.emaFast : null;
        const emaSlowH1 = typeof h1.emaSlow === "number" ? h1.emaSlow : null;

        const lastClose = getClose(last);

        // Build conditions explicitly
        const buyConditions = [
            h1Trend === "bullish",
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : true,
            ema9h1 != null ? lastClose > ema9h1 : true,
            rsi15 != null ? rsi15 > 50 : true,
            macd15Hist != null ? macd15Hist > 0 : true,
            adx15 != null ? adx15 > 20 : true,
        ];

        const sellConditions = [
            h1Trend === "bearish",
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : true,
            ema9h1 != null ? lastClose < ema9h1 : true,
            rsi15 != null ? rsi15 < 50 : true,
            macd15Hist != null ? macd15Hist < 0 : true,
            adx15 != null ? adx15 > 20 : true,
        ];

        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        // Decide signal
        const threshold = typeof REQUIRED_SCORE === "number" && REQUIRED_SCORE > 0 ? REQUIRED_SCORE : 3;
        let signal = null;
        if (patternDir === "bullish" && buyScore >= threshold) signal = "BUY";
        if (patternDir === "bearish" && sellScore >= threshold) signal = "SELL";
        // if (patternDir === "bullish") signal = "BUY";
        // if (patternDir === "bearish") signal = "SELL";

        logger.info(`[Signal Analysis] ${symbol}
            H1 Trend: ${h1Trend}
            Pattern: ${patternDir}
            BuyScore: ${buyScore}/${buyConditions.length}
            SellScore: ${sellScore}/${sellConditions.length}
            M15 RSI: ${rsi15}
            M15 MACD hist: ${macd15Hist}
            M15 ADX: ${adx15}
        `);

        if (!signal) {
            return { signal: null, reason: "score_too_low", buyScore, sellScore };
        }

        return {
            signal,
            buyScore,
            sellScore,
            reason: "pattern_and_score_passed",
            metrics: {
                rsi15: rsi15,
                macd15Hist,
                ema9h1,
                ema21h1,
                emaFastH1,
                emaSlowH1,
                adx15,
            },
        };
    }

    // --- Price rounding ---
    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    // --- Position size + achievable SL/TP for M1 ---
    async calculateTradeParameters(signal, symbol, bid, ask, m1Candles) {
        const price = signal === "BUY" ? ask : bid;

        // Use previous M1 candle for SL
        const prevCandle = m1Candles && m1Candles.length > 1 ? m1Candles[m1Candles.length - 2] : null;
        if (!prevCandle) throw new Error("Not enough M1 candles for SL calculation");

        // Add slightly larger buffer to reduce early stop-outs (0.8-1 pip)
        const buffer = symbol.includes("JPY") ? 0.08 : 0.0008;

        let stopLossPrice, slDistance, takeProfitPrice;

        if (signal === "BUY") {
            // For BUY: SL below previous candle low
            stopLossPrice = prevCandle.low - buffer;
            slDistance = price - stopLossPrice;
            // TP = entry + (1.8 × SL distance) -> larger TP to avoid whipsaws
            takeProfitPrice = price + slDistance * 1.8;
        } else {
            // For SELL: SL above previous candle high
            stopLossPrice = prevCandle.high + buffer;
            slDistance = stopLossPrice - price;
            // TP = entry - (1.8 × SL distance)
            takeProfitPrice = price - slDistance * 1.8;
        }

        // Ensure minimum SL distance to avoid excessively tight SLs
        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        const minSlPips = symbol.includes("JPY") ? 12 : 10; // slightly larger minimum SL
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

        // Round prices to appropriate decimals
        stopLossPrice = this.roundPrice(stopLossPrice, symbol);
        takeProfitPrice = this.roundPrice(takeProfitPrice, symbol);

        // Calculate position size based on risk
        const maxSimultaneousTrades = MAX_POSITIONS || 5;
        const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / maxSimultaneousTrades;
        let size = riskAmount / Math.abs(slDistance);
        size = Math.floor(size / 100) * 100; // Round to nearest 100
        if (size < 100) size = 100; // Minimum size

        logger.info(`[Trade Parameters] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice} (${slDistance.toFixed(5)} points)
            TP: ${takeProfitPrice}
            Size: ${size}`);

        return {
            size,
            price,
            stopLossPrice,
            takeProfitPrice,
        };
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

    // --- Trade execution ---
    async executeTrade(symbol, signal, bid, ask, m1Candles, indicators = {}) {
        const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, m1Candles);
        const { SL, TP } = await this.validateTPandSL(symbol, signal, price, stopLossPrice, takeProfitPrice);
        const position = await placePosition(symbol, signal, size, price, SL, TP);
        if (position?.dealReference) {
            const confirmation = await getDealConfirmation(position.dealReference);
            if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
            } else {
                logger.info(`[trading.js][Order] Placed position: ${symbol} ${signal} size=${size} entry=${price} SL=${SL} TP=${TP} ref=${position.dealReference}`);
                // Log opened trade to monthly log for later ML training
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
                        indicators: {
                            emaFast: indicators?.h1?.emaFast,
                            emaSlow: indicators?.h1?.emaSlow,
                            ema9: indicators?.h1?.ema9,
                            ema21: indicators?.h1?.ema21,
                            rsi15: indicators?.m15?.rsi,
                            macd15Hist: indicators?.m15?.macd?.histogram,
                            atr: indicators?.m1?.atr,
                        },
                        result: null,
                    };
                    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
                    logger.info(`[TradeLog] Logged opened trade ${position.dealReference} to ${logPath}`);
                } catch (err) {
                    logger.error("[TradeLog] Failed to append opened trade:", err);
                }
            }
        }
    }

    //  Main price processing ---
    async processPrice(message) {
        try {
            const { symbol, indicators, trendAnalysis, h1Candles, m15Candles, m5Candles, m1Candles, bid, ask, prev, last } = message;

            if (!symbol || !indicators || !h1Candles || !m15Candles || !m5Candles || !m1Candles || !bid || !ask) return;

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
            const { signal } = this.generateSignal(message);

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found`);
                await this.processSignal(symbol, signal, bid, ask, m1Candles, indicators);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found`);
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    // --- Signal processing ---
    async processSignal(symbol, signal, bid, ask, m1Candles, indicators = {}) {
        try {
            await this.executeTrade(symbol, signal, bid, ask, m1Candles, indicators);
            logger.info(`[Signal] Successfully processed ${signal.toUpperCase()} signal for ${symbol}`);
        } catch (error) {
            logger.error(`[trading.js][Signal] Failed to process ${signal} signal for ${symbol}:`, error);
        }
    }

    // --- Trailing stop logic (unchanged) ---
    async updateTrailingStopIfNeeded(position) {
        const { dealId, direction, entryPrice, takeProfit, stopLoss, currentPrice } = position;

        const tpDistance = Math.abs(takeProfit - entryPrice);

        const tp60 = direction === "BUY" ? entryPrice + tpDistance * 0.6 : entryPrice - tpDistance * 0.6;

        const reached60TP = direction === "BUY" ? currentPrice >= tp60 : currentPrice <= tp60;
        if (!reached60TP) return;
        const trailingBuffer = tpDistance * 0.1;
        const newStop = direction === "BUY" ? currentPrice - trailingBuffer : currentPrice + trailingBuffer;
        const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;
        if (!shouldUpdate) return;
        try {
            await updateTrailingStop(
                dealId,
                currentPrice, // latest market price
                entryPrice, // entry
                takeProfit, // planned TP
                direction.toUpperCase(), // ensure uppercase
                position.symbol || position.market, // epic/symbol
                position.isTrailing || false // if you track trailing status
            );
            logger.info(`[TrailingStop] Updated trailing stop for ${dealId}: ${newStop}`);

            // 2. Disable TP after first trailing activation
            // if (!position.tpDisabled) {
            //     await updateTrailingStop(
            //         dealId,
            //         currentPrice,
            //         entryPrice,
            //         null, // set TP to null to disable
            //         direction.toUpperCase(),
            //         position.symbol || position.market,
            //         true
            //     );
            //     position.tpDisabled = true; // mark so we don’t call it again
            //     logger.info(`[TrailingStop] Disabled TP for ${dealId}, now managed only by SL`);
            // }
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
