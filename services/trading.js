import {
    placePosition,
    getDealConfirmation,
    closePosition as apiClosePosition,
    getOpenPositions,
    getHistorical,
    updatePositionProtection,
} from "../api.js";
import { RISK, ANALYSIS, CRYPTO_SYMBOLS } from "../config.js";
import logger from "../utils/logger.js";
import { logTradeClose, logTradeOpen, logTradeTrailingStop, tradeTracker, summarizeClosedTrades } from "../utils/tradeLogger.js";
import Strategy from "../strategies/strategies.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;
const CRYPTO_RISK_PCT = Number.isFinite(Number(RISK.CRYPTO_PER_TRADE)) ? Number(RISK.CRYPTO_PER_TRADE) : PER_TRADE;
const GUARDS = RISK.GUARDS || {};
const EXITS = RISK.EXITS || {};
const STRATEGY_VARIANTS = ["H1_M15_M5", "H1_M15_M5_REGIME"];
const DEFAULT_PRIMARY_VARIANT = "H1_M15_M5_REGIME";
const DEFAULT_CRYPTO_VARIANT = "H1_M15_M5_REGIME";
const PRIMARY_VARIANT = STRATEGY_VARIANTS.includes(process.env.PRIMARY_STRATEGY_VARIANT)
    ? process.env.PRIMARY_STRATEGY_VARIANT
    : DEFAULT_PRIMARY_VARIANT;
const CRYPTO_VARIANT = STRATEGY_VARIANTS.includes(process.env.CRYPTO_STRATEGY_VARIANT)
    ? process.env.CRYPTO_STRATEGY_VARIANT
    : DEFAULT_CRYPTO_VARIANT;
const CRYPTO_PER_TRADE = CRYPTO_RISK_PCT;
const MAX_DAILY_LOSS_PCT = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_PCT)) ? Number(GUARDS.MAX_DAILY_LOSS_PCT) : 0.02;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(GUARDS.MAX_OPEN_RISK_PCT)) ? Number(GUARDS.MAX_OPEN_RISK_PCT) : Math.max(PER_TRADE, CRYPTO_PER_TRADE) * 2;
const MAX_LOSS_STREAK = Number.isFinite(Number(GUARDS.MAX_LOSS_STREAK)) ? Number(GUARDS.MAX_LOSS_STREAK) : 3;
const LOSS_STREAK_COOLDOWN_MINUTES = Number.isFinite(Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES))
    ? Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES)
    : 180;
const RISK_SUMMARY_CACHE_MS = Number.isFinite(Number(GUARDS.SUMMARY_CACHE_MS)) ? Number(GUARDS.SUMMARY_CACHE_MS) : 15000;

class TradingService {
    constructor() {
        this.openTrades = [];
        this.openPositionsBroker = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.dailyLoss = 0;
        this.dailyLossLimitPct = MAX_DAILY_LOSS_PCT;
        this.riskGuardState = {
            refreshedAtMs: 0,
            summary: null,
        };
        this.guardLogThrottle = new Map();
        logger.info(`[Strategy] ForexPrimary=${PRIMARY_VARIANT} CryptoPrimary=${CRYPTO_VARIANT}`);
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

    isCryptoSymbol(symbol) {
        return CRYPTO_SYMBOLS.includes(symbol);
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    getConfiguredRiskPct(symbol) {
        return this.isCryptoSymbol(symbol) ? CRYPTO_PER_TRADE : PER_TRADE;
    }

    getUtcDayStartMs(tsMs = Date.now()) {
        const d = new Date(tsMs);
        d.setUTCHours(0, 0, 0, 0);
        return d.getTime();
    }

    pctText(value) {
        return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
    }

    logGuardBlock(key, message, throttleMs = 60000) {
        const now = Date.now();
        const last = this.guardLogThrottle.get(key) || 0;
        if (now - last >= throttleMs) {
            logger.warn(message);
            this.guardLogThrottle.set(key, now);
        }
    }

    async refreshRiskGuardSummary({ force = false } = {}) {
        const now = Date.now();
        if (!force && this.riskGuardState.summary && now - this.riskGuardState.refreshedAtMs < RISK_SUMMARY_CACHE_MS) {
            return this.riskGuardState.summary;
        }

        const dayStartMs = this.getUtcDayStartMs(now);
        const summary = summarizeClosedTrades({ sinceMs: dayStartMs });
        this.riskGuardState = {
            refreshedAtMs: now,
            summary,
        };

        const period = summary?.period || {};
        this.dailyLoss = Math.abs(Math.min(0, Number(period.estimatedPnlPct) || 0));
        return summary;
    }

    estimateOpenConfiguredRiskPct() {
        if (!Array.isArray(this.openPositionsBroker) || !this.openPositionsBroker.length) return 0;
        return this.openPositionsBroker.reduce((sum, pos) => sum + this.getConfiguredRiskPct(pos?.symbol), 0);
    }

    async shouldBlockNewTrade(symbol) {
        const summary = await this.refreshRiskGuardSummary();
        const period = summary?.period || {};
        const global = summary?.all || {};

        const todayEstimatedPnlPct = Number(period.estimatedPnlPct) || 0;
        const todayEstimatedLossPctAbs = Math.abs(Math.min(0, todayEstimatedPnlPct));
        if (todayEstimatedLossPctAbs >= this.dailyLossLimitPct) {
            this.logGuardBlock(
                "daily_loss_limit",
                `[RiskGuard] Daily loss limit reached (${this.pctText(todayEstimatedLossPctAbs)} >= ${this.pctText(this.dailyLossLimitPct)}). Blocking new entries.`,
            );
            return { blocked: true, reason: "daily_loss_limit" };
        }

        const currentLossStreak = Number(global.currentLossStreak) || 0;
        if (currentLossStreak >= MAX_LOSS_STREAK) {
            const lastLossAtMs = Date.parse(String(global.lastLossAt || ""));
            const cooldownMs = LOSS_STREAK_COOLDOWN_MINUTES * 60000;
            const cooldownActive = Number.isFinite(lastLossAtMs) ? Date.now() - lastLossAtMs < cooldownMs : true;
            if (cooldownActive) {
                this.logGuardBlock(
                    "loss_streak_cooldown",
                    `[RiskGuard] Loss streak ${currentLossStreak} reached (limit=${MAX_LOSS_STREAK}). Cooldown active for ${LOSS_STREAK_COOLDOWN_MINUTES}m. Blocking new entries.`,
                );
                return { blocked: true, reason: "loss_streak_cooldown" };
            }
        }

        const currentOpenRiskPct = this.estimateOpenConfiguredRiskPct();
        const nextRiskPct = this.getConfiguredRiskPct(symbol);
        if (currentOpenRiskPct + nextRiskPct > MAX_OPEN_RISK_PCT + 1e-9) {
            this.logGuardBlock(
                "open_risk_cap",
                `[RiskGuard] Open risk cap exceeded by new ${symbol} trade (${this.pctText(currentOpenRiskPct)} + ${this.pctText(nextRiskPct)} > ${this.pctText(MAX_OPEN_RISK_PCT)}).`,
            );
            return { blocked: true, reason: "open_risk_cap" };
        }

        return {
            blocked: false,
            reason: null,
            snapshot: {
                todayEstimatedPnlPct,
                currentLossStreak,
                currentOpenRiskPct,
            },
        };
    }

    roundPrice(price, symbol) {
        if (this.isCryptoSymbol(symbol)) {
            if (price >= 1000) return Number(price).toFixed(2) * 1;
            if (price >= 100) return Number(price).toFixed(3) * 1;
            return Number(price).toFixed(4) * 1;
        }
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
        this.openPositionsBroker = positions.map((p) => ({
            dealId: p?.position?.dealId ?? p?.dealId ?? null,
            symbol: p?.market?.epic ?? p?.position?.epic ?? null,
            direction: p?.position?.direction ?? null,
            size: this.toNumber(p?.position?.size),
            entryPrice: this.firstNumber(p?.position?.level),
            stopLoss: this.firstNumber(p?.position?.stopLevel, p?.position?.stopLoss),
            takeProfit: this.firstNumber(p?.position?.profitLevel, p?.position?.takeProfit, p?.position?.limitLevel),
        }));
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
    //                   MAIN PRICE LOOP
    // ============================================================
    async processPrice({ symbol, indicators, bid, ask, timestamp, sessions = [] }) {
        try {
            await this.syncOpenTradesFromBroker();
            const guard = await this.shouldBlockNewTrade(symbol);
            logger.info(
                `[ProcessPrice] Open trades: ${this.openTrades.length}/${MAX_POSITIONS} | Balance: ${this.accountBalance}€ | AvailMargin: ${
                    Number.isFinite(this.availableMargin) ? this.availableMargin : "n/a"
                }€`,
            );

            if (this.openTrades.length >= MAX_POSITIONS) {
                logger.info(`[ProcessPrice] Max trades reached. Skipping ${symbol}.`);
                return;
            }
            if (this.isSymbolTraded(symbol)) {
                logger.debug(`[ProcessPrice] ${symbol} already in market.`);
                return;
            }
            if (guard?.blocked) {
                logger.debug(`[ProcessPrice] Risk guard blocked ${symbol}: ${guard.reason}`);
                return;
            }
            const isCrypto = this.isCryptoSymbol(symbol);
            let primary;
            let signal;
            let reason = "";
            const signalTimestamp = timestamp || new Date().toISOString();
            const marketContext = {
                bid,
                ask,
                spread: Number.isFinite(bid) && Number.isFinite(ask) ? Math.abs(ask - bid) : null,
                price: this.resolveMarketPrice("BUY", bid, ask),
            };

            if (isCrypto) {
                primary = Strategy.generateSignal3StageCrypto({
                    symbol,
                    indicators,
                    variant: CRYPTO_VARIANT,
                    market: marketContext,
                    timestamp: signalTimestamp,
                    sessions,
                });
                signal = primary?.signal;
                reason = primary?.reason || "";
            } else {
                primary = Strategy.generateSignal3StageForex({
                    symbol,
                    indicators,
                    variant: PRIMARY_VARIANT,
                    market: marketContext,
                    timestamp: signalTimestamp,
                    sessions,
                });
                signal = primary?.signal;
                reason = primary?.reason || "";
            }

            if (!signal) {
                const patternFails = Object.entries(primary?.context?.patternChecks || {})
                    .flatMap(([name, ok]) => {
                        if (ok && typeof ok === "object") {
                            return Object.entries(ok)
                                .filter(([, nestedOk]) => !nestedOk)
                                .map(([nestedName]) => `${name}.${nestedName}`);
                        }
                        return ok ? [] : [name];
                    })
                    .join(",");
                const patternFailText = patternFails ? `, patternFails=${patternFails}` : "";
                logger.debug(`[Signal] ${symbol}: no signal (${primary.reason}${patternFailText})`);
                return;
            }
            // Re-check just placing
            if (this.openTrades.length >= MAX_POSITIONS) return;
            if (this.isSymbolTraded(symbol)) return;
            const guardRecheck = await this.shouldBlockNewTrade(symbol);
            if (guardRecheck?.blocked) return;

            logger.info(`[Signal] ${symbol}: ${signal}`);
            await this.executeTrade(symbol, signal, bid, ask, indicators, reason);
        } catch (error) {
            logger.error("[ProcessPrice] Error:", error);
        }
    }

    // ============================================================
    //               ATR-Based Trade Parameters
    // ============================================================
    async calculateATR(symbol) {
        try {
            const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.M15, 15);
            if (!data?.prices || data.prices.length < 14) {
                throw new Error("Insufficient data for ATR calculation");
            }
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
            logger.error(`[ATR] Error calculating ATR for ${symbol}: ${error.message}`);
            return 0.001;
        }
    }

    async calculateTradeParameters(signal, symbol, bid, ask) {
        if (this.isCryptoSymbol(symbol)) {
            return this.calculateTradeParametersCrypto(signal, symbol, bid, ask);
        }
        return this.calculateTradeParametersForex(signal, symbol, bid, ask);
    }

    async calculateTradeParametersForex(signal, symbol, bid, ask) {
        const direction = this.normalizeDirection(signal);
        if (!["BUY", "SELL"].includes(direction)) {
            throw new Error(`[Trade Params] Invalid signal for ${symbol}: ${signal}`);
        }

        const isBuy = direction === "BUY";
        const price = this.resolveMarketPrice(direction, bid, ask);
        if (!Number.isFinite(price)) {
            throw new Error(`[Trade Params] Missing valid market price for ${symbol} (${direction})`);
        }

        const atr = await this.calculateATR(symbol);
        const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.abs(ask - bid) : 0;
        const stopLossPips = Math.max(1.5 * atr, spread * 2);
        const stopLossPrice = isBuy ? price - stopLossPips : price + stopLossPips;
        const takeProfitPips = 2 * stopLossPips; // 2:1 reward-risk ratio
        const takeProfitPrice = isBuy ? price + takeProfitPips : price - takeProfitPips;
        const size = this.positionSizeForex(this.accountBalance, price, stopLossPrice, symbol);
        const riskPctConfigured = this.getConfiguredRiskPct(symbol);
        const riskAmountConfigured = Number.isFinite(this.accountBalance) ? this.accountBalance * riskPctConfigured : null;

        return {
            size,
            stopLossPrice,
            takeProfitPrice,
            stopLossPips,
            takeProfitPips,
            price,
            riskPctConfigured,
            riskAmountConfigured,
            stopDistance: Math.abs(price - stopLossPrice),
            takeProfitDistance: Math.abs(takeProfitPrice - price),
        };
    }

    async calculateTradeParametersCrypto(signal, symbol, bid, ask) {
        const direction = this.normalizeDirection(signal);
        if (!["BUY", "SELL"].includes(direction)) {
            throw new Error(`[Trade Params] Invalid signal for ${symbol}: ${signal}`);
        }

        const isBuy = direction === "BUY";
        const price = this.resolveMarketPrice(direction, bid, ask);
        if (!Number.isFinite(price)) {
            throw new Error(`[Trade Params] Missing valid market price for ${symbol} (${direction})`);
        }

        const atr = await this.calculateATR(symbol);
        const spread = Number.isFinite(bid) && Number.isFinite(ask) ? Math.abs(ask - bid) : 0;
        const fallbackDistance = Math.max(price * 0.0045, spread * 3);
        const stopLossDistance = Math.max(2.2 * atr, spread * 3, fallbackDistance);
        const takeProfitDistance = stopLossDistance * 1.8;
        const stopLossPrice = isBuy ? price - stopLossDistance : price + stopLossDistance;
        const takeProfitPrice = isBuy ? price + takeProfitDistance : price - takeProfitDistance;
        const size = this.positionSizeCrypto(this.accountBalance, price, stopLossPrice, symbol);
        const riskPctConfigured = this.getConfiguredRiskPct(symbol);
        const riskAmountConfigured = Number.isFinite(this.accountBalance) ? this.accountBalance * riskPctConfigured : null;

        return {
            size,
            stopLossPrice,
            takeProfitPrice,
            stopLossPips: stopLossDistance,
            takeProfitPips: takeProfitDistance,
            price,
            riskPctConfigured,
            riskAmountConfigured,
            stopDistance: Math.abs(price - stopLossPrice),
            takeProfitDistance: Math.abs(takeProfitPrice - price),
        };
    }

    positionSizeForex(balance, entryPrice, stopLossPrice, symbol) {
        const riskAmount = balance * PER_TRADE;
        const pipValue = this.getPipValue(symbol); // Dynamic pip value

        if (!pipValue || pipValue <= 0) {
            logger.error(`[PositionSize] Invalid pip value calculation for ${symbol}`);
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
        // JPY quotes are typically 100x larger; normalize to keep margin cap comparable.
        const marginPrice = symbol.includes("JPY") ? entryPrice / 100 : entryPrice;
        // Margin required = (size * entryPrice) / leverage
        const marginRequired = (size * marginPrice) / leverage;
        // Use available margin from account (set by updateAccountInfo)
        const availableMargin = Number.isFinite(this.availableMargin) && this.availableMargin > 0 ? this.availableMargin : this.accountBalance;
        // Ensure margin for one trade is no more than 1/5 of available
        const maxMarginPerTrade = availableMargin / 5;
        if (marginRequired > maxMarginPerTrade) {
            // Reduce size so marginRequired == maxMarginPerTrade
            size = Math.floor((maxMarginPerTrade * leverage) / marginPrice / 100) * 100;
            if (size < 100) size = 100;
            logger.debug(`[PositionSize] Adjusted for margin on ${symbol}: new size=${size}`);
        }
        logger.debug(
            `[PositionSize] ${symbol}: raw=${riskAmount / (stopLossPips * pipValue)} final=${size} marginRequired=${marginRequired} maxPerTrade=${maxMarginPerTrade}`,
        );
        return size;
    }

    positionSizeCrypto(balance, entryPrice, stopLossPrice, symbol) {
        const riskAmount = balance * CRYPTO_PER_TRADE;
        const stopDistance = Math.abs(entryPrice - stopLossPrice);
        if (!Number.isFinite(stopDistance) || stopDistance <= 0) return 0.1;

        let size = riskAmount / stopDistance;
        if (!Number.isFinite(size) || size <= 0) return 0.1;

        // Crypto CFDs usually allow fractional size.
        size = Math.floor(size * 1000) / 1000;
        if (size < 0.1) size = 0.1;

        const leverage = 2;
        const marginRequired = (size * entryPrice) / leverage;
        const availableMargin = Number.isFinite(this.availableMargin) && this.availableMargin > 0 ? this.availableMargin : this.accountBalance;
        const maxMarginPerTrade = availableMargin / 5;
        if (marginRequired > maxMarginPerTrade && entryPrice > 0) {
            size = Math.floor(((maxMarginPerTrade * leverage) / entryPrice) * 1000) / 1000;
            if (size < 0.1) size = 0.1;
        }

        logger.debug(`[PositionSize][CRYPTO] ${symbol}: final=${size}`);
        return size;
    }

    // ============================================================
    //                    Place the Trade
    // ============================================================
    async executeTrade(symbol, signal, bid, ask, indicators, reason) {
        try {
            const { size, price, stopLossPrice, takeProfitPrice, riskPctConfigured, riskAmountConfigured, stopDistance, takeProfitDistance } =
                await this.calculateTradeParameters(signal, symbol, bid, ask);

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

            const affectedDealId =
                confirmation?.affectedDeals?.find((d) => d?.status === "OPENED")?.dealId || confirmation?.affectedDeals?.[0]?.dealId || confirmation?.dealId;
            // or: const affectedDealId = confirmation?.affectedDeals?.[0]?.dealId;

            if (affectedDealId) {
                await this.ensurePositionProtection({
                    dealId: affectedDealId,
                    symbol,
                    stopLossPrice,
                    takeProfitPrice,
                });
            } else {
                logger.warn(`[Order] Could not verify broker SL/TP for ${symbol}. Missing dealId in confirmation.`);
            }

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
                        openReason: reason,
                        entryPrice,
                        stopLoss: stopLossRounded,
                        takeProfit: takeProfitRounded,
                        indicatorsOnOpening: indicators,
                        timestamp: logTimestamp,
                        riskMeta: {
                            riskPct: Number.isFinite(riskPctConfigured) ? riskPctConfigured : null,
                            riskAmount: Number.isFinite(riskAmountConfigured) ? riskAmountConfigured : null,
                            stopDistance: Number.isFinite(stopDistance) ? stopDistance : null,
                            takeProfitDistance: Number.isFinite(takeProfitDistance) ? takeProfitDistance : null,
                            size: Number.isFinite(size) ? size : null,
                            accountBalanceAtOpen: Number.isFinite(this.accountBalance) ? this.accountBalance : null,
                            availableMarginAtOpen: Number.isFinite(this.availableMargin) ? this.availableMargin : null,
                            assetClass: this.isCryptoSymbol(symbol) ? "crypto" : "forex",
                        },
                    });

                    tradeTracker.registerOpenDeal(affectedDealId, symbol);
                    // track open deal in memory
                }
            } catch (logError) {
                logger.error(`[Order] Failed to log open trade for ${symbol}:`, logError);
            }

            this.openTrades.push(symbol);
            this.riskGuardState.refreshedAtMs = 0; // force refresh next tick (new open trade + future close calc)
        } catch (error) {
            logger.error(`[Order] Error placing order for ${symbol}:`, error);
        }
    }

    async ensurePositionProtection({ dealId, symbol, stopLossPrice, takeProfitPrice }) {
        const wantedStop = Number(stopLossPrice);
        const wantedProfit = Number(takeProfitPrice);

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const positionsResponse = await getOpenPositions();
                const positions = Array.isArray(positionsResponse?.positions) ? positionsResponse.positions : [];
                const match = positions.find((p) => (p?.position?.dealId ?? p?.dealId) === dealId);

                if (!match) {
                    await new Promise((resolve) => setTimeout(resolve, 600));
                    continue;
                }

                const brokerStop = this.firstNumber(match?.position?.stopLevel, match?.position?.stopLoss);
                const brokerProfit = this.firstNumber(match?.position?.profitLevel, match?.position?.limitLevel, match?.position?.takeProfit);

                const hasStop = brokerStop !== null && brokerStop > 0;
                const hasProfit = brokerProfit !== null && brokerProfit > 0;

                if (hasStop && hasProfit) {
                    logger.info(`[Order] Broker protection confirmed for ${symbol} (${dealId}): SL=${brokerStop} TP=${brokerProfit}`);
                    return true;
                }

                logger.warn(
                    `[Order] Missing broker SL/TP for ${symbol} (${dealId}) attempt ${attempt}/3. Current SL=${brokerStop ?? "none"} TP=${
                        brokerProfit ?? "none"
                    }. Applying SL=${wantedStop} TP=${wantedProfit}.`,
                );
                await updatePositionProtection(dealId, wantedStop, wantedProfit, symbol);
                await new Promise((resolve) => setTimeout(resolve, 700));
            } catch (error) {
                logger.warn(`[Order] Failed protection check for ${symbol} (${dealId}) attempt ${attempt}/3: ${error.message}`);
            }
        }

        logger.error(`[Order] Could not enforce broker SL/TP for ${symbol} (${dealId}) after retries.`);
        return false;
    }

    // ============================================================
    //               Trailing Stop (Improved)
    // ============================================================
    async updateTrailingStopIfNeeded(position, indicators) {
        const { dealId, direction, entryPrice, stopLoss, takeProfit, currentPrice, symbol } = position;

        if (!dealId) return;

        const trailActivationProgress = Number.isFinite(Number(EXITS.TRAIL_ACTIVATION_TP_PROGRESS))
            ? Number(EXITS.TRAIL_ACTIVATION_TP_PROGRESS)
            : 0.45;
        const breakevenActivationProgress = Number.isFinite(Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS))
            ? Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS)
            : 0.5;
        const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
        if (tpProgress === null || tpProgress < trailActivationProgress) {
            return;
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

            if (broken && EXITS.SOFT_EXIT_ON_M5_M15_BREAK !== false) {
                await this.softExitToBreakeven(position, { minProgress: breakevenActivationProgress });
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
        const activation = dir === "BUY" ? entry + tpDist * trailActivationProgress : entry - tpDist * trailActivationProgress;

        const activated = (dir === "BUY" && price >= activation) || (dir === "SELL" && price <= activation);

        if (!activated) return;

        const trailFraction = Number.isFinite(Number(EXITS.TRAIL_DISTANCE_TP_FRACTION)) ? Number(EXITS.TRAIL_DISTANCE_TP_FRACTION) : 0.18;
        const atrMultiplier = Number.isFinite(Number(EXITS.TRAIL_DISTANCE_ATR_MULTIPLIER)) ? Number(EXITS.TRAIL_DISTANCE_ATR_MULTIPLIER) : 0.8;
        const m5Atr = this.firstNumber(m5?.atr);
        const m15Atr = this.firstNumber(m15?.atr);
        const atrFloor = Math.max(0, (Number.isFinite(m5Atr) ? m5Atr : 0) * atrMultiplier, (Number.isFinite(m15Atr) ? m15Atr : 0) * atrMultiplier * 0.5);
        const trailDist = Math.max(tpDist * trailFraction, atrFloor);
        let newSL = dir === "BUY" ? price - trailDist : price + trailDist;

        const stop = Number(stopLoss);
        if (Number.isFinite(stop)) {
            if ((dir === "BUY" && newSL <= stop) || (dir === "SELL" && newSL >= stop)) return;
        }

        try {
            await updatePositionProtection(dealId, newSL, tp, symbol);
            logger.info(`[Trail] Updated SL → ${newSL} for ${dealId}`);
            const updatedTrailLog = logTradeTrailingStop({
                dealId,
                symbol,
                price: newSL,
                distance: trailDist,
                reason: "trail",
                timestamp: new Date().toISOString(),
            });
            if (!updatedTrailLog) {
                logger.debug(`[Trail] Could not append trailing stop update to log for ${dealId}`);
            }
        } catch (error) {
            logger.error(`[Trail] Error updating trailing stop:`, error);
        }
    }

    // ============================================================
    //               Breakeven Soft Exit
    // ============================================================
    async softExitToBreakeven(position, { minProgress = null } = {}) {
        const { dealId, entryPrice, takeProfit, currentPrice, direction, symbol } = position;

        try {
            const tpProgress = this.getTpProgress(direction, entryPrice, takeProfit, currentPrice);
            const threshold = Number.isFinite(Number(minProgress))
                ? Number(minProgress)
                : Number.isFinite(Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS))
                  ? Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS)
                  : 0.5;
            if (tpProgress === null || tpProgress < threshold) {
                logger.info(`[SoftExit] Skipped breakeven: TP progress ${(tpProgress ?? 0).toFixed(2)} < ${threshold.toFixed(2)} for ${dealId}`);
                return;
            }

            await updatePositionProtection(dealId, entryPrice, takeProfit, symbol);

            logger.info(`[SoftExit] ${symbol}: misalignment → moved SL to breakeven for ${dealId}`);
            const updatedTrailLog = logTradeTrailingStop({
                dealId,
                symbol,
                price: entryPrice,
                distance: Math.abs(Number(currentPrice) - Number(entryPrice)),
                reason: "breakeven",
                timestamp: new Date().toISOString(),
            });
            if (!updatedTrailLog) {
                logger.debug(`[SoftExit] Could not append trailing stop update to log for ${dealId}`);
            }
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
            if (updated) {
                tradeTracker.markDealClosed(dealId);
                this.riskGuardState.refreshedAtMs = 0;
            }
        } catch (logErr) {
            logger.error(`[ClosePos] Failed to log closure for ${dealId}:`, logErr);
        }
    }
}

export default new TradingService();
