import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getDealConfirmation, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { logTradeResult } from "../utils/tradeLogger.js";
const { MAX_POSITIONS } = TRADING;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;

        this.availableMargin = 0; // Initialize availableMargin

        // --- Overtrading protection: cooldown per symbol ---
        this.lastTradeTimestamps = {};

        this.maxRiskPerTrade = 0.02;

        // --- Daily loss limit ---
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
        if (!trend || !prev || !last) return false;

        const isBullish = (c) => c.close > c.open;
        const isBearish = (c) => c.close < c.open;

        const trendDirection = trend.toLowerCase();
        // console.log("prev:", prev);
        // console.log("last:", last);

        if (!trendDirection || trendDirection === "neutral") return false;

        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            return "bullish"; // red -> green
        } else if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            return "bearish"; // green -> red
        }

        return false;
    }

    generateSignal(indicators, prev, last) {
        const { h4Trend, h1Trend, h1, m15 } = indicators;

        if (h4Trend === "neutral" && h1Trend === "neutral") return { signal: null, reason: "neutral_trend" };

        const validPattern = this.detectPattern(h1Trend, prev, last);

        // console.log("Valid pattern:", validPattern);
        if (!validPattern) return { signal: null, reason: "no_valid_pattern" };

        const signal = validPattern === "bullish" ? "BUY" : "SELL";

        console.log(`Generated ${signal} signal based on ${validPattern} pattern.`);
        return { signal, reason: `valid_${validPattern}_pattern` };
    }

    // Validate and adjust TP/SL to allowed range
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        logger.info(`[TP/SL Validation] Symbol: ${symbol}, Direction: ${direction}`);
        logger.info(`[TP/SL Validation] Entry: ${entryPrice}, SL: ${stopLossPrice}, TP: ${takeProfitPrice}`);

        const range = await getAllowedTPRange(symbol);

        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;
        const decimals = range.decimals || 5;
        // For forex, TP/SL must be at least minTPDistance away from entry, and not violate maxTPDistance
        // For SELL: TP < entry, SL > entry. For BUY: TP > entry, SL < entry
        if (direction === "BUY") {
            const minTP = entryPrice + range.minTPDistance * Math.pow(10, -decimals);
            const maxTP = entryPrice + range.maxTPDistance * Math.pow(10, -decimals);
            if (newTP < minTP) {
                logger.warn(`[TP Validation] TP (${newTP}) < min allowed (${minTP}). Adjusting.`);
                newTP = minTP;
            }
            if (newTP > maxTP) {
                logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`);
                newTP = maxTP;
            }
            // Repeat for SL
            const minSL = entryPrice - range.maxSLDistance * Math.pow(10, -decimals);
            const maxSL = entryPrice - range.minSLDistance * Math.pow(10, -decimals);
            if (newSL < minSL) {
                logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`);
                newSL = minSL;
            }
            if (newSL > maxSL) {
                logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`);
                newSL = maxSL;
            }
        } else {
            // SELL
            const minTP = entryPrice - range.maxTPDistance * Math.pow(10, -decimals);
            const maxTP = entryPrice - range.minTPDistance * Math.pow(10, -decimals);
            if (newTP > maxTP) {
                logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`);
                newTP = maxTP;
            }
            if (newTP < minTP) {
                logger.warn(`[TP Validation] TP (${newTP}) < min allowed ( ${minTP}). Adjusting.`);
                newTP = minTP;
            }
            // Repeat for SL
            const minSL = entryPrice + range.minSLDistance * Math.pow(10, -decimals);
            const maxSL = entryPrice + range.maxSLDistance * Math.pow(10, -decimals);
            if (newSL < minSL) {
                logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`);
                newSL = minSL;
            }
            if (newSL > maxSL) {
                logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`);
                newSL = maxSL;
            }
        }
        // After adjusting newTP and newSL
        if (newTP === entryPrice) {
            newTP += direction === "BUY" ? range.minTPDistance * Math.pow(10, -decimals) : -range.minTPDistance * Math.pow(10, -decimals);
        }
        if (newSL === entryPrice) {
            newSL += direction === "BUY" ? -range.minSLDistance * Math.pow(10, -decimals) : range.minSLDistance * Math.pow(10, -decimals);
        }
        logger.info(`[TP/SL Validation] Final SL: ${newSL}, Final TP: ${newTP}`);
        return { SL: newSL, TP: newTP };
    }

    async executeTrade(symbol, signal, bid, ask, prev, last) {
        // logger.trade(signal.toUpperCase(), symbol, { bid, ask });
        const { size, price, stopLossPrice, takeProfitPrice } = await this.calculateTradeParameters(signal, symbol, bid, ask, prev, last);

        const { SL, TP } = await this.validateTPandSL(symbol, signal, price, stopLossPrice, takeProfitPrice);

        const position = await placePosition(symbol, signal, size, price, SL, TP);

        if (position?.dealReference) {
            const confirmation = await getDealConfirmation(position.dealReference);
            if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
            }
        }
    }

    async calculateTradeParameters(signal, symbol, bid, ask, prev, last) {
        const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
        const buffer = pip; // 1 pip buffer

        const entry = signal === "BUY" ? ask : bid;

        // 1. SL below/above prev candle
        let stopLossPrice;
        if (signal === "BUY") {
            stopLossPrice = prev.low - buffer;
        } else {
            stopLossPrice = prev.high + buffer;
        }

        // 2. Calculate SL distance and last candle body
        const slDistance = Math.abs(entry - stopLossPrice);
        const lastBody = Math.abs(last.close - last.open);

        // 3. TP: max(2×SL, 1.5×body)
        let tpDistance = Math.max(2 * slDistance, 1.5 * lastBody);
        let takeProfitPrice;
        if (signal === "BUY") {
            takeProfitPrice = entry + tpDistance;
        } else {
            takeProfitPrice = entry - tpDistance;
        }

        // 4. Position size based on risk
        const riskAmount = this.accountBalance * this.maxRiskPerTrade;
        let size = riskAmount / slDistance;
        size = Math.floor(size / 100) * 100;
        if (size < 100) size = 100;

        logger.info(`[Trade Parameters] ${symbol} ${signal.toUpperCase()}:
            Entry: ${entry}
            SL: ${stopLossPrice}
            TP: ${takeProfitPrice}
            Size: ${size}`);

        return {
            size,
            price: entry,
            stopLossPrice,
            takeProfitPrice,
            partialTakeProfit: signal === "BUY" ? entry + slDistance : entry - slDistance,
        };
    }

    async processPrice(message) {
        try {
            const { symbol, indicators, d1Candles, h4Candles, h1Candles, m15Candles, prev, last, bid, ask } = message;

            if (!symbol || !indicators || !h1Candles || !m15Candles || !prev || !last) return;

            console.log("Message details:", {
                d1CandlesLength: d1Candles.length,
                h4CandlesLength: h4Candles.length,
                h1CandlesLength: h1Candles.length,
                m15CandlesLength: m15Candles.length,
                indicators,
                symbol,
                prev,
                last,
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

            // Generate signal using our streamlined method
            const { signal, reason } = this.generateSignal(indicators, prev, last);

            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found - ${reason}`);
                await this.processSignal(symbol, signal, prev, last, bid, ask);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal - ${reason}`); // Changed to debug level
            }
        } catch (error) {
            logger.error(`[trading.js][ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    positionSize(balance, entryPrice, stopLossPrice, symbol) {
        // Strict risk management: never risk more than 2% of equity per trade
        const riskAmount = balance * 0.02; // 2% rule
        const pipValue = this.getPipValue(symbol);
        if (!pipValue || pipValue <= 0) {
            logger.error("[trading.js] Invalid pip value calculation");
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
        const leverage = 30;
        const marginRequired = (size * entryPrice) / leverage;
        const availableMargin = balance;
        const maxMarginPerTrade = availableMargin / 5;

        if (marginRequired > maxMarginPerTrade) {
            size = Math.floor((maxMarginPerTrade * leverage) / entryPrice / 100) * 100;
            if (size < 100) size = 100;
            logger.info(`[PositionSize] Adjusted for margin: New size: ${size}`);
        }
        logger.info(
            `[PositionSize] Strict 2%% rule: Raw size: ${riskAmount / (stopLossPips * pipValue)}, Final size: ${size}, Margin required: ${marginRequired}, Max per trade: ${maxMarginPerTrade}`
        );
        if (!size || isNaN(size) || size < 100) {
            logger.error(`[Trade] Invalid position size for ${symbol}: ${size}`);
            return;
        }
        return size;
    }

    // Add pip value determination
    getPipValue(symbol) {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    // Close position by dealId
    async closePosition(dealId, result) {
        try {
            await apiClosePosition(dealId);
            logger.info(`[API] Closed position for dealId: ${dealId}`);
            if (result) logTradeResult(dealId, result);
        } catch (error) {
            logger.error(`[trading.js][API] Failed to close position for dealId: ${dealId}`, error);
        }
    }

    // Process a trading signal and execute the trade if conditions are met
    async processSignal(symbol, signal, prev, last, bid, ask) {
        if (this.isSymbolTraded(symbol)) {
            logger.info(`[Signal] ${symbol} already in open trades, skipping`);
            return;
        }

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
            await this.executeTrade(symbol, signal, bid, ask, prev, last);
            logger.info(`[Signal] Successfully processed ${signal.toUpperCase()} signal for ${symbol}`);
        } catch (error) {
            logger.error(`[trading.js][Signal] Failed to process ${signal} signal for ${symbol}:`, error);
        }
    }

    async updateTrailingStopIfNeeded(position) {
        // position: { dealId, direction, entryPrice, takeProfit, stopLoss, currentPrice }
        const { dealId, direction, entryPrice, takeProfit, stopLoss, currentPrice } = position;

        // Calculate TP distance
        const tpDistance = Math.abs(takeProfit - entryPrice);

        // Calculate 50% TP trigger price
        const tpHalf = direction === "BUY" ? entryPrice + tpDistance * 0.5 : entryPrice - tpDistance * 0.5;

        // Check if current price reached 50% of TP
        const reachedHalfTP = direction === "BUY" ? currentPrice >= tpHalf : currentPrice <= tpHalf;

        if (!reachedHalfTP) return; // Not yet at 50% TP

        // Calculate trailing stop buffer (10% of TP distance)
        const trailingBuffer = tpDistance * 0.1;

        // New trailing stop price
        const newStop = direction === "BUY" ? currentPrice - trailingBuffer : currentPrice + trailingBuffer;

        // Only update if newStop is more favorable than current stopLoss
        const shouldUpdate = direction === "BUY" ? newStop > stopLoss : newStop < stopLoss;

        if (!shouldUpdate) return;

        // Call API to update trailing stop
        try {
            await updateTrailingStop(dealId, newStop);
            logger.info(`[TrailingStop] Updated trailing stop for ${dealId}: ${newStop}`);
        } catch (error) {
            logger.error(`[TrailingStop] Failed to update trailing stop for ${dealId}:`, error);
        }
    }
}

export default new TradingService();
