import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical, getOpenPositions, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { ATR } from "technicalindicators";
import { getCurrentTradesLogPath, logTradeResult } from "../utils/tradeLogger.js";
const { MAX_POSITIONS } = TRADING;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.accountBalance = 0;

        this.availableMargin = 0; // Initialize availableMargin
        // --- Overtrading protection: cooldown per symbol ---
        this.lastTradeTimestamps = {};

        this.maxRiskPerTrade = 0.02; // 2% max

        // --- Daily loss limit ---
        this.dailyLoss = 0;
        this.dailyLossLimitPct = 0.05; // 5 % vom Kontostand
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
        if (!prev || !last) return false;

        const isBullish = (c) => c.close > c.open;
        const isBearish = (c) => c.close < c.open;

        const trendDirection = trend.toLowerCase();
        // console.log("prev:", prev);
        // console.log("last:", last);

        // console.log("trendDirection:", trendDirection, "isBullish(last):", isBullish(last), "isBearish(last):", isBearish(last));
        // console.log("trendDirection:", trendDirection, "isBullish(prev):", isBearish(prev), "isBearish(prev):", isBullish(prev));

        // if (!trendDirection || trendDirection === "neutral") return false;

        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            return "bullish"; // red -> green
        } else if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            return "bearish"; // green -> red
        }

        return false;
    }

    generateSignal(indicators, prev, last) {
        const { d1Trend, h1 } = indicators;

        // if (h4Trend === "neutral" && h1.trend === "neutral") return { signal: null, reason: "neutral_h4_trend" };

        const validPattern = this.detectPattern(d1Trend, prev, last);

        // console.log("Valid pattern:", validPattern);
        if (!validPattern) return { signal: null, reason: "no_valid_pattern" };

        const signal = validPattern === "bullish" ? "BUY" : "SELL";
        console.log(`Generated ${signal} signal based on ${validPattern} pattern.`);
        return { signal, reason: `valid_${validPattern}_pattern` };
    }

    // Validate and adjust TP/SL to allowed range
    async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
        const range = await getAllowedTPRange(symbol);

        let newTP = takeProfitPrice;
        let newSL = stopLossPrice;
        const decimals = range.decimals || 5;
        // For forex, TP/SL must be at least minTPDistance away from entry, and not violate maxTPDistance
        // For SELL: TP < entry, SL > entry. For BUY: TP > entry, SL < entry
        if (direction === "buy") {
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
        return { stopLossPrice: newSL, takeProfitPrice: newTP };
    }

    async executeTrade(signal, symbol, bid, ask, prev, last) {
        logger.trade(signal.toUpperCase(), symbol, { bid, ask });
        const params = await this.calculateTradeParameters(signal, symbol, bid, ask, prev, last);
        // Validate TP/SL before placing trade
        const price = signal === "buy" ? ask : bid;
        const validated = await this.validateTPandSL(symbol, signal, price, params.stopLossPrice, params.takeProfitPrice);
        params.stopLossPrice = validated.stopLossPrice;
        params.takeProfitPrice = validated.takeProfitPrice;
        try {
            // Pass expected entry price for slippage check
            await this.executePosition(signal, symbol, params, price);
        } catch (error) {
            logger.error(`[trading.js][TradeExecution] Failed for ${symbol}:`, error);
            throw error;
        }
    }

    async calculateTradeParameters(signal, symbol, bid, ask, prev, last, indicators) {
        const price = signal === "BUY" ? ask : bid;
        const pipValue = this.getPipValue(symbol);
        const buffer = TRADING.POSITION_BUFFER_PIPS * pipValue;

        // --- ATR-based minimum stop distance ---
        const atr = indicators?.h1?.atr || (symbol.includes("JPY") ? 0.1 : 0.001); // fallback if ATR missing

        let stopLossPrice;
        if (signal === "BUY") {
            stopLossPrice = prev.low - buffer;
            if (price - stopLossPrice < atr) {
                stopLossPrice = price - atr;
            }
        } else {
            stopLossPrice = prev.high + buffer;
            if (stopLossPrice - price < atr) {
                stopLossPrice = price + atr;
            }
        }

        const riskDistance = Math.abs(price - stopLossPrice);
        const takeProfitPrice = signal === "BUY" ? price + riskDistance * TRADING.REWARD_RISK_RATIO : price - riskDistance * TRADING.REWARD_RISK_RATIO;

        // console.log("Account Balance:", this.accountBalance, "Price:", price, "Stop Loss Price:", stopLossPrice, "Symbol:", symbol);
        const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);

        logger.info(`[Trade Parameters] ${symbol} ${signal.toUpperCase()}:
        Entry: ${price}
        SL: ${stopLossPrice} (${riskDistance / pipValue} pips)
        TP: ${takeProfitPrice} (${TRADING.REWARD_RISK_RATIO}:1)
        Size: ${size}`);

        return {
            size,
            stopLossPrice,
            takeProfitPrice,
            partialTakeProfit: signal === "BUY" ? price + riskDistance * 0.5 : price - riskDistance * 0.5,
        };
    }

    async executePosition(signal, symbol, params, expectedPrice) {
        const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
        try {
            // Pass symbol, direction, and price to placePosition for min stop enforcement
            const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice, expectedPrice);
            if (position?.dealReference) {
                // Fetch and log deal confirmation
                const { getDealConfirmation } = await import("../api.js");
                const confirmation = await getDealConfirmation(position.dealReference);
                if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
                    logger.error(`[trading.js][Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
                }
                // --- Slippage check ---
                if (confirmation.level && expectedPrice) {
                    const { TRADING } = await import("../config.js");
                    // Calculate slippage in pips
                    const decimals = 5; // Most FX pairs
                    const pip = Math.pow(10, -decimals);
                    const slippage = Math.abs(confirmation.level - expectedPrice) / pip;
                    if (slippage > TRADING.MAX_SLIPPAGE_PIPS) {
                        logger.warn(
                            `[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips (max allowed: ${TRADING.MAX_SLIPPAGE_PIPS})`
                        );
                        // Optionally: take action (e.g., close trade, alert, etc.)
                    } else {
                        logger.info(`[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips`);
                    }
                }
            }
            return position;
        } catch (error) {
            logger.error(`[trading.js][Position] Failed for ${symbol}:`, error);
            throw error;
        }
    }

    async processPrice(message) {
        try {
            if (!message) return;
            const { symbol, indicators, h1Candles, prev, last } = message;

            if (!symbol || !indicators || !h1Candles || !prev || !last) return;

            console.log("Message details:", {
                symbol: message.symbol,
                indicators: message.indicators,
                h1CandlesLength: message.h1Candles.length,
                prev: message.prev,
                last: message.last,
            });

            if (!symbol) {
                logger.warn("[ProcessPrice] Missing symbol in message");
                return;
            }

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
                await this.processSignal(symbol, signal, prev, last);
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
    async processSignal(symbol, signal, prev, last) {
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

        // Use close price for both bid and ask with a small spread
        const price = last.close;
        const spread = 0.0002; // 2 pips spread assumption
        const bid = price;
        const ask = price + spread;

        try {
            await this.executeTrade(signal, symbol, bid, ask, prev, last);
            this.lastTradeTimestamps[symbol] = now;
            logger.info(`[Signal] Successfully processed ${signal.toUpperCase()} signal for ${symbol}`);
        } catch (error) {
            logger.error(`[trading.js][Signal] Failed to process ${signal} signal for ${symbol}:`, error);
        }
    }
}

export default new TradingService();
