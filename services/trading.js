import { RISK } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult, getCurrentTradesLogPath } from "../utils/tradeLogger.js";
import fs from "fs";
import { checkCalmRiver, greenRedCandlePattern } from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS, REQUIRED_SCORE } = RISK;

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

    generateSignal({ symbol, indicators, h1Trend, m1Candles, m5Candles, m15Candles, h1Candles, prev, last }) {
        if (!m5Candles || !m15Candles || !h1Candles) {
            logger.warn(`[generateSignal] Missing candles for ${symbol}`);
            return { signal: null, reason: "missing_data" };
        }

        const m5 = indicators.m5 || {};

        try {
            const calmSignal = checkCalmRiver(m5Candles, m5?.ema20, m5?.ema30, m5?.ema50, {
                ema20Prev: m5?.ema20Prev,
                ema30Prev: m5?.ema30Prev,
                ema50Prev: m5?.ema50Prev,
                ema20Series: m5?.ema20SeriesTail,
                ema50Series: m5?.ema50SeriesTail,
                atr: m5?.atr,
                macd: m5?.macd,
            });
            if (calmSignal) {
                logger.info(`[CalmRiver] ${symbol}: ${calmSignal} signal`);

                logger.info(`[Signal Analysis] ${symbol}
                    m5Candles: ${m5Candles.length}
                    M5 EMA20: ${m5?.ema20}
                    M5 EMA30: ${m5?.ema30}
                    M5 EMA50: ${m5?.ema50}
                    M5 MACD:  ${m5?.macd}
                `);

                return { signal: calmSignal, reason: "calm_river" };
            }

            return { signal: null, reason: "no_signal" };
        } catch (e) {
            logger.warn(`[CalmRiver] ${symbol}: check failed: ${e?.message || e}`);
        }
    }

    // --- Price rounding ---
    roundPrice(price, symbol, decimals) {
        const d = typeof decimals === "number" ? decimals : symbol.includes("JPY") ? 3 : 5;
        return Number(Number(price).toFixed(d));
    }

    // --- Position size + achievable SL/TP for M1 ---
    async calculateTradeParameters(signal, symbol, bid, ask, m1Candles) {
        try {
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

            // Ensure minimum SL distance to avoid excessively tight SLs
            // ... (existing code above unchanged)

            // Fetch allowed decimals and use for rounding
            const allowed = await getAllowedTPRange(symbol);
            const decimals = allowed?.decimals ?? (symbol.includes("JPY") ? 3 : 5);

            // Round prices to appropriate decimals
            stopLossPrice = this.roundPrice(stopLossPrice, symbol, decimals);
            takeProfitPrice = this.roundPrice(takeProfitPrice, symbol, decimals);

            // Calculate position size based on risk
            const maxSimultaneousTrades = MAX_POSITIONS;
            const riskAmount = (this.accountBalance * this.maxRiskPerTrade) / maxSimultaneousTrades;

            // For FX, pipValue = pip / price
            const pipValue = pip / price;
            let size = Math.floor(riskAmount / ((slDistance / pip) * pipValue) / 100) * 100;
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

    async executeTrade(symbol, signal, bid, ask, m1Candles, indicators = {}) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, m1Candles);
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
                logger.info(`[trading.js][Order] Placed position: ${symbol} ${signal} size=${size} entry=${price} SL=${stopLossPrice} TP=${takeProfitPrice} ref=${position.dealReference}`);

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
            const { indicators, h1Trend, h1Candles, m15Candles, m5Candles, m1Candles, bid, ask, prev, last } = message;

            if (!symbol || !indicators || !h1Candles || !m15Candles || !m5Candles || !m1Candles || bid == null || ask == null) return;

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
            const { signal, reason } = this.generateSignal(message);

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found`);
                await this.processSignal(symbol, signal, bid, ask, m1Candles, indicators);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found for reason: ${reason}`);
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

        const tp80 = direction === "BUY" ? entryPrice + tpDistance * 0.8 : entryPrice - tpDistance * 0.8;

        const reached80TP = direction === "BUY" ? currentPrice >= tp80 : currentPrice <= tp80;
        if (!reached80TP) return;
        const trailingBuffer = tpDistance * 0.1;
        const newStop = direction === "BUY" ? currentPrice - trailingBuffer : currentPrice + trailingBuffer;
        const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;
        if (!shouldUpdate) return;
        try {
            await updateTrailingStop(dealId, currentPrice, entryPrice, takeProfit, direction.toUpperCase(), position.symbol || position.market, position.isTrailing || false);
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
