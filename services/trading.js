import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition, getHistorical } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult } from "../utils/tradeLogger.js";
const { MAX_POSITIONS, RISK_PER_TRADE } = TRADING;

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

    // --- ATR Calculation for dynamic SL/TP ---
    async calculateATR(symbol) {
        try {
            const data = await getHistorical(symbol, "MINUTE_15", 15);
            if (!data?.prices || data.prices.length < 14) throw new Error("Insufficient data for ATR calculation");
            let tr = [];
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
            const atr = tr.slice(-14).reduce((sum, val) => sum + val, 0) / 14;
            return atr;
        } catch (error) {
            logger.error("[ATR] Error:", error);
            return 0.001;
        }
    }

    generateSignal({ symbol, indicators, trendAnalysis, m1Candles, m5Candles, m15Candles, bid, ask }) {
        // Defensive: ensure indicators and candles are present
        const { m1, m5, m15 } = indicators;

        if (!m1 || !m5 || !m15 || !m1Candles || !m5Candles || !m15Candles) {
            logger.warn(`[Signal] Missing indicators or candles for ${symbol}`);
            return { signal: null, buyScore: 0, sellScore: 0, metrics: {} };
        }

        // Use the last candle for close price checks
        const m1Prev = m1Candles[m1Candles.length - 2] || {};
        // Buy signal conditions
        const buyConditions = [
            // MA crossover (5 MA crosses above 20 MA)
            m1.maFast > m1.maSlow && m1Prev.close < m1.maSlow,

            // RSI below 30 (oversold)
            m1.rsi < 30,

            // Price at lower Bollinger Band
            bid <= m1.bb.lower,

            // Higher timeframe trend confirmation
            trendAnalysis?.overallTrend === "bullish",

            // M15 confirmation
            m15.rsi > 50,
        ];

        // Sell signal conditions
        const sellConditions = [
            // MA crossover (5 MA crosses below 20 MA)
            m1.maFast < m1.maSlow && m1Prev.close > m1.maSlow,

            // RSI above 70 (overbought)
            m1.rsi > 70,

            // Price at upper Bollinger Band
            ask >= m1.bb.upper,

            // Higher timeframe trend confirmation
            trendAnalysis?.overallTrend === "bearish",

            // M15 confirmation
            m15.rsi < 50,
        ];

        // Calculate signal scores
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        logger.info(`${symbol} Signal Analysis:
            - MA Crossover: ${buyConditions[0] ? "Bullish" : sellConditions[0] ? "Bearish" : "Neutral"}
            - RSI: ${m1.rsi?.toFixed(2)}
            - BB Position: ${(bid - m1.bb.lower).toFixed(5)} from lower, ${(m1.bb.upper - ask).toFixed(5)} from upper
            - Higher Timeframe Trend: ${trendAnalysis?.overallTrend}
            - M15 RSI: ${m15.rsi?.toFixed(2)}
            - Buy Score: ${buyScore}/5
            - Sell Score: ${sellScore}/5
        `);

        let signal = null;
        if (buyScore >= 3) signal = "BUY";
        if (sellScore >= 3) signal = "SELL";

        return {
            signal,
            buyScore,
            sellScore,
            metrics: {
                rsi: m1.rsi,
                maFast: m1.maFast,
                maSlow: m1.maSlow,
                bbUpper: m1.bb.upper,
                bbLower: m1.bb.lower,
            },
        };
    }

    // --- Price rounding ---
    roundPrice(price, symbol) {
        const decimals = symbol.includes("JPY") ? 3 : 5;
        return Number(price).toFixed(decimals) * 1;
    }

    // --- Position size calculation (ATR-based, margin/risk checked) ---
    async calculateTradeParameters(signal, symbol, bid, ask) {
        const price = signal === "BUY" ? ask : bid;
        const atr = await this.calculateATR(symbol);
        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        // Use ATR for SL/TP, fallback to fixed if ATR is too small
        const slPips = Math.max((atr * 1.5) / pip, symbol.includes("JPY") ? 20 : 15);
        let stopLossPrice = signal === "BUY" ? price - slPips * pip : price + slPips * pip;
        let takeProfitPrice = signal === "BUY" ? price + slPips * pip * 2 : price - slPips * pip * 2;

        stopLossPrice = this.roundPrice(stopLossPrice, symbol);
        takeProfitPrice = this.roundPrice(takeProfitPrice, symbol);

        // Risk and size
        const riskAmount = this.accountBalance * this.maxRiskPerTrade;
        const slDistance = Math.abs(price - stopLossPrice);
        let size = riskAmount / slDistance;
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        // Margin check
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
            SL: ${stopLossPrice}
            TP: ${takeProfitPrice}
            Size: ${size}`);

        return {
            size,
            price,
            stopLossPrice,
            takeProfitPrice,
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
            const { symbol, indicators, m15Candles, m5Candles, m1Candles, bid, ask, trendAnalysis } = message;
            if (!symbol || !indicators || !m15Candles || !m5Candles || !m1Candles) return;

            console.log("Message details:", {
                m15CandlesLength: m15Candles.length,
                m5CandlesLength: m5Candles.length,
                m1CandlesLength: m1Candles.length,
                indicators,
                symbol,
                bid,
                ask,
            });

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
        // Check cooldown period
        // const now = Date.now();
        // const lastTrade = this.lastTradeTimestamps[symbol];
        // if (lastTrade && now - lastTrade < TRADING.COOLDOWN_PERIOD) {
        //     logger.info(`[Signal] ${symbol} in cooldown period, skipping`);
        //     return;
        // }

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
        const tpHalf = direction === "BUY" ? entryPrice + tpDistance * 0.5 : entryPrice - tpDistance * 0.5;
        const reachedHalfTP = direction === "BUY" ? currentPrice >= tpHalf : currentPrice <= tpHalf;
        if (!reachedHalfTP) return;
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
