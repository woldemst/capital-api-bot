import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition, getHistorical } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult } from "../utils/tradeLogger.js";
const { MAX_POSITIONS, RISK_PER_TRADE } = TRADING;

// Add a default required score for signals
const REQUIRED_SCORE = TRADING.REQUIRED_SCORE || 4;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.lastTradeTimestamps = {};
        this.maxRiskPerTrade = RISK_PER_TRADE || 0.02;
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

    // --- ATR Calculation for dynamic SL/TP (timeframe-aware, bid-only) ---
    async calculateATR(symbol, resolution = "MINUTE", lookback = 50, period = 14) {
        try {
            const data = await getHistorical(symbol, resolution, lookback);
            const prices = data?.prices || [];
            if (prices.length < period + 1) throw new Error("Insufficient data for ATR");

            const tr = [];
            for (let i = 1; i < prices.length; i++) {
                const high = prices[i].high; // bid-only (matches api.getHistorical mapping)
                const low = prices[i].low; // bid-only
                const prevClose = prices[i - 1].close; // bid-only
                const tr1 = high - low;
                const tr2 = Math.abs(high - prevClose);
                const tr3 = Math.abs(low - prevClose);
                tr.push(Math.max(tr1, tr2, tr3));
            }
            const atr = tr.slice(-period).reduce((s, v) => s + v, 0) / period;
            return atr;
        } catch (err) {
            logger.error("[ATR] Error:", err?.message || err);
            // conservative tiny fallback
            return 0.0008; // ~8 pips on 5-digit majors
        }
    }

    generateSignal({ symbol, indicators, trendAnalysis, m1Candles, m5Candles, m15Candles, bid, ask, h1Candles }) {
        const { m1, m5, m15, h1 } = indicators;

        if (!m1 || !m5 || !m15 || !h1 || !m1Candles || !m5Candles || !m15Candles || !h1Candles) {
            logger.warn(`[Signal] Missing indicators/candles for ${symbol}`);
            return { signal: null, buyScore: 0, sellScore: 0, metrics: {} };
        }

        const m1Prev = m1Candles[m1Candles.length - 2] || {};
        const h1Last = h1Candles[h1Candles.length - 1] || {};

        const h1TrendBull = h1.maFast > h1.maSlow;
        const h1TrendBear = h1.maFast < h1.maSlow;
        const h1LastBull = typeof h1Last.close === "number" && h1Last.close > h1Last.open;
        const h1LastBear = typeof h1Last.close === "number" && h1Last.close < h1Last.open;

        // buy / sell conditions (6 checks, last one = H1 trend + last candle)
        const buyConditions = [
            m1.maFast > m1.maSlow && m1Prev.close < m1.maSlow,
            m1.rsi < 35, // slightly looser than 30 to reduce misses; tweak as needed
            bid <= m1.bb.lower,
            trendAnalysis?.overallTrend === "bullish",
            m15.rsi > 50,
            h1TrendBull && h1LastBull, // MANDATORY confirmation (H1 direction + last H1 candle)
        ];

        const sellConditions = [
            m1.maFast < m1.maSlow && m1Prev.close > m1.maSlow,
            m1.rsi > 65, // symmetric to buy side (tweak to 70 if preferred)
            ask >= m1.bb.upper,
            trendAnalysis?.overallTrend === "bearish",
            m15.rsi < 50,
            h1TrendBear && h1LastBear, // MANDATORY confirmation
        ];

        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        logger.info(`${symbol} Signal Analysis:
            - MA Crossover: ${buyConditions[0] ? "Bullish" : sellConditions[0] ? "Bearish" : "Neutral"}
            - RSI: ${m1.rsi?.toFixed(2)}
            - BB Position: ${(bid - m1.bb.lower).toFixed(5)} from lower, ${(m1.bb.upper - ask).toFixed(5)} from upper
            - Higher Timeframe Trend: ${trendAnalysis?.overallTrend}
            - M15 RSI: ${m15.rsi?.toFixed(2)}
            - H1 Trend: ${h1TrendBull ? "Bullish" : h1TrendBear ? "Bearish" : "Neutral"}
            - H1 Last Candle: ${h1LastBull ? "Bullish" : h1LastBear ? "Bearish" : "Neutral"}
            - Buy Score: ${buyScore}/6
            - Sell Score: ${sellScore}/6
        `);

        let signal = null;
        if (buyScore >= REQUIRED_SCORE && h1TrendBull && h1LastBull && trendAnalysis?.overallTrend === "bullish") {
            signal = "BUY";
        } else if (sellScore >= REQUIRED_SCORE && h1TrendBear && h1LastBear && trendAnalysis?.overallTrend === "bearish") {
            signal = "SELL";
        }

        const cooldownMs = 6000;
        if (signal && this.lastTradeTimestamps[symbol] && Date.now() - this.lastTradeTimestamps[symbol] < cooldownMs) {
            logger.info(`[Signal] Cooldown active for ${symbol}, skipping signal`);
            signal = null;
        }

        return {
            signal,
            buyScore,
            sellScore,
            metrics: {
                rsi: m1.rsi,
                maFast: m1.maFast,
                maSlow: m1.maSlow,
                bbUpper: m1.bb?.upper,
                bbLower: m1.bb?.lower,
            },
        };
    }

    // --- Price rounding ---
    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    // --- Position size + achievable SL/TP for M1 ---
    async calculateTradeParameters(signal, symbol, bid, ask) {
        const price = signal === "BUY" ? ask : bid;

        // 1) ATR from M1
        const atr = await this.calculateATR(symbol, "MINUTE", 80, 14);

        // 2) Pip size
        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;

        // 3) Tighter SL using ATR with floors/ceilings suited for M1
        //    Typical M1 target band: 6–12 pips on majors, 8–16 on JPY
        const minPips = symbol.includes("JPY") ? 8 : 6;
        const maxPips = symbol.includes("JPY") ? 16 : 12;

        // Vol-adaptive: ~0.8 ATR (M1) converted to pips, then clamped
        let slPips = Math.round((atr / pip) * 0.8);
        if (slPips < minPips) slPips = minPips;
        if (slPips > maxPips) slPips = maxPips;

        // 4) TP slightly > 1R to close quicker (1.2R–1.5R instead of 2R)
        const rr = 1.3; // tweakable: 1.2–1.5 works well for faster closes

        let stopLossPrice = signal === "BUY" ? price - slPips * pip : price + slPips * pip;
        let takeProfitPrice = signal === "BUY" ? price + slPips * pip * rr : price - slPips * pip * rr;

        stopLossPrice = this.roundPrice(stopLossPrice, symbol);
        takeProfitPrice = this.roundPrice(takeProfitPrice, symbol);

        // 5) Risk-based size
        const riskAmount = this.accountBalance * this.maxRiskPerTrade;
        const slDistance = Math.abs(price - stopLossPrice);
        let size = riskAmount / slDistance;

        // Your broker lot step is 100 units; round down
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        // 6) Margin check (unchanged)
        const leverage = 30;
        const marginRequired = (size * price) / leverage;
        const maxMarginPerTrade = this.accountBalance / MAX_POSITIONS;
        if (marginRequired > maxMarginPerTrade) {
            size = Math.floor((maxMarginPerTrade * leverage) / price / 100) * 100;
            if (size < 100) size = 100;
            logger.info(`[PositionSize] Adjusted for margin: New size: ${size}`);
        }

        logger.info(`[Trade Parameters] ${symbol} ${signal.toUpperCase()}:
            Entry: ${price}
            SL (${slPips} pips): ${stopLossPrice}
            TP (${(slPips * rr).toFixed(1)} pips): ${takeProfitPrice}
            Size: ${size}`);

        return {
            size,
            price,
            stopLossPrice,
            takeProfitPrice,
            // Optional partial at 1R for faster banking
            partialTakeProfit: signal === "BUY" ? this.roundPrice(price + slPips * pip, symbol) : this.roundPrice(price - slPips * pip, symbol),
        };
    }

    // --- TP/SL validation (unchanged) ---
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        logger.info(`[TP/SL Validation] Symbol: ${symbol}, Direction: ${direction}`);
        logger.info(`[TP/SL Validation] Entry: ${entryPrice}, SL: ${stopLossPrice}, TP: ${takeProfitPrice}`);
        const range = await getAllowedTPRange(symbol);
        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;
        const decimals = range.decimals || 5;
        if (direction === "BUY") {
            const minTP = entryPrice + range.minTPDistance * Math.pow(10, -decimals);
            const maxTP = entryPrice + range.maxTPDistance * Math.pow(10, -decimals);
            if (newTP < minTP) newTP = minTP;
            if (newTP > maxTP) newTP = maxTP;
            const minSL = entryPrice - range.maxSLDistance * Math.pow(10, -decimals);
            const maxSL = entryPrice - range.minSLDistance * Math.pow(10, -decimals);
            if (newSL < minSL) newSL = minSL;
            if (newSL > maxSL) newSL = maxSL;
        } else {
            const minTP = entryPrice - range.maxTPDistance * Math.pow(10, -decimals);
            const maxTP = entryPrice - range.minTPDistance * Math.pow(10, -decimals);
            if (newTP > maxTP) newTP = maxTP;
            if (newTP < minTP) newTP = minTP;
            const minSL = entryPrice + range.minSLDistance * Math.pow(10, -decimals);
            const maxSL = entryPrice + range.maxSLDistance * Math.pow(10, -decimals);
            if (newSL < minSL) newSL = minSL;
            if (newSL > maxSL) newSL = maxSL;
        }
        if (newTP === entryPrice) newTP += direction === "BUY" ? range.minTPDistance * Math.pow(10, -decimals) : -range.minTPDistance * Math.pow(10, -decimals);
        if (newSL === entryPrice) newSL += direction === "BUY" ? -range.minSLDistance * Math.pow(10, -decimals) : range.minSLDistance * Math.pow(10, -decimals);
        logger.info(`[TP/SL Validation] Final SL: ${newSL}, Final TP: ${newTP}`);
        return { SL: newSL, TP: newTP };
    }

    // --- Trade execution ---
    async executeTrade(symbol, signal, bid, ask) {
        const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask);
        // Optionally validate TP/SL here
        const { SL, TP } = await this.validateTPandSL(symbol, signal, price, stopLossPrice, takeProfitPrice);
        const position = await placePosition(symbol, signal, size, price, SL, TP);
        if (position?.dealReference) {
            const confirmation = await getDealConfirmation(position.dealReference);
            if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
            }
        }
    }

    // --- Main price processing ---
    async processPrice(message) {
        try {
            const { symbol, indicators, trendAnalysis, h1Candles, m15Candles, m5Candles, m1Candles, bid, ask } = message;

            // if (!symbol || !indicators || !h1Candles || !m15Candles || !m5Candles || !m1Candles || !bid || !ask || !trendAnalysis) return;

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
                await this.processSignal(symbol, signal, bid, ask);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal found`);
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    // --- Signal processing ---
    async processSignal(symbol, signal, bid, ask) {
        // Check daily loss limit
        // const dailyLossLimit = -Math.abs(this.accountBalance * this.dailyLossLimitPct);
        // if (this.dailyLoss < dailyLossLimit) {
        //     logger.warn(`[Risk] Daily loss limit reached: ${this.dailyLoss.toFixed(2)} €. Limit: ${dailyLossLimit.toFixed(2)} €`);
        //     return;
        // }

        try {
            await this.executeTrade(symbol, signal, bid, ask);
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
            await updateTrailingStop(dealId, newStop);
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
