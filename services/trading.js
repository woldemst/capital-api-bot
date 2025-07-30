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
        this.profitThresholdReached = false;

        this.availableMargin = 0; // Initialize availableMargin
        // --- Overtrading protection: cooldown per symbol ---
        this.lastTradeTimestamps = {};

        this.maxRiskPerTrade = 0.02; // 2% max
        this.minRiskPerTrade = 0.003; // 0.3% min
        this.maxSignalThreshold = 5;
        this.minSignalThreshold = 2;
        // --- Daily loss limit ---
        this.dailyLoss = 0;
        this.dailyLossLimitPct = 0.05; // 5 % vom Kontostand
        this.lastLossReset = new Date().toDateString();
    }

    setAccountBalance(balance) {
        this.accountBalance = balance;
    }
    setOpenTrades(trades) {
        this.openTrades = trades;
    }
    setProfitThresholdReached(reached) {
        this.profitThresholdReached = reached;
    }

    setAvailableMargin(margin) {
        this.availableMargin = margin;
    }
    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    generateSignal(indicators) {
        const { d1Trend, h4Trend, h1 } = indicators;
        // const h1 = indicators.h1;

        // Check trend alignment first
        if (d1Trend === "neutral" || h4Trend === "neutral") {
            return { signal: null, reason: "neutral_trend" };
        }
        if (d1Trend !== h4Trend) {
            return { signal: null, reason: "conflicting_trends" };
        }

        // Long Signal
        if (d1Trend === "bullish") {
            if (h1.crossover !== "bullish") return { signal: null, reason: "waiting_h1_bullish_cross" };
            if (h1.rsi <= 50) return { signal: null, reason: "weak_bullish_momentum" };
            return { signal: "BUY", reason: "aligned_bullish_trends_with_h1_confirmation" };
        }

        // Short Signal
        if (d1Trend === "bearish") {
            if (h1.crossover !== "bearish") return { signal: null, reason: "waiting_h1_bearish_cross" };
            if (h1.rsi >= 50) return { signal: null, reason: "weak_bearish_momentum" };
            return { signal: "SELL", reason: "aligned_bearish_trends_with_h1_confirmation" };
        }

        return { signal: null, reason: "no_valid_setup" };
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

    async executeTrade(signal, symbol, bid, ask, h1Candle) {
        logger.trade(signal.toUpperCase(), symbol, { bid, ask });
        const params = await this.calculateTradeParameters(signal, symbol, bid, ask, h1Candle);
        // Validate TP/SL before placing trade
        const price = signal === "buy" ? ask : bid;
        const validated = await this.validateTPandSL(symbol, signal, price, params.stopLossPrice, params.takeProfitPrice);
        params.stopLossPrice = validated.stopLossPrice;
        params.takeProfitPrice = validated.takeProfitPrice;
        try {
            // Pass expected entry price for slippage check
            await this.executePosition(signal, symbol, params, price);
        } catch (error) {
            logger.error(`[TradeExecution] Failed for ${symbol}:`, error);
            throw error;
        }
    }

    async calculateTradeParameters(signal, symbol, bid, ask, h1Candle) {
        // 1. Entry price
        const price = signal === "buy" ? ask : bid;

        // 2. Calculate Stop Loss based on H1 candle
        const buffer = TRADING.POSITION_BUFFER_PIPS * this.getPipValue(symbol);
        const stopLossPrice =
            signal === "buy"
                ? h1Candle.l - buffer // For longs: Low of H1 candle minus buffer
                : h1Candle.h + buffer; // For shorts: High of H1 candle plus buffer

        // 3. Calculate Take Profit using 2:1 reward-to-risk ratio
        const riskDistance = Math.abs(price - stopLossPrice);
        const takeProfitPrice = signal === "buy" ? price + riskDistance * TRADING.REWARD_RISK_RATIO : price - riskDistance * TRADING.REWARD_RISK_RATIO;

        // 4. Calculate position size based on risk amount
        const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);

        logger.info(`[Trade Parameters] ${symbol} ${signal.toUpperCase()}:
        Entry: ${price}
        SL: ${stopLossPrice} (${Math.abs(price - stopLossPrice) / this.getPipValue(symbol)} pips)
        TP: ${takeProfitPrice} (${TRADING.REWARD_RISK_RATIO}:1)
        Size: ${size}`);

        return {
            size,
            stopLossPrice,
            takeProfitPrice,
            // For partial take profit at 50% of the way to TP
            partialTakeProfit: signal === "buy" ? price + riskDistance * 0.5 : price - riskDistance * 0.5,
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
                    logger.error(`[Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
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
            logger.error(`[Position] Failed for ${symbol}:`, error);
            throw error;
        }
    }

    async processPrice(message) {
        try {
            if (!message) return;
            const { symbol, indicators, h1Candle } = message;
            if (!symbol || !indicators || !h1Candle) return;
            // Log specific fields we're interested in
            console.log("Message details:", {
                symbol: message.symbol,
                indicators: message.indicators,
                h1Candle: message.h1Candle,
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
            const { signal, reason } = this.generateSignal(indicators, h1Candle);
            if (signal) {
                logger.info(`[Signal] ${symbol}: ${signal} signal found - ${reason}`);
                await this.processSignal(symbol, signal, h1Candle);
            } else {
                logger.debug(`[Signal] ${symbol}: No signal - ${reason}`); // Changed to debug level
            }
        } catch (error) {
            logger.error(`[ProcessPrice] Error for ${symbol}:`, error);
        }
    }

    positionSize(balance, entryPrice, stopLossPrice, symbol) {
        // Strict risk management: never risk more than 2% of equity per trade
        const riskAmount = balance * 0.02; // 2% rule
        const pipValue = this.getPipValue(symbol);
        if (!pipValue || pipValue <= 0) {
            logger.error("Invalid pip value calculation");
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
            logger.error(`[API] Failed to close position for dealId: ${dealId}`, error);
        }
    }

    // Process a trading signal and execute the trade if conditions are met
    async processSignal(symbol, signal, h1Candle) {
        if (this.isSymbolTraded(symbol)) {
            logger.info(`[Signal] ${symbol} already in open trades, skipping`);
            return;
        }

        // Check cooldown period
        const now = Date.now();
        const lastTrade = this.lastTradeTimestamps[symbol];
        if (lastTrade && now - lastTrade < TRADING.COOLDOWN_PERIOD) {
            logger.info(`[Signal] ${symbol} in cooldown period, skipping`);
            return;
        }

        // Check daily loss limit
        const dailyLossLimit = -Math.abs(this.accountBalance * this.dailyLossLimitPct);
        if (this.dailyLoss < dailyLossLimit) {
            logger.warn(`[Risk] Daily loss limit reached: ${this.dailyLoss.toFixed(2)} €. Limit: ${dailyLossLimit.toFixed(2)} €`);
            return;
        }

        // Use close price for both bid and ask with a small spread
        const price = h1Candle.c;
        const spread = 0.0002; // 2 pips spread assumption
        const bid = price;
        const ask = price + spread;

        try {
            await this.executeTrade(signal, symbol, bid, ask, h1Candle);
            this.lastTradeTimestamps[symbol] = now;
            logger.info(`[Signal] Successfully processed ${signal.toUpperCase()} signal for ${symbol}`);
        } catch (error) {
            logger.error(`[Signal] Failed to process ${signal} signal for ${symbol}:`, error);
        }
    }
}

export default new TradingService();
