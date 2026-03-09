import fs from "fs";
import {
    placePosition,
    getDealConfirmation,
    closePosition as apiClosePosition,
    getOpenPositions,
    getHistorical,
    getMarketDetails,
    updatePositionProtection,
} from "../api.js";
import { RISK, ANALYSIS, CRYPTO_SYMBOLS, STRATEGIES, STRATEGY_SELECTION } from "../config.js";
import logger from "../utils/logger.js";
import {
    logTradeClose,
    logTradeOpen,
    logTradeTrailingStop,
    tradeTracker,
    summarizeClosedTrades,
    getSymbolLogPath,
    getTradeEntry,
} from "../utils/tradeLogger.js";
import { createIntradaySevenStepEngine } from "../intraday/engine.js";
import { DEFAULT_CRYPTO_INTRADAY_CONFIG, DEFAULT_INTRADAY_CONFIG, mergeIntradayConfig } from "../intraday/config.js";
import { createIntradayRuntimeState, ensureStateDay, registerClosedTrade, registerOpenedTrade } from "../intraday/state.js";
import { step1MarketTimeWindow } from "../intraday/step1MarketTimeWindow.js";
import {
    CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
    evaluateCryptoLiquidityWindowMomentum,
    getDateKeyInTimeZone,
    normalizeBar,
} from "../strategies/cryptoLiquidityWindowMomentum.js";
import { computeConfigHash } from "../utils/configHash.js";
import { logStrategyDecision } from "../utils/strategyDecisionLogger.js";

const { PER_TRADE, MAX_POSITIONS } = RISK;
const CRYPTO_RISK_PCT = Number.isFinite(Number(RISK.CRYPTO_PER_TRADE)) ? Number(RISK.CRYPTO_PER_TRADE) : PER_TRADE;
const GUARDS = RISK.GUARDS || {};
const EXITS = RISK.EXITS || {};
const CRYPTO_PER_TRADE = CRYPTO_RISK_PCT;
const MAX_DAILY_LOSS_PCT = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_PCT)) ? Number(GUARDS.MAX_DAILY_LOSS_PCT) : 0.02;
const MAX_DAILY_LOSS_R = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_R)) ? Number(GUARDS.MAX_DAILY_LOSS_R) : 0;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(GUARDS.MAX_OPEN_RISK_PCT)) ? Number(GUARDS.MAX_OPEN_RISK_PCT) : Math.max(PER_TRADE, CRYPTO_PER_TRADE) * 2;
const MAX_SYMBOL_LOSSES_PER_DAY = Number.isFinite(Number(GUARDS.MAX_SYMBOL_LOSSES_PER_DAY)) ? Number(GUARDS.MAX_SYMBOL_LOSSES_PER_DAY) : 0;
const MAX_LOSS_STREAK = Number.isFinite(Number(GUARDS.MAX_LOSS_STREAK)) ? Number(GUARDS.MAX_LOSS_STREAK) : 3;
const LOSS_STREAK_COOLDOWN_MINUTES = Number.isFinite(Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES))
    ? Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES)
    : 180;
const RISK_SUMMARY_CACHE_MS = Number.isFinite(Number(GUARDS.SUMMARY_CACHE_MS)) ? Number(GUARDS.SUMMARY_CACHE_MS) : 15000;
const CRYPTO_LWM_CONFIG = STRATEGIES?.CRYPTO_LIQUIDITY_WINDOW_MOMENTUM || null;
const INTRADAY_DEFAULT_STRATEGY_ID = "INTRADAY_7STEP_V1";
const INTRADAY_FOREX_STRATEGY_ID = "INTRADAY_7STEP_FOREX";
const INTRADAY_CRYPTO_STRATEGY_ID = "INTRADAY_7STEP_CRYPTO";
const FOREX_PRIMARY_STRATEGY_NAME = String(STRATEGY_SELECTION?.FOREX_PRIMARY || INTRADAY_DEFAULT_STRATEGY_ID).toUpperCase();
const CRYPTO_PRIMARY_STRATEGY_NAME = String(STRATEGY_SELECTION?.CRYPTO_PRIMARY || INTRADAY_DEFAULT_STRATEGY_ID).toUpperCase();
const SNAPSHOT_CANDLE_LAG_BOUNDS_MINUTES = {
    m1: { min: -3, max: 20 },
    m5: { min: -10, max: 40 },
    m15: { min: -20, max: 150 },
    h1: { min: -90, max: 400 },
};
const MAX_M1_MID_DEVIATION_PIPS = Number.isFinite(Number(GUARDS.MAX_M1_MID_DEVIATION_PIPS)) ? Number(GUARDS.MAX_M1_MID_DEVIATION_PIPS) : 8;
const MARKET_DETAILS_CACHE_MS = 15000;
const FX_RATE_CACHE_MS = 10000;
const CLI_PANEL_WIDTH = 110;
const ANSI = {
    reset: "\u001b[0m",
    cyan: "\u001b[36m",
    brightCyan: "\u001b[96m",
    dim: "\u001b[2m",
    white: "\u001b[97m",
};

class TradingService {
    constructor() {
        this.openTrades = [];
        this.openPositionsBroker = [];
        this.accountBalance = 0;
        this.availableMargin = 0;
        this.accountCurrency = "EUR";
        this.dailyLoss = 0;
        this.dailyLossLimitPct = MAX_DAILY_LOSS_PCT;
        this.riskGuardState = {
            refreshedAtMs: 0,
            summary: null,
        };
        this.guardLogThrottle = new Map();
        this.noSignalLogState = new Map();
        this.cryptoLwmLastClosedM5KeyBySymbol = new Map();
        this.marketDetailsCache = new Map();
        this.fxRateCache = new Map();

        this.intradayForexConfig = {
            ...DEFAULT_INTRADAY_CONFIG,
            strategyId: INTRADAY_FOREX_STRATEGY_ID,
            context: { ...(DEFAULT_INTRADAY_CONFIG.context || {}) },
            setup: { ...(DEFAULT_INTRADAY_CONFIG.setup || {}) },
            trigger: { ...(DEFAULT_INTRADAY_CONFIG.trigger || {}) },
            risk: { ...(DEFAULT_INTRADAY_CONFIG.risk || {}) },
            guardrails: { ...(DEFAULT_INTRADAY_CONFIG.guardrails || {}) },
            backtest: { ...(DEFAULT_INTRADAY_CONFIG.backtest || {}) },
        };
        this.intradayCryptoConfig = mergeIntradayConfig(DEFAULT_INTRADAY_CONFIG, {
            ...DEFAULT_CRYPTO_INTRADAY_CONFIG,
            strategyId: INTRADAY_CRYPTO_STRATEGY_ID,
        });
        this.intradayForexEngine = createIntradaySevenStepEngine(this.intradayForexConfig);
        this.intradayCryptoEngine = createIntradaySevenStepEngine(this.intradayCryptoConfig);
        this.intradayForexState = createIntradayRuntimeState({ strategyId: INTRADAY_FOREX_STRATEGY_ID });
        this.intradayCryptoState = createIntradayRuntimeState({ strategyId: INTRADAY_CRYPTO_STRATEGY_ID });
        this.cryptoLwmConfigHash = computeConfigHash(CRYPTO_LWM_CONFIG);

        logger.info(`[Strategy] ForexPrimary=${FOREX_PRIMARY_STRATEGY_NAME} IntradayDefault=${INTRADAY_DEFAULT_STRATEGY_ID} Mode=FOREX_ONLY`);
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
    setAccountCurrency(currency) {
        const normalized = this.sanitizeCurrencyCode(currency);
        if (normalized) this.accountCurrency = normalized;
    }

    safeLogStrategyDecision(entry) {
        try {
            logStrategyDecision(entry);
        } catch (error) {
            logger.warn(`[DecisionLog] Failed to write decision log: ${error.message}`);
        }
    }

    buildIntradayStrategyMeta({ symbol, isCrypto, intradayEngine }) {
        const strategyId = isCrypto ? INTRADAY_CRYPTO_STRATEGY_ID : INTRADAY_FOREX_STRATEGY_ID;
        const baseConfig = isCrypto ? this.intradayCryptoConfig : this.intradayForexConfig;
        let resolvedConfig = baseConfig;
        try {
            if (intradayEngine && typeof intradayEngine.getResolvedConfigForSymbol === "function") {
                resolvedConfig = intradayEngine.getResolvedConfigForSymbol(symbol) || baseConfig;
            }
        } catch {
            resolvedConfig = baseConfig;
        }
        return {
            id: strategyId,
            name: INTRADAY_DEFAULT_STRATEGY_ID,
            configHash: computeConfigHash(resolvedConfig),
        };
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

    sanitizeCurrencyCode(value) {
        const raw = String(value || "").trim().toUpperCase();
        const match = raw.match(/[A-Z]{3}/);
        return match ? match[0] : null;
    }

    getCachedValue(cache, key) {
        const entry = cache.get(key);
        if (!entry) return null;
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return null;
        }
        return entry.value;
    }

    setCachedValue(cache, key, value, ttlMs) {
        cache.set(key, {
            value,
            expiresAt: Date.now() + Math.max(Number(ttlMs) || 0, 1000),
        });
        return value;
    }

    async getMarketDetailsCached(symbol, ttlMs = MARKET_DETAILS_CACHE_MS) {
        const upperSymbol = String(symbol || "").toUpperCase();
        if (!upperSymbol) return null;
        const cached = this.getCachedValue(this.marketDetailsCache, upperSymbol);
        if (cached) return cached;
        const details = await getMarketDetails(upperSymbol);
        return this.setCachedValue(this.marketDetailsCache, upperSymbol, details, ttlMs);
    }

    extractBaseCurrency(symbol, marketDetails = null) {
        const instrumentSymbol = String(marketDetails?.instrument?.symbol || "").replace(/[^A-Z]/gi, "");
        if (instrumentSymbol.length >= 6) {
            const fromInstrument = this.sanitizeCurrencyCode(instrumentSymbol.slice(0, 3));
            if (fromInstrument) return fromInstrument;
        }
        return this.sanitizeCurrencyCode(String(symbol || "").slice(0, 3));
    }

    extractQuoteCurrency(symbol, marketDetails = null) {
        const instrumentCurrency = this.sanitizeCurrencyCode(marketDetails?.instrument?.currency);
        if (instrumentCurrency) return instrumentCurrency;
        const instrumentSymbol = String(marketDetails?.instrument?.symbol || "").replace(/[^A-Z]/gi, "");
        if (instrumentSymbol.length >= 6) {
            const fromInstrument = this.sanitizeCurrencyCode(instrumentSymbol.slice(3, 6));
            if (fromInstrument) return fromInstrument;
        }
        return this.sanitizeCurrencyCode(String(symbol || "").slice(3, 6));
    }

    getStepDecimals(step) {
        if (!Number.isFinite(step) || step <= 0) return 0;
        const str = String(step);
        if (str.includes("e-")) {
            const exp = Number(str.split("e-")[1]);
            return Number.isFinite(exp) ? Math.min(Math.max(exp, 0), 10) : 0;
        }
        if (!str.includes(".")) return 0;
        return Math.min((str.split(".")[1] || "").length, 10);
    }

    roundDownToStep(value, step) {
        const num = this.toNumber(value);
        if (!Number.isFinite(num)) return null;
        if (!Number.isFinite(step) || step <= 0) return num;
        const steps = Math.floor(num / step + 1e-12);
        const decimals = this.getStepDecimals(step);
        return Number((steps * step).toFixed(decimals));
    }

    getSizeRulesFromMarketDetails(details = null) {
        const minDealSize = this.firstNumber(details?.dealingRules?.minDealSize?.value, details?.instrument?.minDealSize, 0);
        const maxDealSize = this.firstNumber(details?.dealingRules?.maxDealSize?.value, details?.instrument?.maxDealSize, Number.POSITIVE_INFINITY);
        const minSizeIncrement = this.firstNumber(details?.dealingRules?.minSizeIncrement?.value, details?.instrument?.minSizeIncrement, 1);
        return {
            minDealSize: Number.isFinite(minDealSize) ? minDealSize : 0,
            maxDealSize: Number.isFinite(maxDealSize) ? maxDealSize : Number.POSITIVE_INFINITY,
            minSizeIncrement: Number.isFinite(minSizeIncrement) && minSizeIncrement > 0 ? minSizeIncrement : 1,
        };
    }

    normalizeSizeToRules(rawSize, rules = {}) {
        let size = this.toNumber(rawSize);
        if (!Number.isFinite(size) || size <= 0) return null;

        const minDealSize = this.firstNumber(rules?.minDealSize, 0);
        const maxDealSize = this.firstNumber(rules?.maxDealSize, Number.POSITIVE_INFINITY);
        const minSizeIncrement = this.firstNumber(rules?.minSizeIncrement, 1);
        const minAligned = Number.isFinite(minDealSize)
            ? minSizeIncrement > 0
                ? Math.ceil(minDealSize / minSizeIncrement) * minSizeIncrement
                : minDealSize
            : 0;

        if (Number.isFinite(maxDealSize)) size = Math.min(size, maxDealSize);
        size = this.roundDownToStep(size, minSizeIncrement);
        if (!Number.isFinite(size)) return null;
        if (Number.isFinite(minAligned)) size = Math.max(size, minAligned);
        if (Number.isFinite(maxDealSize) && size > maxDealSize) return null;

        return size;
    }

    async getFxMidForSymbol(symbol) {
        const upperSymbol = String(symbol || "").toUpperCase();
        if (!upperSymbol) return null;
        try {
            const details = await this.getMarketDetailsCached(upperSymbol, FX_RATE_CACHE_MS);
            const bid = this.firstNumber(details?.snapshot?.bid, details?.market?.bid);
            const ask = this.firstNumber(details?.snapshot?.offer, details?.snapshot?.ask, details?.market?.offer);
            return this.getMidPrice(bid, ask);
        } catch {
            return null;
        }
    }

    async getFxRate(baseCurrencyRaw, quoteCurrencyRaw) {
        const baseCurrency = this.sanitizeCurrencyCode(baseCurrencyRaw);
        const quoteCurrency = this.sanitizeCurrencyCode(quoteCurrencyRaw);
        if (!baseCurrency || !quoteCurrency) return null;
        if (baseCurrency === quoteCurrency) return 1;

        const cacheKey = `${baseCurrency}->${quoteCurrency}`;
        const cached = this.getCachedValue(this.fxRateCache, cacheKey);
        if (cached !== null) return cached;

        const directSymbol = `${baseCurrency}${quoteCurrency}`;
        const reverseSymbol = `${quoteCurrency}${baseCurrency}`;
        const directMid = await this.getFxMidForSymbol(directSymbol);
        if (Number.isFinite(directMid) && directMid > 0) {
            return this.setCachedValue(this.fxRateCache, cacheKey, directMid, FX_RATE_CACHE_MS);
        }

        const reverseMid = await this.getFxMidForSymbol(reverseSymbol);
        if (Number.isFinite(reverseMid) && reverseMid > 0) {
            return this.setCachedValue(this.fxRateCache, cacheKey, 1 / reverseMid, FX_RATE_CACHE_MS);
        }

        return null;
    }

    async getCurrencyToAccountRate(currencyRaw) {
        const accountCurrency = this.sanitizeCurrencyCode(this.accountCurrency) || "EUR";
        const currency = this.sanitizeCurrencyCode(currencyRaw);
        if (!currency) return null;
        if (currency === accountCurrency) return 1;

        const directRate = await this.getFxRate(currency, accountCurrency);
        if (Number.isFinite(directRate) && directRate > 0) return directRate;

        if (currency !== "USD" && accountCurrency !== "USD") {
            const toUsd = await this.getFxRate(currency, "USD");
            const usdToAccount = await this.getFxRate("USD", accountCurrency);
            if (Number.isFinite(toUsd) && toUsd > 0 && Number.isFinite(usdToAccount) && usdToAccount > 0) {
                return toUsd * usdToAccount;
            }
        }

        return null;
    }

    async adjustOrderPlanSizeForBroker({ symbol, orderPlan }) {
        const requestedSize = this.toNumber(orderPlan?.size);
        const riskAmount = this.toNumber(orderPlan?.riskAmount);
        const stopDistance = this.toNumber(orderPlan?.stopDistance);
        let targetSize = requestedSize;
        let marketDetails = null;
        const sizingMeta = {
            accountCurrency: this.sanitizeCurrencyCode(this.accountCurrency) || "EUR",
            quoteCurrency: null,
            requestedSize,
            calculatedSize: null,
            adjustedSize: requestedSize,
            minDealSize: null,
            maxDealSize: null,
            minSizeIncrement: null,
            contractSize: null,
            baseCurrency: null,
            quoteToAccountRate: null,
            baseToAccountRate: null,
            leverageUsed: null,
            marginBudget: null,
            marginPerUnit: null,
            maxSizeByMargin: null,
            estimatedRiskAtSl: null,
            sizingMethod: "plan_size",
            error: null,
        };

        try {
            marketDetails = await this.getMarketDetailsCached(symbol);
            const baseCurrency = this.extractBaseCurrency(symbol, marketDetails);
            const quoteCurrency = this.extractQuoteCurrency(symbol, marketDetails);
            const contractSize = this.firstNumber(marketDetails?.instrument?.contractSize, marketDetails?.instrument?.lotSize, 1);
            const quoteToAccountRate = await this.getCurrencyToAccountRate(quoteCurrency);
            const baseToAccountRate = await this.getCurrencyToAccountRate(baseCurrency);
            const openBrokerPosition = this.getOpenBrokerPositionBySymbol(symbol);
            const leverage = this.firstNumber(openBrokerPosition?.leverage, this.isCryptoSymbol(symbol) ? 2 : 30);
            const availableMargin =
                Number.isFinite(this.availableMargin) && this.availableMargin > 0
                    ? this.availableMargin
                    : Number.isFinite(this.accountBalance)
                      ? this.accountBalance
                      : null;
            const marginBudget = Number.isFinite(availableMargin) && availableMargin > 0 ? availableMargin * 0.95 : null;
            const entryPrice = this.firstNumber(
                orderPlan?.requestedPrice,
                orderPlan?.entryPrice,
                marketDetails?.snapshot?.offer,
                marketDetails?.snapshot?.bid,
            );

            sizingMeta.baseCurrency = baseCurrency;
            sizingMeta.quoteCurrency = quoteCurrency;
            sizingMeta.contractSize = contractSize;
            sizingMeta.quoteToAccountRate = quoteToAccountRate;
            sizingMeta.baseToAccountRate = baseToAccountRate;
            sizingMeta.leverageUsed = leverage;
            sizingMeta.marginBudget = marginBudget;

            if (
                Number.isFinite(riskAmount) &&
                riskAmount > 0 &&
                Number.isFinite(stopDistance) &&
                stopDistance > 0 &&
                Number.isFinite(contractSize) &&
                contractSize > 0 &&
                Number.isFinite(quoteToAccountRate) &&
                quoteToAccountRate > 0
            ) {
                const calculatedSize = riskAmount / (stopDistance * contractSize * quoteToAccountRate);
                if (Number.isFinite(calculatedSize) && calculatedSize > 0) {
                    targetSize = calculatedSize;
                    sizingMeta.calculatedSize = calculatedSize;
                    sizingMeta.sizingMethod = "risk_amount_converted";
                }
            }

            if (Number.isFinite(marginBudget) && marginBudget > 0 && Number.isFinite(leverage) && leverage > 0 && Number.isFinite(contractSize) && contractSize > 0) {
                let notionalPerUnitAccount = null;
                if (this.isCryptoSymbol(symbol)) {
                    if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quoteToAccountRate) && quoteToAccountRate > 0) {
                        notionalPerUnitAccount = entryPrice * quoteToAccountRate * contractSize;
                    }
                } else if (Number.isFinite(baseToAccountRate) && baseToAccountRate > 0) {
                    notionalPerUnitAccount = baseToAccountRate * contractSize;
                }

                if (Number.isFinite(notionalPerUnitAccount) && notionalPerUnitAccount > 0) {
                    const marginPerUnit = notionalPerUnitAccount / leverage;
                    const maxSizeByMargin = marginPerUnit > 0 ? marginBudget / marginPerUnit : null;
                    sizingMeta.marginPerUnit = marginPerUnit;
                    sizingMeta.maxSizeByMargin = maxSizeByMargin;
                    if (Number.isFinite(maxSizeByMargin) && maxSizeByMargin > 0 && Number.isFinite(targetSize) && targetSize > maxSizeByMargin) {
                        targetSize = maxSizeByMargin;
                        sizingMeta.sizingMethod = `${sizingMeta.sizingMethod}_margin_capped`;
                    }
                }
            }

            const sizeRules = this.getSizeRulesFromMarketDetails(marketDetails);
            sizingMeta.minDealSize = sizeRules.minDealSize;
            sizingMeta.maxDealSize = Number.isFinite(sizeRules.maxDealSize) ? sizeRules.maxDealSize : null;
            sizingMeta.minSizeIncrement = sizeRules.minSizeIncrement;

            const normalizedSize = this.normalizeSizeToRules(targetSize, sizeRules);
            if (Number.isFinite(normalizedSize) && normalizedSize > 0) {
                targetSize = normalizedSize;
            }

            if (
                Number.isFinite(stopDistance) &&
                stopDistance > 0 &&
                Number.isFinite(contractSize) &&
                contractSize > 0 &&
                Number.isFinite(quoteToAccountRate) &&
                quoteToAccountRate > 0 &&
                Number.isFinite(targetSize) &&
                targetSize > 0
            ) {
                sizingMeta.estimatedRiskAtSl = stopDistance * contractSize * quoteToAccountRate * targetSize;
            }
        } catch (error) {
            sizingMeta.error = error?.message || "sizing_adjustment_failed";
        }

        if (!Number.isFinite(targetSize) || targetSize <= 0) {
            targetSize = requestedSize;
        }

        sizingMeta.adjustedSize = targetSize;

        return {
            orderPlan: {
                ...(orderPlan || {}),
                size: targetSize,
            },
            sizingMeta,
            marketDetails,
        };
    }

    toTimestampMs(value) {
        if (value === undefined || value === null || value === "") return null;
        if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
        if (typeof value === "number") {
            const dt = new Date(value);
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }

        const raw = String(value).trim();
        if (!raw) return null;

        const isoNoZone = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
        if (isoNoZone) {
            const [, y, m, d, hh, mm, ss = "00", frac = ""] = isoNoZone;
            const ms = frac ? Number(String(frac).slice(0, 3).padEnd(3, "0")) : 0;
            const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss), ms));
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }

        const ymdUtc = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
        if (ymdUtc) {
            const [, y, m, d, hh, mm, ss = "00", frac = ""] = ymdUtc;
            const ms = frac ? Number(String(frac).slice(0, 3).padEnd(3, "0")) : 0;
            const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss), ms));
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }

        const tsMs = Date.parse(raw);
        return Number.isFinite(tsMs) ? tsMs : null;
    }

    toIsoTimestamp(value) {
        const tsMs = this.toTimestampMs(value);
        return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    }

    getMidPrice(bid, ask) {
        const bidNum = this.toNumber(bid);
        const askNum = this.toNumber(ask);
        if (Number.isFinite(bidNum) && Number.isFinite(askNum)) return (bidNum + askNum) / 2;
        return bidNum ?? askNum ?? null;
    }

    formatDiagnosticNumber(value, decimals = 4) {
        const num = this.toNumber(value);
        if (!Number.isFinite(num)) return "-";
        return String(Number(num.toFixed(decimals)));
    }

    formatDiagnosticBoolean(value) {
        if (value === true) return "yes";
        if (value === false) return "no";
        return "-";
    }

    formatDiagnosticList(values, separator = ",") {
        if (!Array.isArray(values) || !values.length) return "-";
        return values.map((value) => String(value)).filter(Boolean).join(separator);
    }

    formatDiagnosticReason(reason) {
        const raw = String(reason || "").trim();
        if (!raw) return "-";
        const map = {
            triggerConfirmed: "trigger_not_confirmed",
            guardrails_or_trigger_not_ready: "waiting_for_trigger_or_guardrails",
            symbol_not_in_active_universe: "symbol_not_in_session_universe",
            symbol_session_filtered: "symbol_session_filtered",
            hour_bucket_filtered: "hour_bucket_filtered",
            no_setup: "no_setup",
        };
        const normalized = map[raw] || raw;
        return normalized.replace(/_/g, " ");
    }

    formatDiagnosticReasons(values, separator = ", ") {
        if (!Array.isArray(values) || !values.length) return "-";
        return values
            .map((value) => this.formatDiagnosticReason(value))
            .filter((value) => value && value !== "-")
            .join(separator);
    }

    formatDiagnosticTimestamp(value) {
        return this.toIsoTimestamp(value) || "-";
    }

    supportsPrettyCli() {
        if (String(process.env.NO_COLOR || "").trim() === "1") return false;
        if (String(process.env.CI || "").trim() === "true") return false;
        return Boolean(process.stdout?.isTTY);
    }

    colorize(text, color) {
        if (!this.supportsPrettyCli()) return text;
        const prefix = ANSI[color];
        return prefix ? `${prefix}${text}${ANSI.reset}` : text;
    }

    truncateDiagnosticText(value, maxLength = 24) {
        const text = String(value ?? "-");
        if (text.length <= maxLength) return text;
        return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
    }

    padDiagnosticText(value, width, align = "left") {
        const text = this.truncateDiagnosticText(value, width);
        if (text.length >= width) return text;
        return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
    }

    formatPanelKv(label, value, labelWidth = 8, valueWidth = 16) {
        return `${this.padDiagnosticText(String(label || "").toUpperCase(), labelWidth)} ${this.padDiagnosticText(value, valueWidth)}`;
    }

    buildCliPanel(title, rows, width = CLI_PANEL_WIDTH) {
        const innerWidth = Math.max(20, width - 4);
        const topBorder = this.colorize(`+${"=".repeat(innerWidth + 2)}+`, "brightCyan");
        const divider = this.colorize(`+${"-".repeat(innerWidth + 2)}+`, "cyan");
        const renderLine = (content = "", color = "white") => {
            const clipped = this.padDiagnosticText(content, innerWidth);
            const tinted = this.colorize(clipped, color);
            const border = this.colorize("|", "cyan");
            return `${border} ${tinted} ${border}`;
        };

        const lines = [topBorder, renderLine(title, "brightCyan"), divider];
        for (const row of rows) {
            lines.push(renderLine(row, "white"));
        }
        lines.push(topBorder);
        return lines.join("\n");
    }

    buildCliTableRow(columns = [], width = CLI_PANEL_WIDTH) {
        const innerWidth = Math.max(20, width - 4);
        const rendered = columns.map((column) => this.padDiagnosticText(column.text, column.width, column.align || "left")).join(" | ");
        return this.padDiagnosticText(rendered, innerWidth);
    }

    buildCliTableBlock(title, sections = [], width = CLI_PANEL_WIDTH) {
        const innerWidth = Math.max(20, width - 4);
        const topBorder = this.colorize(`+${"=".repeat(innerWidth + 2)}+`, "brightCyan");
        const divider = this.colorize(`+${"-".repeat(innerWidth + 2)}+`, "cyan");
        const renderLine = (content = "", color = "white") => {
            const clipped = this.padDiagnosticText(content, innerWidth);
            const tinted = this.colorize(clipped, color);
            const border = this.colorize("|", "cyan");
            return `${border} ${tinted} ${border}`;
        };

        const lines = [topBorder, renderLine(title, "brightCyan"), divider];
        for (const section of sections) {
            if (section.type === "table") {
                if (section.header) lines.push(renderLine(this.buildCliTableRow(section.header, width), "brightCyan"));
                if (section.row) lines.push(renderLine(this.buildCliTableRow(section.row, width), "white"));
            } else {
                lines.push(renderLine(section.text || "", section.color || "white"));
            }
        }
        lines.push(topBorder);
        return lines.join("\n");
    }

    determineIntradayBlocker(decision) {
        if (!decision || typeof decision !== "object") return "UNKNOWN";
        if (!decision?.step1?.symbolAllowed || decision?.step1?.forceFlatNow) return "STEP1_MARKET_WINDOW";
        if (decision?.step3?.setupType === "NONE") return "STEP3_SETUP";
        if (!decision?.step4?.triggerOk) return "STEP4_TRIGGER";
        if (!decision?.guardrails?.allowed) return "GUARDRAILS";
        if (!decision?.step5?.valid) return "STEP5_RISK";
        return "UNKNOWN";
    }

    shouldEmitNoSignalLog(symbol, decision, blocker) {
        const upperSymbol = String(symbol || decision?.symbol || "").toUpperCase() || "UNKNOWN";
        const fingerprint = JSON.stringify({
            blocker,
            session: decision?.step1?.activeSession || "-",
            activeSessions: decision?.step1?.activeSessions || [],
            symbolAllowed: Boolean(decision?.step1?.symbolAllowed),
            forceFlatNow: Boolean(decision?.step1?.forceFlatNow),
            hourBucketUtc: decision?.step1?.hourBucketUtc || "-",
            regime: decision?.step2?.regimeType || "-",
            adx: this.formatDiagnosticNumber(decision?.step2?.logFields?.h1Adx, 2),
            volatility: decision?.step2?.volatilityRegime || "-",
            setupType: decision?.step3?.setupType || "-",
            side: decision?.step3?.side || "-",
            rsi: this.formatDiagnosticNumber(decision?.step3?.logFields?.m15Rsi, 2),
            bbpb: this.formatDiagnosticNumber(decision?.step3?.logFields?.m15BbPb, 3),
            triggerOk: this.formatDiagnosticBoolean(decision?.step4?.triggerOk),
            guardAllowed: this.formatDiagnosticBoolean(decision?.guardrails?.allowed),
            riskValid: this.formatDiagnosticBoolean(decision?.step5?.valid),
            reasons: decision?.reasons || [],
            step1Reasons: decision?.step1?.step1Reasons || [],
            step2Reasons: decision?.step2?.contextReasons || [],
            step4Reasons: decision?.step4?.triggerReasons || [],
            guardReasons: decision?.guardrails?.blockReasons || [],
            step5Reasons: decision?.step5?.planReasons || [],
        });

        const repeatMs = 10 * 60 * 1000;
        const nowMs = Date.now();
        const previous = this.noSignalLogState.get(upperSymbol);
        if (previous && previous.fingerprint === fingerprint && nowMs - previous.loggedAtMs < repeatMs) {
            return false;
        }
        this.noSignalLogState.set(upperSymbol, { fingerprint, loggedAtMs: nowMs });
        return true;
    }

    buildIntradayDecisionDiagnosticLines(symbol, decision) {
        const step1 = decision?.step1 || {};
        const step2 = decision?.step2 || {};
        const step3 = decision?.step3 || {};
        const step4 = decision?.step4 || {};
        const guardrails = decision?.guardrails || {};
        const step5 = decision?.step5 || {};
        const upperSymbol = String(symbol || decision?.symbol || "").toUpperCase() || "UNKNOWN";
        const blocker = this.determineIntradayBlocker(decision);
        const activeSessions = this.formatDiagnosticList(step1.activeSessions, "+");
        const preferredSessions = this.formatDiagnosticList(step1.logFields?.preferredSymbolSessions, "+");
        const contextReasons = this.formatDiagnosticReasons(
            Array.isArray(step2.contextReasons)
                ? step2.contextReasons.filter((reason) => !String(reason).startsWith("ema_set="))
                : [],
        );
        const step1Reasons = this.formatDiagnosticReasons(
            Array.isArray(step1.step1Reasons)
                ? step1.step1Reasons.filter((reason) => !String(reason).startsWith("session=") && !String(reason).startsWith("overlap="))
                : [],
        );
        const primaryHeader = [
            { text: "SYM", width: 8 },
            { text: "BLOCKER", width: 13 },
            { text: "SES", width: 7 },
            { text: "ACTIVE", width: 14 },
            { text: "PREF", width: 14 },
            { text: "REGIME", width: 8 },
            { text: "ADX", width: 6, align: "right" },
            { text: "SETUP", width: 8 },
            { text: "TRG", width: 4 },
        ];
        const primaryRow = [
            { text: upperSymbol, width: 8 },
            { text: blocker, width: 13 },
            { text: step1.activeSession || "-", width: 7 },
            { text: activeSessions, width: 14 },
            { text: preferredSessions, width: 14 },
            { text: step2.regimeType || "-", width: 8 },
            { text: this.formatDiagnosticNumber(step2.logFields?.h1Adx, 2), width: 6, align: "right" },
            { text: step3.setupType || "-", width: 8 },
            { text: this.formatDiagnosticBoolean(step4.triggerOk), width: 4 },
        ];
        const secondaryHeader = [
            { text: "HOUR", width: 7 },
            { text: "ALLOW", width: 5 },
            { text: "CUT", width: 3 },
            { text: "SIDE", width: 5 },
            { text: "RSI", width: 6, align: "right" },
            { text: "BBPB", width: 7, align: "right" },
            { text: "GUARD", width: 5 },
            { text: "RISK", width: 4 },
            { text: "NEXT", width: 12 },
            { text: "VOL", width: 8 },
        ];
        const secondaryRow = [
            { text: step1.hourBucketUtc || "-", width: 7 },
            { text: this.formatDiagnosticBoolean(step1.symbolAllowed), width: 5 },
            { text: this.formatDiagnosticBoolean(step1.forceFlatNow), width: 3 },
            { text: step3.side || "-", width: 5 },
            { text: this.formatDiagnosticNumber(step3.logFields?.m15Rsi, 2), width: 6, align: "right" },
            { text: this.formatDiagnosticNumber(step3.logFields?.m15BbPb, 3), width: 7, align: "right" },
            { text: this.formatDiagnosticBoolean(guardrails.allowed), width: 5 },
            { text: this.formatDiagnosticBoolean(step5.valid), width: 4 },
            {
                text:
                    blocker === "STEP3_SETUP"
                        ? "wait_step3"
                        : blocker === "STEP4_TRIGGER"
                          ? "wait_trigger"
                          : blocker === "GUARDRAILS"
                            ? "guard_block"
                            : blocker === "STEP5_RISK"
                              ? "risk_block"
                              : "review",
                width: 12,
            },
            { text: step2.volatilityRegime || "-", width: 8 },
        ];

        let noteText = contextReasons !== "-" ? contextReasons : step1Reasons;
        if (blocker === "STEP4_TRIGGER" || blocker === "GUARDRAILS" || blocker === "STEP5_RISK") {
            noteText = this.formatDiagnosticReasons(step4.triggerReasons);
        }
        if (blocker === "GUARDRAILS" || blocker === "STEP5_RISK") {
            noteText = `blocks=${this.formatDiagnosticReasons(guardrails.blockReasons)} | daily=${this.formatDiagnosticNumber(guardrails.logFields?.dailyTradeCount, 0)} | long=${this.formatDiagnosticNumber(guardrails.logFields?.clientLongPct, 3)} | short=${this.formatDiagnosticNumber(guardrails.logFields?.clientShortPct, 3)}`;
        }
        if (blocker === "STEP5_RISK" || step5.valid) {
            noteText = `pct=${this.formatDiagnosticNumber(step5.logFields?.riskPct, 4)} | amt=${this.formatDiagnosticNumber(step5.logFields?.riskAmount, 2)} | stop=${this.formatDiagnosticNumber(step5.logFields?.stopDistance, 6)} | rr=${this.formatDiagnosticNumber(step5.logFields?.rr, 2)} | notes=${this.formatDiagnosticReasons(step5.planReasons)}`;
        }

        const panel = this.buildCliTableBlock(`TRON TABLE // ${upperSymbol} // ${blocker}`, [
            { type: "table", header: primaryHeader, row: primaryRow },
            { type: "table", header: secondaryHeader, row: secondaryRow },
            { type: "text", text: `NOTE  ${this.truncateDiagnosticText(noteText, 94)}` },
        ]);
        return [panel];
    }

    buildSnapshotValidationDiagnostic(snapshot, validation) {
        const details = validation?.details || {};
        const lagMinutes = details?.lagMinutes || {};
        const lagTimestamps = details?.lagTimestamps || {};
        const lagSummary = Object.keys(lagMinutes).length
            ? Object.entries(lagMinutes)
                  .map(
                      ([tf, lag]) =>
                          `${tf}:${this.formatDiagnosticNumber(lag, 2)}m@${this.formatDiagnosticTimestamp(lagTimestamps?.[tf])}`,
                  )
                  .join(",")
            : "-";

        return [
            `ts=${this.formatDiagnosticTimestamp(snapshot?.timestamp)}`,
            `marketTs=${this.formatDiagnosticTimestamp(snapshot?.marketTimestamp)}`,
            `bid=${this.formatDiagnosticNumber(snapshot?.bid, 6)}`,
            `ask=${this.formatDiagnosticNumber(snapshot?.ask, 6)}`,
            `mid=${this.formatDiagnosticNumber(snapshot?.mid, 6)}`,
            `spread=${this.formatDiagnosticNumber(snapshot?.spread, 6)}`,
            `lagOffsetMin=${this.formatDiagnosticNumber(details?.lagOffsetMinutes, 0)}`,
            `lagCheckTs=${this.formatDiagnosticTimestamp(details?.lagCheckTimestamp)}`,
            `lags=${lagSummary}`,
            `m1Ref=${this.formatDiagnosticNumber(details?.m1ReferenceClose, 6)}@${this.formatDiagnosticTimestamp(details?.m1ReferenceTimestamp)}`,
            `driftPips=${this.formatDiagnosticNumber(details?.m1DriftPips, 2)}`,
            `issues=${this.formatDiagnosticList(validation?.issues)}`,
        ].join(" | ");
    }

    validateIntradaySnapshot({ symbol, snapshot, isCrypto = false }) {
        const issues = [];
        const details = {
            snapshotTimestamp: this.toIsoTimestamp(snapshot?.timestamp),
            marketTimestamp: this.toIsoTimestamp(snapshot?.marketTimestamp),
            lagOffsetMinutes: 0,
            lagCheckTimestamp: null,
            lagMinutes: {},
            lagTimestamps: {},
            m1ReferenceTimestamp: null,
            m1ReferenceClose: null,
            m1DriftPips: null,
        };
        const tsMs = this.toTimestampMs(snapshot?.timestamp);
        if (!Number.isFinite(tsMs)) issues.push("invalid_snapshot_timestamp");

        const bid = this.toNumber(snapshot?.bid);
        const ask = this.toNumber(snapshot?.ask);
        const mid = this.toNumber(snapshot?.mid);
        details.bid = bid;
        details.ask = ask;
        details.mid = mid;
        details.spread = this.toNumber(snapshot?.spread);
        if (!isCrypto) {
            if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
                issues.push("invalid_bid_ask");
            } else if (ask < bid) {
                issues.push("ask_below_bid");
            }
        }
        if (!Number.isFinite(mid)) issues.push("invalid_mid_price");

        const evaluateLagIssues = (anchorTsMs) => {
            const lagIssues = [];
            const lagMinutesByTf = {};
            const lagTimestamps = {};
            for (const [tf, bounds] of Object.entries(SNAPSHOT_CANDLE_LAG_BOUNDS_MINUTES)) {
                const bar = snapshot?.bars?.[tf];
                const barTsMs = this.toTimestampMs(bar?.t);
                if (!Number.isFinite(barTsMs)) {
                    lagIssues.push(`${tf}_bar_time_invalid`);
                    lagTimestamps[tf] = this.toIsoTimestamp(bar?.t);
                    continue;
                }
                const lagMinutes = (anchorTsMs - barTsMs) / 60000;
                lagTimestamps[tf] = this.toIsoTimestamp(bar?.t);
                lagMinutesByTf[tf] = Number(lagMinutes.toFixed(2));
                if (lagMinutesByTf[tf] < bounds.min || lagMinutesByTf[tf] > bounds.max) {
                    lagIssues.push(`${tf}_bar_lag_${lagMinutesByTf[tf].toFixed(2)}m`);
                }
            }
            return { lagIssues, lagMinutes: lagMinutesByTf, lagTimestamps };
        };

        if (Number.isFinite(tsMs)) {
            let lagDiagnostics = evaluateLagIssues(tsMs);
            details.lagCheckTimestamp = this.toIsoTimestamp(tsMs);

            // Auto-correct recurring timezone offsets (e.g. +/-60m) when that
            // fully resolves all timeframe lag checks.
            if (lagDiagnostics.lagIssues.length) {
                const offsetCandidates = [-60, 60, -120, 120, -180, 180];
                for (const offsetMinutes of offsetCandidates) {
                    const shifted = tsMs + offsetMinutes * 60000;
                    const shiftedDiagnostics = evaluateLagIssues(shifted);
                    if (!shiftedDiagnostics.lagIssues.length) {
                        lagDiagnostics = shiftedDiagnostics;
                        details.lagOffsetMinutes = offsetMinutes;
                        details.lagCheckTimestamp = this.toIsoTimestamp(shifted);
                        break;
                    }
                }
            }
            details.lagMinutes = lagDiagnostics.lagMinutes;
            details.lagTimestamps = lagDiagnostics.lagTimestamps;
            issues.push(...lagDiagnostics.lagIssues);
        }

        const m1ReferenceBarCandidates = [snapshot?.latestBars?.m1, snapshot?.bars?.m1]
            .filter((bar) => bar && typeof bar === "object")
            .map((bar) => ({
                close: this.toNumber(bar?.c ?? bar?.close),
                tsMs: this.toTimestampMs(bar?.t ?? bar?.timestamp),
            }))
            .filter((bar) => Number.isFinite(bar.close));
        const m1ReferenceBar =
            Number.isFinite(tsMs) && m1ReferenceBarCandidates.length
                ? [...m1ReferenceBarCandidates].sort((a, b) => {
                      const aDistance = Number.isFinite(a.tsMs) ? Math.abs(tsMs - a.tsMs) : Number.POSITIVE_INFINITY;
                      const bDistance = Number.isFinite(b.tsMs) ? Math.abs(tsMs - b.tsMs) : Number.POSITIVE_INFINITY;
                      return aDistance - bDistance;
                  })[0]
                : null;
        const m1Close = this.firstNumber(
            m1ReferenceBar?.close,
            snapshot?.bars?.m1?.c,
            snapshot?.indicators?.m1?.close,
            snapshot?.indicators?.m1?.lastClose,
        );
        details.m1ReferenceTimestamp = this.toIsoTimestamp(m1ReferenceBar?.tsMs);
        details.m1ReferenceClose = Number.isFinite(m1Close) ? m1Close : null;
        if (!isCrypto && Number.isFinite(mid) && Number.isFinite(m1Close)) {
            const pipValue = this.getPipValue(symbol);
            const driftPips = pipValue > 0 ? Math.abs(mid - m1Close) / pipValue : null;
            details.m1DriftPips = Number.isFinite(driftPips) ? Number(driftPips.toFixed(2)) : null;
            if (Number.isFinite(driftPips) && driftPips > MAX_M1_MID_DEVIATION_PIPS) {
                issues.push(`m1_mid_drift_${driftPips.toFixed(2)}pip`);
            }
        }

        return {
            ok: issues.length === 0,
            issues,
            details,
        };
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

    isCryptoLiquidityWindowMomentumEnabled() {
        return Boolean(CRYPTO_LWM_CONFIG?.enabled) && CRYPTO_PRIMARY_STRATEGY_NAME === CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID;
    }

    isCryptoLiquidityWindowMomentumSymbol(symbol) {
        if (!this.isCryptoLiquidityWindowMomentumEnabled()) return false;
        const allowed = Array.isArray(CRYPTO_LWM_CONFIG?.symbols) ? CRYPTO_LWM_CONFIG.symbols : [];
        return allowed.map((s) => String(s).toUpperCase()).includes(String(symbol || "").toUpperCase());
    }

    shouldAlwaysEvaluateCryptoSymbol(symbol) {
        return this.isCryptoLiquidityWindowMomentumSymbol(symbol);
    }

    shouldEvaluateForexSymbolNow(symbol, now = new Date()) {
        const upperSymbol = String(symbol || "").toUpperCase();
        if (!upperSymbol || this.isCryptoSymbol(upperSymbol)) return true;
        const config =
            this.intradayForexEngine && typeof this.intradayForexEngine.getResolvedConfigForSymbol === "function"
                ? this.intradayForexEngine.getResolvedConfigForSymbol(upperSymbol) || this.intradayForexConfig
                : this.intradayForexConfig;
        const step1 = step1MarketTimeWindow(
            {
                nowUtc: now,
                symbol: upperSymbol,
            },
            config,
        );
        return Boolean(step1?.symbolAllowed) && !Boolean(step1?.forceFlatNow);
    }

    shouldUseCryptoLiquidityWindowMomentumForOpenDeal(dealId, symbol) {
        if (!this.isCryptoLiquidityWindowMomentumEnabled()) return false;
        if (!dealId && !symbol) return false;
        const { entry } = getTradeEntry(dealId, symbol);
        return this.isCryptoLwmLogEntry(entry);
    }

    isCryptoLwmLogEntry(entry) {
        if (!entry || typeof entry !== "object") return false;
        const entryStrategyId =
            String(entry?.strategyId || entry?.strategyMeta?.id || entry?.riskMeta?.strategyId || entry?.riskMeta?.strategyMeta?.id || "").toUpperCase();
        return entryStrategyId === CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID;
    }

    readSymbolTradeLogEntries(symbol) {
        try {
            const logPath = getSymbolLogPath(symbol);
            if (!fs.existsSync(logPath)) return [];
            const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
            const rows = [];
            for (const line of lines) {
                try {
                    rows.push(JSON.parse(line));
                } catch {
                    // ignore malformed line
                }
            }
            return rows;
        } catch (error) {
            logger.warn(`[CryptoLWM] Failed to read trade log for ${symbol}: ${error.message}`);
            return [];
        }
    }

    estimateLoggedTradePnl(entry) {
        if (!entry || String(entry.status || "").toLowerCase() !== "closed") return null;
        const signal = String(entry?.signal || entry?.side || "").toUpperCase();
        const entryPrice = this.firstNumber(entry?.entryPrice, entry?.level);
        const closePrice = this.firstNumber(entry?.closePrice, entry?.closeLevel, entry?.levelOnClose);
        const size = this.firstNumber(entry?.riskMeta?.size, entry?.size);
        if (!["BUY", "SELL"].includes(signal)) return null;
        if (![entryPrice, closePrice, size].every((v) => Number.isFinite(v))) return null;
        const points = signal === "BUY" ? closePrice - entryPrice : entryPrice - closePrice;
        return points * size;
    }

    getCryptoLwmDaySummary(timestamp) {
        const dayKey = getDateKeyInTimeZone(timestamp, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin");
        const symbols = Array.isArray(CRYPTO_LWM_CONFIG?.symbols) ? CRYPTO_LWM_CONFIG.symbols : [];
        let realizedPnlToday = 0;
        let hasPnl = false;
        let tradesTodayTotal = 0;

        for (const symbol of symbols) {
            const entries = this.readSymbolTradeLogEntries(symbol);
            for (const entry of entries) {
                if (!this.isCryptoLwmLogEntry(entry)) continue;
                const openedAt = entry?.openedAt ?? entry?.timestamp;
                if (openedAt && getDateKeyInTimeZone(openedAt, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin") === dayKey) {
                    tradesTodayTotal += 1;
                }
                const closedAt = entry?.closedAt;
                if (String(entry?.status || "").toLowerCase() !== "closed" || !closedAt) continue;
                if (getDateKeyInTimeZone(closedAt, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin") !== dayKey) continue;
                const pnl = this.estimateLoggedTradePnl(entry);
                if (Number.isFinite(pnl)) {
                    realizedPnlToday += pnl;
                    hasPnl = true;
                }
            }
        }

        const accountBalance = this.toNumber(this.accountBalance);
        const startOfDayEquity =
            Number.isFinite(accountBalance) && Number.isFinite(realizedPnlToday) ? accountBalance - realizedPnlToday : Number.isFinite(accountBalance) ? accountBalance : null;

        return {
            dayKey,
            realizedPnlToday: hasPnl ? realizedPnlToday : 0,
            tradesTodayTotal,
            startOfDayEquity,
        };
    }

    getCryptoLwmSymbolCounters(symbol, timestamp) {
        const upper = String(symbol || "").toUpperCase();
        const dayKey = getDateKeyInTimeZone(timestamp, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin");
        let tradesTodaySymbol = 0;
        let lastExitAt = null;
        const entries = this.readSymbolTradeLogEntries(upper);

        for (const entry of entries) {
            if (!this.isCryptoLwmLogEntry(entry)) continue;
            const openedAt = entry?.openedAt ?? entry?.timestamp;
            if (openedAt && getDateKeyInTimeZone(openedAt, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin") === dayKey) {
                tradesTodaySymbol += 1;
            }
            const closedAt = entry?.closedAt;
            if (!closedAt || String(entry?.status || "").toLowerCase() !== "closed") continue;
            const closedDayKey = getDateKeyInTimeZone(closedAt, CRYPTO_LWM_CONFIG?.timezone || "Europe/Berlin");
            if (closedDayKey !== dayKey) continue;
            const closedTsMs = Date.parse(String(closedAt));
            if (Number.isFinite(closedTsMs) && (!Number.isFinite(lastExitAt) || closedTsMs > lastExitAt)) {
                lastExitAt = closedTsMs;
            }
        }

        return {
            tradesTodaySymbol,
            lastExitAtMs: Number.isFinite(lastExitAt) ? lastExitAt : null,
            entries,
        };
    }

    getClosedBarKeyFromCandle(rawCandle) {
        const bar = normalizeBar(rawCandle);
        if (!bar) return null;
        return bar.t || (Number.isFinite(bar.tsMs) ? `ts:${bar.tsMs}` : `ohlc:${[bar.o, bar.h, bar.l, bar.c].join("|")}`);
    }

    getClosedBarsForStrategy(candleArray) {
        if (!Array.isArray(candleArray) || candleArray.length < 2) return [];
        // The last candle can still be forming in live mode.
        return candleArray.slice(0, -1);
    }

    logCryptoLwmDecision(payload) {
        try {
            logger.info(JSON.stringify({ ...payload, strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID }));
        } catch (error) {
            logger.warn(`[CryptoLWM] Failed to serialize decision log: ${error.message}`);
        }
    }

    isSymbolTraded(symbol) {
        return this.openTrades.includes(symbol);
    }

    getConfiguredRiskPct(symbol) {
        return this.isCryptoSymbol(symbol) ? CRYPTO_PER_TRADE : PER_TRADE;
    }

    pickTrend(indicator) {
        if (!indicator || typeof indicator !== "object") return "neutral";
        const ema20 = this.toNumber(indicator?.ema20);
        const ema50 = this.toNumber(indicator?.ema50);
        if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
            if (ema20 > ema50) return "bullish";
            if (ema20 < ema50) return "bearish";
        }
        const trend = String(indicator?.trend || "").toLowerCase();
        if (trend === "bullish" || trend === "bearish") return trend;
        return "neutral";
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
        const bySymbol = summary?.bySymbol || {};
        const global = summary?.all || {};
        const symbolKey = String(symbol || "").toUpperCase();
        const symbolPeriod = bySymbol?.[symbolKey] || {};

        const todayEstimatedPnlPct = Number(period.estimatedPnlPct) || 0;
        const todayEstimatedLossPctAbs = Math.abs(Math.min(0, todayEstimatedPnlPct));
        if (this.dailyLossLimitPct > 0 && todayEstimatedLossPctAbs >= this.dailyLossLimitPct) {
            this.logGuardBlock(
                "daily_loss_limit",
                `[RiskGuard] Daily loss limit reached (${this.pctText(todayEstimatedLossPctAbs)} >= ${this.pctText(this.dailyLossLimitPct)}). Blocking new entries.`,
            );
            return { blocked: true, reason: "daily_loss_limit" };
        }

        const todayNetR = Number(period.netR) || 0;
        if (MAX_DAILY_LOSS_R > 0 && todayNetR <= -MAX_DAILY_LOSS_R) {
            this.logGuardBlock(
                "daily_loss_r_limit",
                `[RiskGuard] Daily R stop reached (${todayNetR.toFixed(2)}R <= -${MAX_DAILY_LOSS_R.toFixed(2)}R). Blocking new entries for today.`,
            );
            return { blocked: true, reason: "daily_loss_r_limit" };
        }

        const symbolDailyLosses = Number(symbolPeriod.losses) || 0;
        if (MAX_SYMBOL_LOSSES_PER_DAY > 0 && symbolDailyLosses >= MAX_SYMBOL_LOSSES_PER_DAY) {
            this.logGuardBlock(
                `symbol_daily_loss_limit:${symbolKey}`,
                `[RiskGuard] ${symbolKey} reached ${symbolDailyLosses} losses today (limit=${MAX_SYMBOL_LOSSES_PER_DAY}). Blocking symbol for the rest of the day.`,
            );
            return { blocked: true, reason: "symbol_daily_loss_limit" };
        }

        const currentLossStreak = Number(global.currentLossStreak) || 0;
        if (MAX_LOSS_STREAK > 0 && LOSS_STREAK_COOLDOWN_MINUTES > 0 && currentLossStreak >= MAX_LOSS_STREAK) {
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
                todayNetR,
                symbolDailyLosses,
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
    async processPrice({ symbol, indicators, candles = null, bid, ask, timestamp, marketTimestamp = null, sessions = [], newsBlocked = false }) {
        const upperSymbol = String(symbol || "").toUpperCase();
        const signalTimestamp = timestamp || new Date().toISOString();
        try {
            await this.syncOpenTradesFromBroker();
            const guard = await this.shouldBlockNewTrade(upperSymbol);
            logger.info(
                `[ProcessPrice] Open trades: ${this.openTrades.length}/${MAX_POSITIONS} | Balance: ${this.accountBalance}€ | AvailMargin: ${
                    Number.isFinite(this.availableMargin) ? this.availableMargin : "n/a"
                }€`,
            );

            if (this.isCryptoLiquidityWindowMomentumSymbol(upperSymbol)) {
                await this.processCryptoLiquidityWindowMomentum({
                    symbol: upperSymbol,
                    indicators,
                    candles,
                    bid,
                    ask,
                    timestamp: signalTimestamp,
                    sessions,
                    guard,
                });
                return;
            }

            const isCrypto = this.isCryptoSymbol(upperSymbol);
            const intradayState = isCrypto ? this.intradayCryptoState : this.intradayForexState;
            const intradayEngine = isCrypto ? this.intradayCryptoEngine : this.intradayForexEngine;
            const strategyMeta = this.buildIntradayStrategyMeta({
                symbol: upperSymbol,
                isCrypto,
                intradayEngine,
            });
            const decisionContext = {
                symbol: upperSymbol,
                timestamp: signalTimestamp,
                sessions: Array.isArray(sessions) ? sessions : [],
                strategyId: strategyMeta.id,
                strategyName: strategyMeta.name,
                configHash: strategyMeta.configHash,
            };

            if (this.openTrades.length >= MAX_POSITIONS) {
                logger.info(`[ProcessPrice] Max trades reached. Skipping ${upperSymbol}.`);
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "entry_gate",
                    event: "blocked",
                    blockReason: "max_positions_reached",
                    guard,
                });
                return;
            }
            if (this.isSymbolTraded(upperSymbol)) {
                logger.debug(`[ProcessPrice] ${upperSymbol} already in market.`);
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "entry_gate",
                    event: "blocked",
                    blockReason: "symbol_already_in_position",
                    guard,
                });
                return;
            }
            if (guard?.blocked) {
                logger.debug(`[ProcessPrice] Risk guard blocked ${upperSymbol}: ${guard.reason}`);
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "entry_gate",
                    event: "blocked",
                    blockReason: guard.reason || "risk_guard_blocked",
                    guard,
                });
                return;
            }
            ensureStateDay(intradayState, signalTimestamp);
            if (!(intradayState.openPositions instanceof Map)) {
                intradayState.openPositions = new Map();
            }
            intradayState.openPositions.clear();
            for (const position of this.openPositionsBroker) {
                const symbolKey = String(position?.symbol || "").toUpperCase();
                if (!symbolKey) continue;
                const direction = String(position?.direction || "").toUpperCase();
                intradayState.openPositions.set(symbolKey, {
                    symbol: symbolKey,
                    side: direction === "SELL" ? "SHORT" : "LONG",
                    entryPrice: this.toNumber(position?.entryPrice),
                    currentSl: this.toNumber(position?.stopLoss),
                    initialSl: this.toNumber(position?.stopLoss),
                    takeProfit: this.toNumber(position?.takeProfit),
                    size: this.toNumber(position?.size),
                    entryTimestamp: signalTimestamp,
                    assetClass: this.isCryptoSymbol(symbolKey) ? "crypto" : "forex",
                });
            }

            const bidNum = this.toNumber(bid);
            const askNum = this.toNumber(ask);
            const midNum = this.getMidPrice(bidNum, askNum);
            const spread = Number.isFinite(bidNum) && Number.isFinite(askNum) ? Math.abs(askNum - bidNum) : null;
            const toClosedBar = (arr, backFromEnd) => {
                if (!Array.isArray(arr) || arr.length <= backFromEnd) return null;
                return normalizeBar(arr[arr.length - 1 - backFromEnd]);
            };
            const toLatestBar = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return null;
                return normalizeBar(arr[arr.length - 1]);
            };
            const snapshot = {
                symbol: upperSymbol,
                timestamp: signalTimestamp,
                marketTimestamp: this.toIsoTimestamp(marketTimestamp),
                bid: bidNum,
                ask: askNum,
                mid: midNum,
                spread,
                price: midNum,
                sessions: Array.isArray(sessions) ? sessions : [],
                indicators: indicators || {},
                bars: {
                    h1: toClosedBar(candles?.h1Candles, 1),
                    m15: toClosedBar(candles?.m15Candles, 1),
                    m5: toClosedBar(candles?.m5Candles, 1),
                    m1: toClosedBar(candles?.m1Candles, 1),
                },
                candles: {
                    h1: toClosedBar(candles?.h1Candles, 1),
                    m15: toClosedBar(candles?.m15Candles, 1),
                    m5: toClosedBar(candles?.m5Candles, 1),
                    m1: toClosedBar(candles?.m1Candles, 1),
                },
                latestBars: {
                    h1: toLatestBar(candles?.h1Candles),
                    m15: toLatestBar(candles?.m15Candles),
                    m5: toLatestBar(candles?.m5Candles),
                    m1: toLatestBar(candles?.m1Candles),
                },
                prevBars: {
                    m15: toClosedBar(candles?.m15Candles, 2),
                    m5: toClosedBar(candles?.m5Candles, 2),
                },
                prev2Bars: {
                    m5: toClosedBar(candles?.m5Candles, 3),
                },
                equity: Number.isFinite(this.accountBalance) ? this.accountBalance : null,
                newsBlocked: Boolean(newsBlocked),
            };

            const snapshotValidation = this.validateIntradaySnapshot({
                symbol: upperSymbol,
                snapshot,
                isCrypto,
            });
            if (!snapshotValidation.ok) {
                const reason = `snapshot_invalid:${snapshotValidation.issues.join("|")}`;
                logger.warn(`[ProcessPrice] ${upperSymbol} blocked: ${reason}`);
                logger.debug(`[SnapshotDiag] ${upperSymbol} | ${this.buildSnapshotValidationDiagnostic(snapshot, snapshotValidation)}`);
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "entry_gate",
                    event: "blocked",
                    blockReason: "snapshot_invalid",
                    reason,
                    snapshot,
                    metadata: {
                        issues: snapshotValidation.issues,
                        snapshotValidation: snapshotValidation.details,
                    },
                });
                return;
            }

            const decision = intradayEngine.evaluateSnapshot({ snapshot, state: intradayState });
            const orderPlan = decision?.step5?.orderPlan || null;
            const signal = decision?.step5?.valid && orderPlan ? this.toTradeSignalFromStrategySide(orderPlan.side) : null;
            const reasonParts = Array.isArray(decision?.reasons) ? decision.reasons : [];
            const reason = reasonParts.length ? reasonParts.join("|") : "intraday_no_reason";

            this.safeLogStrategyDecision({
                ...decisionContext,
                phase: "evaluate",
                event: "decision",
                signal,
                side: orderPlan?.side || null,
                reason,
                guard,
                snapshot,
                decision: {
                    step1: decision?.step1 || null,
                    step2: decision?.step2 || null,
                    step3: decision?.step3 || null,
                    step4: decision?.step4 || null,
                    guardrails: decision?.guardrails || null,
                    step5: decision?.step5 || null,
                    reasons: decision?.reasons || [],
                    minuteSnapshotRecord: decision?.minuteSnapshotRecord || null,
                },
            });

            if (!signal || !orderPlan) {
                const blocker = this.determineIntradayBlocker(decision);
                if (this.shouldEmitNoSignalLog(upperSymbol, decision, blocker)) {
                    const diagnosticLines = this.buildIntradayDecisionDiagnosticLines(upperSymbol, decision);
                    logger.debug(
                        `[Signal] ${upperSymbol}: no intraday signal | blocker=${blocker} | session=${decision?.step1?.activeSession || "-"} | regime=${decision?.step2?.regimeType || "-"} | adx=${this.formatDiagnosticNumber(decision?.step2?.logFields?.h1Adx, 2)} | setup=${decision?.step3?.setupType || "-"} | trigger=${this.formatDiagnosticBoolean(decision?.step4?.triggerOk)}`,
                    );
                    if (!logger.isDashboardEnabled?.()) {
                        for (const line of diagnosticLines) {
                            logger.debug(line);
                        }
                    }
                }
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "evaluate",
                    event: "no_signal",
                    reason,
                    signal: null,
                    side: null,
                    snapshot,
                    decision: {
                        step1: decision?.step1 || null,
                        step2: decision?.step2 || null,
                        step3: decision?.step3 || null,
                        step4: decision?.step4 || null,
                        reasons: decision?.reasons || [],
                        guardrails: decision?.guardrails || null,
                        step5: decision?.step5 || null,
                    },
                    metadata: {
                        blocker,
                        diagnostics: diagnosticLines,
                    },
                });
                return;
            }
            // Re-check just placing
            if (this.openTrades.length >= MAX_POSITIONS) {
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "execution_gate",
                    event: "blocked",
                    blockReason: "max_positions_reached",
                    signal,
                    side: orderPlan.side,
                    reason,
                    orderPlan,
                    guard,
                });
                return;
            }
            if (this.isSymbolTraded(upperSymbol)) {
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "execution_gate",
                    event: "blocked",
                    blockReason: "symbol_already_in_position",
                    signal,
                    side: orderPlan.side,
                    reason,
                    orderPlan,
                    guard,
                });
                return;
            }
            const guardRecheck = await this.shouldBlockNewTrade(upperSymbol);
            if (guardRecheck?.blocked) {
                this.safeLogStrategyDecision({
                    ...decisionContext,
                    phase: "execution_gate",
                    event: "blocked",
                    blockReason: guardRecheck.reason || "risk_guard_blocked",
                    signal,
                    side: orderPlan.side,
                    reason,
                    orderPlan,
                    guard: guardRecheck,
                });
                return;
            }

            logger.info(`[Signal] ${upperSymbol}: ${signal} (${decision?.step2?.regimeType || "UNKNOWN"} / ${decision?.step3?.setupType || "NONE"})`);
            this.safeLogStrategyDecision({
                ...decisionContext,
                phase: "execution",
                event: "order_attempt",
                signal,
                side: orderPlan.side,
                reason,
                snapshot,
                orderPlan,
                decision: {
                    regimeType: decision?.step2?.regimeType || null,
                    setupType: decision?.step3?.setupType || null,
                    reasons: decision?.reasons || [],
                },
                guard: guardRecheck,
            });
            const execution = await this.executeTradePlanned({
                symbol: upperSymbol,
                signal,
                orderPlan,
                indicators,
                reason,
                strategyMeta,
            });

            this.safeLogStrategyDecision({
                ...decisionContext,
                phase: "execution",
                event: "order_result",
                signal,
                side: orderPlan.side,
                reason: execution?.accepted ? "accepted" : execution?.reason || "rejected",
                snapshot,
                orderPlan,
                execution,
                metadata: {
                    regimeType: decision?.step2?.regimeType || null,
                    setupType: decision?.step3?.setupType || null,
                },
            });

            if (execution?.accepted) {
                registerOpenedTrade(intradayState, {
                    symbol: upperSymbol,
                    side: orderPlan.side,
                    entryPrice: this.firstNumber(execution?.filledPrice, orderPlan.entryPrice),
                    currentSl: this.firstNumber(execution?.sl, orderPlan.sl),
                    initialSl: this.firstNumber(execution?.sl, orderPlan.sl),
                    takeProfit: this.firstNumber(execution?.tp, orderPlan.tp),
                    size: this.firstNumber(execution?.size, orderPlan.size),
                    entryTimestamp: signalTimestamp,
                    assetClass: isCrypto ? "crypto" : "forex",
                });
            }
        } catch (error) {
            logger.error("[ProcessPrice] Error:", error);
            this.safeLogStrategyDecision({
                symbol: upperSymbol,
                timestamp: signalTimestamp,
                phase: "error",
                event: "exception",
                reason: error?.message || "process_price_error",
            });
        }
    }

    toTradeSignalFromStrategySide(side) {
        const s = String(side || "").toUpperCase();
        if (s === "LONG") return "BUY";
        if (s === "SHORT") return "SELL";
        return null;
    }

    getOpenBrokerPositionBySymbol(symbol) {
        const upper = String(symbol || "").toUpperCase();
        return this.openPositionsBroker.find((pos) => String(pos?.symbol || "").toUpperCase() === upper) || null;
    }

    getOpenLogEntryForDeal(dealId, symbol, preloadedEntries = null) {
        if (!dealId) return null;
        const targetId = String(dealId);
        if (Array.isArray(preloadedEntries)) {
            const hit = preloadedEntries.find((row) => String(row?.dealId || "") === targetId);
            if (hit) return hit;
        }
        const { entry } = getTradeEntry(dealId, symbol);
        return entry || null;
    }

    buildCryptoLwmOpenPositionEvalContext(brokerPosition, symbol, symbolLogEntries = []) {
        if (!brokerPosition) return null;
        const logEntry = this.getOpenLogEntryForDeal(brokerPosition.dealId, symbol, symbolLogEntries);
        return {
            dealId: brokerPosition.dealId,
            symbol,
            direction: brokerPosition.direction,
            side: brokerPosition.direction,
            size: brokerPosition.size,
            entryPrice: brokerPosition.entryPrice,
            stopLoss: brokerPosition.stopLoss,
            takeProfit: brokerPosition.takeProfit,
            currentSl: brokerPosition.stopLoss,
            initialSl: this.firstNumber(logEntry?.stopLoss, logEntry?.riskMeta?.initialStopLoss, brokerPosition.stopLoss),
            entryTimestamp: logEntry?.openedAt ?? logEntry?.timestamp ?? null,
            strategyId: logEntry?.strategyId ?? logEntry?.strategyMeta?.id ?? logEntry?.riskMeta?.strategyId ?? null,
            logEntry,
        };
    }

    async processCryptoLiquidityWindowMomentum({ symbol, candles, bid, ask, timestamp, guard }) {
        const signalTimestamp = timestamp || new Date().toISOString();
        const upperSymbol = String(symbol || "").toUpperCase();
        const strategyMeta = {
            id: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
            name: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
            configHash: this.cryptoLwmConfigHash,
        };
        const openBrokerPosition = this.getOpenBrokerPositionBySymbol(upperSymbol);
        const isSymbolOpen = Boolean(openBrokerPosition);
        const maxPositionsReached = this.openTrades.length >= MAX_POSITIONS;

        const symbolCounters = this.getCryptoLwmSymbolCounters(upperSymbol, signalTimestamp);
        const daySummary = this.getCryptoLwmDaySummary(signalTimestamp);
        const openPositionCtx = this.buildCryptoLwmOpenPositionEvalContext(openBrokerPosition, upperSymbol, symbolCounters.entries);
        const openPositionIsStrategyOwned = !openPositionCtx ? false : this.isCryptoLwmLogEntry(openPositionCtx.logEntry);

        const m5CandlesRaw = this.getClosedBarsForStrategy(candles?.m5Candles || []);
        const h1CandlesRaw = this.getClosedBarsForStrategy(candles?.h1Candles || []);
        const lastClosedM5Raw = Array.isArray(candles?.m5Candles) && candles.m5Candles.length > 1 ? candles.m5Candles[candles.m5Candles.length - 2] : null;
        const lastClosedM5Key = this.getClosedBarKeyFromCandle(lastClosedM5Raw);
        const lastSeenM5Key = this.cryptoLwmLastClosedM5KeyBySymbol.get(upperSymbol) || null;
        const isNewClosedBar = Boolean(lastClosedM5Key) && lastClosedM5Key !== lastSeenM5Key;

        const externalEntryAllowed = !isSymbolOpen && !maxPositionsReached && !guard?.blocked;
        const externalBlockReason = isSymbolOpen
            ? "symbol_already_in_position"
            : maxPositionsReached
              ? "max_positions_reached"
              : guard?.blocked
                ? `risk_guard_${guard.reason}`
                : null;

        const evaluation = evaluateCryptoLiquidityWindowMomentum({
            symbol: upperSymbol,
            timestamp: signalTimestamp,
            bid,
            ask,
            mid: this.resolveMarketPrice("BUY", bid, ask),
            candles5m: m5CandlesRaw,
            candles1h: h1CandlesRaw,
            config: CRYPTO_LWM_CONFIG,
            equity: this.toNumber(this.accountBalance),
            openPosition: openPositionIsStrategyOwned ? openPositionCtx : null,
            counters: {
                tradesTodaySymbol: symbolCounters.tradesTodaySymbol,
                tradesTodayTotal: daySummary.tradesTodayTotal,
                lastExitAtMs: symbolCounters.lastExitAtMs,
                startOfDayEquity: daySummary.startOfDayEquity,
                realizedPnlToday: daySummary.realizedPnlToday,
            },
            entryContext: {
                requireNewClosedBar: true,
                isNewClosedBar,
                externalEntryAllowed,
                externalBlockReason,
            },
        });

        if (lastClosedM5Key) {
            this.cryptoLwmLastClosedM5KeyBySymbol.set(upperSymbol, lastClosedM5Key);
        }

        this.logCryptoLwmDecision({
            mode: "live",
            symbol: upperSymbol,
            guardBlocked: Boolean(guard?.blocked),
            guardReason: guard?.reason || null,
            maxPositionsReached,
            symbolOpen: isSymbolOpen,
            positionOwnedByStrategy: openPositionIsStrategyOwned,
            reasonCode: evaluation?.reasonCode || null,
            ...evaluation?.decisionLog,
        });
        this.safeLogStrategyDecision({
            symbol: upperSymbol,
            timestamp: signalTimestamp,
            phase: "evaluate",
            event: "decision",
            strategyId: strategyMeta.id,
            strategyName: strategyMeta.name,
            configHash: strategyMeta.configHash,
            signal: evaluation?.action === "OPEN" ? this.toTradeSignalFromStrategySide(evaluation?.orderPlan?.side) : null,
            side: evaluation?.orderPlan?.side || null,
            blockReason: externalBlockReason,
            reason: evaluation?.reasonCode || null,
            guard,
            snapshot: {
                symbol: upperSymbol,
                timestamp: signalTimestamp,
                bid: this.toNumber(bid),
                ask: this.toNumber(ask),
                mid: this.resolveMarketPrice("BUY", bid, ask),
                sessions: [],
            },
            decision: {
                action: evaluation?.action || null,
                reasonCode: evaluation?.reasonCode || null,
                decisionLog: evaluation?.decisionLog || null,
                manageAction: evaluation?.manageAction || null,
            },
            metadata: {
                externalEntryAllowed,
                externalBlockReason,
                isNewClosedBar,
                symbolOpen: isSymbolOpen,
                maxPositionsReached,
            },
        });

        if (isSymbolOpen && !openPositionIsStrategyOwned) {
            logger.debug(`[CryptoLWM] ${upperSymbol}: open position is not tagged with ${CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID}; skipping custom management.`);
            return;
        }

        if (evaluation?.action === "EXIT" && openPositionCtx?.dealId) {
            const rAtExit = this.toNumber(evaluation?.metrics?.rMultipleAtExit);
            this.logCryptoLwmDecision({
                mode: "live",
                symbol: upperSymbol,
                timestamp: signalTimestamp,
                decision: "EXIT",
                orderType: "CLOSE_POSITION",
                requestedPrice: this.toNumber(evaluation?.metrics?.currentMark),
                filledPrice: null,
                sl: this.toNumber(openPositionCtx?.currentSl),
                tp: this.toNumber(openPositionCtx?.takeProfit),
                size: this.toNumber(openPositionCtx?.size),
                riskAmount: this.toNumber(openPositionCtx?.logEntry?.riskMeta?.riskAmount),
                stopDistance: this.toNumber(openPositionCtx?.logEntry?.riskMeta?.stopDistance),
                RmultipleAtExit: rAtExit,
                exitReason: evaluation.exitReason || "manage_exit",
            });
            await this.closePosition(openPositionCtx.dealId, evaluation.exitReason || "time_stop");
            return;
        }

        if (evaluation?.action === "MANAGE" && evaluation?.manageAction?.type === "MOVE_SL" && openPositionCtx?.dealId) {
            const newSl = this.roundPrice(evaluation.manageAction.newStopLoss, upperSymbol);
            const tp = this.toNumber(openPositionCtx.takeProfit);
            const currentSl = this.toNumber(openPositionCtx.currentSl);
            const improved =
                !Number.isFinite(currentSl) ||
                (String(openPositionCtx.direction || "").toUpperCase() === "BUY" ? newSl > currentSl : newSl < currentSl);
            if (improved && Number.isFinite(newSl)) {
                try {
                    await updatePositionProtection(openPositionCtx.dealId, newSl, tp, upperSymbol);
                    logTradeTrailingStop({
                        dealId: openPositionCtx.dealId,
                        symbol: upperSymbol,
                        price: newSl,
                        distance: this.toNumber(evaluation?.metrics?.atr14),
                        reason: evaluation.manageAction.reason || "manage",
                        timestamp: signalTimestamp,
                    });
                    this.logCryptoLwmDecision({
                        mode: "live",
                        symbol: upperSymbol,
                        timestamp: signalTimestamp,
                        decision: "MANAGE",
                        orderType: "UPDATE_PROTECTION",
                        requestedPrice: null,
                        filledPrice: null,
                        sl: newSl,
                        tp,
                        size: this.toNumber(openPositionCtx.size),
                        riskAmount: this.toNumber(openPositionCtx?.logEntry?.riskMeta?.riskAmount),
                        stopDistance: this.toNumber(openPositionCtx?.logEntry?.riskMeta?.stopDistance),
                    });
                } catch (error) {
                    logger.warn(`[CryptoLWM] Failed protection update for ${upperSymbol} ${openPositionCtx.dealId}: ${error.message}`);
                }
            }
            return;
        }

        if (evaluation?.action !== "OPEN" || !evaluation?.orderPlan) {
            return;
        }

        const tradeSignal = this.toTradeSignalFromStrategySide(evaluation.orderPlan.side);
        if (!tradeSignal) {
            logger.warn(`[CryptoLWM] Invalid strategy side for ${upperSymbol}: ${evaluation.orderPlan.side}`);
            return;
        }

        this.safeLogStrategyDecision({
            symbol: upperSymbol,
            timestamp: signalTimestamp,
            phase: "execution",
            event: "order_attempt",
            strategyId: strategyMeta.id,
            strategyName: strategyMeta.name,
            configHash: strategyMeta.configHash,
            signal: tradeSignal,
            side: evaluation?.orderPlan?.side || null,
            reason: evaluation.reasonCode || "strategy_signal",
            orderPlan: evaluation?.orderPlan || null,
            guard,
        });

        const execution = await this.executeTradePlanned({
            symbol: upperSymbol,
            signal: tradeSignal,
            orderPlan: evaluation.orderPlan,
            indicators: { strategy: evaluation?.decisionLog?.indicators || null },
            reason: evaluation.reasonCode || "strategy_signal",
            strategyMeta,
        });
        this.safeLogStrategyDecision({
            symbol: upperSymbol,
            timestamp: signalTimestamp,
            phase: "execution",
            event: "order_result",
            strategyId: strategyMeta.id,
            strategyName: strategyMeta.name,
            configHash: strategyMeta.configHash,
            signal: tradeSignal,
            side: evaluation?.orderPlan?.side || null,
            reason: execution?.accepted ? "accepted" : execution?.reason || "rejected",
            orderPlan: evaluation?.orderPlan || null,
            execution,
            guard,
        });

        this.logCryptoLwmDecision({
            mode: "live",
            symbol: upperSymbol,
            timestamp: signalTimestamp,
            decision: tradeSignal === "BUY" ? "OPEN_LONG" : "OPEN_SHORT",
            orderType: "MARKET",
            requestedPrice: this.toNumber(evaluation.orderPlan.requestedPrice),
            filledPrice: this.toNumber(execution?.filledPrice),
            sl: this.toNumber(execution?.sl ?? evaluation.orderPlan.sl),
            tp: this.toNumber(execution?.tp ?? evaluation.orderPlan.tp),
            size: this.toNumber(execution?.size ?? evaluation.orderPlan.size),
            riskAmount: this.toNumber(execution?.riskAmount ?? evaluation.orderPlan.riskAmount),
            stopDistance: this.toNumber(execution?.stopDistance ?? evaluation.orderPlan.stopDistance),
            dealId: execution?.dealId || null,
            orderAccepted: Boolean(execution?.accepted),
        });
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

    async executeTradePlanned({ symbol, signal, orderPlan, indicators, reason = "", strategyMeta = null }) {
        try {
            const originalPlannedSize = this.toNumber(orderPlan?.size);
            const {
                orderPlan: brokerAdjustedOrderPlan,
                sizingMeta,
            } = await this.adjustOrderPlanSizeForBroker({
                symbol,
                orderPlan,
            });

            const size = this.toNumber(brokerAdjustedOrderPlan?.size);
            const requestedPrice = this.toNumber(orderPlan?.requestedPrice ?? orderPlan?.entryPrice);
            const stopLossPrice = this.toNumber(orderPlan?.sl);
            const takeProfitPrice = this.toNumber(orderPlan?.tp);
            const riskPctConfigured = this.toNumber(orderPlan?.riskPct);
            const riskAmountConfigured = this.toNumber(orderPlan?.riskAmount);
            const stopDistance = this.toNumber(orderPlan?.stopDistance);
            const takeProfitDistance = this.toNumber(orderPlan?.tpDistance);
            const strategyConfigHash = strategyMeta?.configHash || null;

            if (!["BUY", "SELL"].includes(this.normalizeDirection(signal))) {
                throw new Error(`Invalid signal=${signal}`);
            }
            if (![size, stopLossPrice, takeProfitPrice].every(Number.isFinite)) {
                throw new Error(`Invalid orderPlan for ${symbol}: size/sl/tp missing`);
            }

            if (Number.isFinite(originalPlannedSize) && Math.abs(originalPlannedSize - size) > 1e-9) {
                logger.info(
                    `[Sizing] ${symbol}: adjusted size ${originalPlannedSize} -> ${size} ` +
                        `(method=${sizingMeta?.sizingMethod || "unknown"}, quoteToAccount=${this.toNumber(sizingMeta?.quoteToAccountRate) ?? "n/a"})`,
                );
            }

            const pos = await placePosition(symbol, signal, size, requestedPrice, stopLossPrice, takeProfitPrice);
            if (!pos?.dealReference) {
                logger.error(`[Order] Missing deal reference for ${symbol}`);
                return { accepted: false, reason: "missing_deal_reference", strategyId: strategyMeta?.id || null, configHash: strategyConfigHash };
            }

            const confirmation = await getDealConfirmation(pos.dealReference);
            if (!["ACCEPTED", "OPEN"].includes(confirmation.dealStatus)) {
                logger.error(`[Order] Not placed: ${confirmation.reason}`);
                return {
                    accepted: false,
                    reason: confirmation.reason || "rejected",
                    brokerReason: confirmation.reason || null,
                    dealStatus: confirmation.dealStatus || null,
                    confirmation,
                    strategyId: strategyMeta?.id || null,
                    configHash: strategyConfigHash,
                };
            }

            const confirmedSize = this.firstNumber(
                confirmation?.size,
                confirmation?.affectedDeals?.find((d) => d?.status === "OPENED")?.size,
                size,
            );

            logger.info(
                `[Order] OPENED ${symbol} ${signal} size=${confirmedSize} (submitted=${size}, plan=${originalPlannedSize}) ` +
                    `entry=${requestedPrice} SL=${stopLossPrice} TP=${takeProfitPrice}`,
            );

            const affectedDealId =
                confirmation?.affectedDeals?.find((d) => d?.status === "OPENED")?.dealId || confirmation?.affectedDeals?.[0]?.dealId || confirmation?.dealId;

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

            const entryPriceFilled = this.firstNumber(confirmation?.level, requestedPrice);
            const stopLossRounded = this.roundPrice(stopLossPrice, symbol);
            const takeProfitRounded = this.roundPrice(takeProfitPrice, symbol);
            const logTimestamp = new Date().toISOString();

            if (affectedDealId) {
                logTradeOpen({
                    dealId: affectedDealId,
                    symbol,
                    signal,
                    openReason: reason,
                    entryPrice: entryPriceFilled,
                    stopLoss: stopLossRounded,
                    takeProfit: takeProfitRounded,
                    indicatorsOnOpening: indicators,
                    timestamp: logTimestamp,
                    riskMeta: {
                        riskPct: Number.isFinite(riskPctConfigured) ? riskPctConfigured : null,
                        riskAmount: Number.isFinite(riskAmountConfigured) ? riskAmountConfigured : null,
                        stopDistance: Number.isFinite(stopDistance) ? stopDistance : null,
                        takeProfitDistance: Number.isFinite(takeProfitDistance) ? takeProfitDistance : null,
                        size: Number.isFinite(confirmedSize) ? confirmedSize : Number.isFinite(size) ? size : null,
                        sizeSubmitted: Number.isFinite(size) ? size : null,
                        sizePlanned: Number.isFinite(originalPlannedSize) ? originalPlannedSize : null,
                        accountBalanceAtOpen: Number.isFinite(this.accountBalance) ? this.accountBalance : null,
                        availableMarginAtOpen: Number.isFinite(this.availableMargin) ? this.availableMargin : null,
                        accountCurrency: this.sanitizeCurrencyCode(this.accountCurrency) || null,
                        quoteCurrency: this.sanitizeCurrencyCode(sizingMeta?.quoteCurrency) || null,
                        quoteToAccountRate: this.toNumber(sizingMeta?.quoteToAccountRate),
                        baseToAccountRate: this.toNumber(sizingMeta?.baseToAccountRate),
                        contractSize: this.toNumber(sizingMeta?.contractSize),
                        estimatedRiskAtSl: this.toNumber(sizingMeta?.estimatedRiskAtSl),
                        leverageUsed: this.toNumber(sizingMeta?.leverageUsed),
                        marginBudget: this.toNumber(sizingMeta?.marginBudget),
                        marginPerUnit: this.toNumber(sizingMeta?.marginPerUnit),
                        maxSizeByMargin: this.toNumber(sizingMeta?.maxSizeByMargin),
                        sizingMethod: sizingMeta?.sizingMethod || null,
                        assetClass: this.isCryptoSymbol(symbol) ? "crypto" : "forex",
                        strategyId: strategyMeta?.id || null,
                        strategyMeta: strategyMeta && typeof strategyMeta === "object" ? strategyMeta : null,
                        configHash: strategyConfigHash,
                    },
                    strategyId: strategyMeta?.id || null,
                    strategyMeta: strategyMeta && typeof strategyMeta === "object" ? strategyMeta : null,
                    configHash: strategyConfigHash,
                });
                tradeTracker.registerOpenDeal(affectedDealId, symbol);
            }

            this.openTrades.push(symbol);
            this.riskGuardState.refreshedAtMs = 0;

            return {
                accepted: true,
                dealId: affectedDealId || null,
                requestedPrice,
                filledPrice: entryPriceFilled,
                sl: stopLossRounded,
                tp: takeProfitRounded,
                size: confirmedSize,
                sizeSubmitted: size,
                sizePlanned: originalPlannedSize,
                riskAmount: riskAmountConfigured,
                estimatedRiskAtSl: this.toNumber(sizingMeta?.estimatedRiskAtSl),
                sizingMeta,
                stopDistance,
                confirmation,
                strategyId: strategyMeta?.id || null,
                configHash: strategyConfigHash,
            };
        } catch (error) {
            logger.error(`[Order] Error placing planned order for ${symbol}:`, error);
            return {
                accepted: false,
                reason: error?.message || "order_error",
                strategyId: strategyMeta?.id || null,
                configHash: strategyMeta?.configHash || null,
            };
        }
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
            const m5Trend = this.pickTrend(m5);
            const m15Trend = this.pickTrend(m15);

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
                const symbolKey = String(symbol || "").toUpperCase();
                if (symbolKey) {
                    registerClosedTrade(this.intradayForexState, {
                        symbol: symbolKey,
                        pnl: null,
                        tradeId: dealId,
                        timestamp: new Date().toISOString(),
                    });
                    registerClosedTrade(this.intradayCryptoState, {
                        symbol: symbolKey,
                        pnl: null,
                        tradeId: dealId,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        } catch (logErr) {
            logger.error(`[ClosePos] Failed to log closure for ${dealId}:`, logErr);
        }
    }
}

export default new TradingService();
