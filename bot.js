import { startSession, pingSession, getHistorical, getAccountInfo, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { DEV, PROD, ANALYSIS, SESSIONS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import Strategy from "./strategies/strategies.js";
import { calcIndicators } from "./indicators/indicators.js";
import { priceLogger } from "./utils/priceLogger.js";
import logger from "./utils/logger.js";
import { isNewsTime } from "./utils/newsChecker.js";
import { startMonitorOpenTrades, trailingStopCheck, maxHoldCheck, logDeals } from "./bot/monitors.js";

const { TIMEFRAMES } = ANALYSIS;
const ANALYSIS_REPEAT_MS = 5 * 60 * 1000;
const ENTRY_CHECK_REPEAT_MS = 60 * 1000;
const M15_SETUP_TTL_MS = 15 * 60 * 1000;
const MONITOR_INTERVAL_MS = 60 * 1000;
const SYMBOL_ANALYSIS_DELAY_MS = 2000;
const TIMEFRAME_MINUTES = {
    D1: 24 * 60,
    H4: 4 * 60,
    H1: 60,
    M15: 15,
    M5: 5,
    M1: 1,
};
const DEFAULT_TRADING_WINDOWS = [
    // London: 08:15–16:45
    { start: 8 * 60 + 15, end: 16 * 60 + 45 },
    // NY: 13:15–20:45
    { start: 13 * 60 + 15, end: 20 * 60 + 45 },
    // Sydney: 22:15–6:45 (overnight, so split into two ranges)
    { start: 22 * 60 + 15, end: 23 * 60 + 59 },
    { start: 0, end: 6 * 60 + 45 },
    // Tokyo: 0:15–8:45
    { start: 0 * 60 + 15, end: 8 * 60 + 45 },
];

class TradingBot {
    constructor() {
        this.isRunning = false;
        this.analysisInterval = null;
        this.sessionRefreshInterval = null;
        this.pingInterval = 9 * 60 * 1000;
        this.checkInterval = 15 * 1000;
        this.maxRetries = 3;
        this.retryDelay = 30000; // 30 seconds
        this.latestCandles = {}; // Store latest candles for each symbol
        this.candleHistory = {}; // symbol -> array of candles
        this.monitorInterval = null; // Add monitor interval for open trades
        this.monitorInProgress = false; // Prevent overlapping monitor runs
        this.priceMonitorInterval = null;
        this.priceMonitorInProgress = false;
        this.entryTriggerInterval = null;
        this.entryTriggerInProgress = false;
        this.dealIdMonitorInterval = null; // Interval handle for dealId monitor
        this.dealIdMonitorInProgress = false; // Prevent overlapping dealId checks
        this.maxCandleHistory = 200; // Rolling window size for indicators
        this.openedPositions = {}; // Track opened positions

        this.openedBrockerDealIds = [];
        this.activeSymbols = this.getActiveSymbols();
        this.positionGuard = null;
        this.activeM15Setups = new Map();
        this.lastProcessedM15Candle = new Map();

        this.allowedTradingWindows = DEFAULT_TRADING_WINDOWS;
    }

    async initialize() {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await startSession();
                const tokens = getSessionTokens();
                if (!tokens.cst || !tokens.xsecurity) throw new Error("Invalid session tokens");
                await this.startLiveTrading(tokens);
                this.scheduleMidnightSessionRefresh();
                return;
            } catch (error) {
                logger.error(`[Bot] Initialization attempt ${attempt} failed:`, error);
                if (attempt < this.maxRetries) {
                    logger.info(`[Bot] Retrying in ${this.retryDelay / 1000}s...`);
                    await this.delay(this.retryDelay);
                    await refreshSession();
                } else {
                    logger.error("[Bot] Max retry attempts reached. Shutting down.");
                    process.exit(1);
                }
            }
        }
    }

    async startLiveTrading(tokens) {
        try {
            // this.setupWebSocket(tokens);
            this.startSessionPing();
            this.startAnalysisInterval();
            this.startEntryTriggerInterval();
            this.startMonitorOpenTrades();
            this.startPriceMonitor();
            this.isRunning = true;
        } catch (error) {
            logger.error("[bot.js][Bot] Error starting live trading:", error);
            throw error;
        }
    }

    // WebSocket connection is just for  5, 1 minute candles
    // setupWebSocket(tokens) {
    //     try {
    //         const activeSymbols = this.getActiveSymbols();
    //         // Initialize price tracker for all active symbols
    //         this.latestPrices = {};
    //         activeSymbols.forEach((symbol) => {
    //             this.latestPrices[symbol] = { analyzeSymbol: null, ask: null, ts: null };
    //         });

    //         webSocketService.connect(tokens, activeSymbols, (data) => {
    //             const msg = JSON.parse(data.toString());
    //             const { payload } = msg;
    //             const epic = payload?.epic;
    //             if (!epic) return;

    //             this.latestCandles[epic] = { latest: payload };

    //             // Update bid or ask based on priceType
    //             if (!this.latestPrices[epic]) {
    //                 this.latestPrices[epic] = { bid: null, ask: null, ts: null };
    //             }

    //             if (payload.priceType === "bid") {
    //                 this.latestPrices[epic].bid = payload.c;
    //             } else if (payload.priceType === "ask") {
    //                 this.latestPrices[epic].ask = payload.c;
    //             }

    //             this.latestPrices[epic].ts = Date.now();

    //             // Only log when we have both bid and ask
    //             if (this.latestPrices[epic].bid !== null && this.latestPrices[epic].ask !== null) {
    //                 logger.debug(`[WebSocket] ${epic} - bid: ${this.latestPrices[epic].bid}, ask: ${this.latestPrices[epic].ask}`);
    //             }
    //         });
    //     } catch (error) {
    //         logger.error("[bot.js] WebSocket message processing error:", error.message);
    //     }
    // }

    startSessionPing() {
        this.sessionPingInterval = setInterval(async () => {
            try {
                await pingSession();
                logger.info("Session pinged successfully");
            } catch (error) {
                logger.error("[bot.js] Session ping failed:", error.message);
            }
        }, this.pingInterval);
    }

    // Starts the periodic analysis interval for scheduled trading logic.
    async startAnalysisInterval() {
        const runAnalysis = async () => {
            try {
                await this.updateAccountInfo();
                await this.analyzeAllSymbols();
                await this.startMonitorOpenTrades();
            } catch (error) {
                logger.error("[bot.js] Analysis interval error:", error);
            }
        };

        // First run: align to next 5th minute + 5 seconds
        const interval = this.getInitialIntervalMs();
        logger.info(`[${DEV.MODE ? "DEV" : "PROD"}] Setting up analysis interval: ${interval}ms`);

        setTimeout(() => {
            runAnalysis();
            // After first run, repeat every 5 minutes
            this.analysisInterval = setInterval(runAnalysis, this.getRepeatIntervalMs());
        }, interval);
    }

    startEntryTriggerInterval() {
        const interval = this.getEntryInitialIntervalMs();
        logger.info(`[EntryTrigger] Starting (every ${this.getEntryRepeatIntervalMs()}ms) after ${interval}ms`);
        if (this.entryTriggerInterval) clearInterval(this.entryTriggerInterval);

        const run = async () => {
            if (this.entryTriggerInProgress) {
                logger.warn("[EntryTrigger] Previous tick still running; skipping.");
                return;
            }
            this.entryTriggerInProgress = true;
            try {
                await this.triggerEntriesFromActiveSetups();
            } catch (error) {
                logger.error("[EntryTrigger] Error:", error);
            } finally {
                this.entryTriggerInProgress = false;
            }
        };

        setTimeout(() => {
            run();
            this.entryTriggerInterval = setInterval(run, this.getEntryRepeatIntervalMs());
        }, interval);
    }

    // Updates account balance, margin, and open trades in the trading service.
    async updateAccountInfo() {
        let retries = 3;
        while (retries > 0) {
            try {
                const accountData = await getAccountInfo();
                if (accountData?.accounts?.[0]?.balance?.balance) {
                    tradingService.setAccountBalance(accountData.accounts[0].balance.balance);
                    if (typeof accountData.accounts[0].balance.available !== "undefined") {
                        tradingService.setAvailableMargin(accountData.accounts[0].balance.available);
                    }

                    return; // Success - exit the method
                }
            } catch (error) {
                retries--;
                if (retries === 0) {
                    logger.error("[bot.js] Failed to update account info after all retries:", error);
                    // Don't throw - just continue with old values
                    return;
                }
                logger.warn(`Account info update failed, retrying... (${retries} attempts left)`);
                await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
        }
    }

    getActiveSymbols() {
        // SESSIONS in config.js are defined in UTC (see config.js), so we must evaluate in UTC as well.
        const now = new Date();
        const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

        const parseMinutes = (hhmm) => {
            if (typeof hhmm !== "string") return NaN;
            const [hh, mm] = hhmm.split(":").map((p) => Number(p));
            if (!Number.isInteger(hh) || !Number.isInteger(mm)) return NaN;
            return hh * 60 + mm;
        };

        const inSession = (startMinutes, endMinutes) => {
            if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
            if (startMinutes < endMinutes) return currentMinutes >= startMinutes && currentMinutes < endMinutes;
            return currentMinutes >= startMinutes || currentMinutes < endMinutes; // Overnight session
        };

        const activeSessions = [];
        const activeSessionNames = [];

        for (const [name, session] of Object.entries(SESSIONS)) {
            const startMinutes = parseMinutes(session?.START);
            const endMinutes = parseMinutes(session?.END);
            if (!inSession(startMinutes, endMinutes)) continue;

            activeSessions.push(session.SYMBOLS);
            activeSessionNames.push(name);
        }

        // Combine symbols from all active sessions, remove duplicates
        const combinedSet = new Set();
        activeSessions.forEach((arr) => (arr || []).forEach((symbol) => combinedSet.add(symbol)));
        const combined = [...combinedSet];

        logger.info(
            `[Bot] Active sessions (UTC): ${activeSessions.length} (${activeSessionNames.length ? activeSessionNames.join(", ") : "none"}), Trading symbols: ${combined.join(", ")}`,
        );
        return combined;
    }

    // Build M15 setup (higher-timeframe signal) only on new closed M15 candles.
    async analyzeAllSymbols() {
        this.activeSymbols = this.getActiveSymbols();
        for (const symbol of this.activeSymbols) {
            if (!(await this.isTradingAllowed(symbol))) {
                logger.info("[Bot] Skipping setup analysis: Trading not allowed at this time.");
                continue;
            }
            await this.refreshM15Setup(symbol);
            await this.delay(SYMBOL_ANALYSIS_DELAY_MS);
        }
    }

    async triggerEntriesFromActiveSetups() {
        if (!this.activeM15Setups.size) return;

        for (const [symbol, setup] of this.activeM15Setups.entries()) {
            if (!(await this.isTradingAllowed(symbol))) continue;

            if (Number.isFinite(setup?.expiresAtMs) && Date.now() > setup.expiresAtMs) {
                logger.info(`[EntryTrigger] ${symbol}: setup expired (${setup.setupKey}).`);
                this.activeM15Setups.delete(symbol);
                continue;
            }

            await this.tryTriggerEntry(symbol, setup);
            await this.delay(300);
        }
    }

    async tryTriggerEntry(symbol, setup) {
        const { m5Data, m1Data } = await this.fetchEntryCandles(symbol, TIMEFRAMES, this.maxCandleHistory);
        if (!m5Data?.prices || !m1Data?.prices) {
            logger.warn(`[EntryTrigger] Missing M5/M1 candles for ${symbol}, skipping.`);
            return;
        }

        const m5Candles = this.getClosedCandles(m5Data.prices, TIMEFRAME_MINUTES.M5);
        const m1Candles = this.getClosedCandles(m1Data.prices, TIMEFRAME_MINUTES.M1);
        if (!m5Candles.length || !m1Candles.length) {
            logger.warn(`[EntryTrigger] No closed M5/M1 candles for ${symbol}, skipping.`);
            return;
        }

        const [m5, m1] = await Promise.all([calcIndicators(m5Candles, symbol, TIMEFRAMES.M5), calcIndicators(m1Candles, symbol, TIMEFRAMES.M1)]);
        if (!m5 || !m1) {
            logger.warn(`[EntryTrigger] Indicator build failed for ${symbol}, skipping.`);
            return;
        }

        const indicators = {
            ...setup.higherIndicators,
            m5,
            m1,
        };

        const { bid, ask } = await this.getBidAsk(symbol);
        if (!this.isValidPricePair(bid, ask)) {
            logger.warn(`[EntryTrigger] Skipping ${symbol}: invalid bid/ask (bid=${bid}, ask=${ask})`);
            return;
        }

        const result = await tradingService.processPrice({
            symbol,
            indicators,
            candles: { m5Candles, m1Candles },
            bid,
            ask,
            directionFilter: setup.direction,
        });

        if (!result) return;

        if (result.signal) {
            logger.info(`[EntryTrigger] ${symbol}: consumed setup ${setup.setupKey} with signal ${result.signal} (${result.reason || "signal"}).`);
            this.activeM15Setups.delete(symbol);
            return;
        }

        if (result.reason === "symbol_already_traded") {
            this.activeM15Setups.delete(symbol);
        }
    }

    async fetchAllCandles(symbol, timeframes, historyLength) {
        try {
            const [d1Data, h4Data, h1Data, m15Data, m5Data, m1Data] = await Promise.all([
                getHistorical(symbol, timeframes.D1, historyLength),
                getHistorical(symbol, timeframes.H4, historyLength),
                getHistorical(symbol, timeframes.H1, historyLength),
                getHistorical(symbol, timeframes.M15, historyLength),
                getHistorical(symbol, timeframes.M5, historyLength),
                getHistorical(symbol, timeframes.M1, historyLength),
            ]);
            console.log(`Fetched candles: ${timeframes.D1}, ${timeframes.H4}, ${timeframes.H1}, ${timeframes.M15}, ${timeframes.M5}, ${timeframes.M1}`);
            return { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data };
        } catch (error) {
            logger.error(`[CandleFetch] Error fetching candles for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async fetchEntryCandles(symbol, timeframes, historyLength) {
        try {
            const [m5Data, m1Data] = await Promise.all([
                getHistorical(symbol, timeframes.M5, historyLength),
                getHistorical(symbol, timeframes.M1, historyLength),
            ]);
            return { m5Data, m1Data };
        } catch (error) {
            logger.error(`[CandleFetch] Error fetching entry candles for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async refreshM15Setup(symbol) {
        logger.info(`\n\n=== Setup Scan ${symbol} ===`);

        const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.maxCandleHistory);

        if (!d1Data?.prices || !h4Data?.prices || !h1Data?.prices || !m15Data?.prices || !m5Data?.prices || !m1Data?.prices) {
            logger.warn(`[Setup] Missing candle data for ${symbol}, skipping setup scan.`);
            return;
        }

        this.storeCandleHistory(symbol, { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data });
        const { d1Candles, h4Candles, h1Candles, m15Candles } = this.getCandleHistory(symbol);

        const d1Closed = this.getClosedCandles(d1Candles, TIMEFRAME_MINUTES.D1);
        const h4Closed = this.getClosedCandles(h4Candles, TIMEFRAME_MINUTES.H4);
        const h1Closed = this.getClosedCandles(h1Candles, TIMEFRAME_MINUTES.H1);
        const m15Closed = this.getClosedCandles(m15Candles, TIMEFRAME_MINUTES.M15);

        if (!d1Closed.length || !h4Closed.length || !h1Closed.length || !m15Closed.length) {
            logger.warn(`[Setup] Missing closed candles for ${symbol}, skipping setup scan.`);
            return;
        }

        const lastClosedM15 = m15Closed[m15Closed.length - 1];
        const setupKey = this.buildCandleKey(symbol, lastClosedM15);
        if (!setupKey) {
            logger.warn(`[Setup] Could not build setup key for ${symbol}, skipping.`);
            return;
        }

        const lastProcessed = this.lastProcessedM15Candle.get(symbol);
        if (lastProcessed === setupKey) {
            logger.debug(`[Setup] ${symbol}: candle already processed (${setupKey}).`);
            return;
        }

        this.lastProcessedM15Candle.set(symbol, setupKey);

        const [d1, h4, h1, m15] = await Promise.all([
            calcIndicators(d1Closed, symbol, TIMEFRAMES.D1),
            calcIndicators(h4Closed, symbol, TIMEFRAMES.H4),
            calcIndicators(h1Closed, symbol, TIMEFRAMES.H1),
            calcIndicators(m15Closed, symbol, TIMEFRAMES.M15),
        ]);

        const setup = this.buildM15Setup(symbol, { d1, h4, h1, m15 }, setupKey, lastClosedM15);

        if (!setup) {
            logger.info(`[Setup] ${symbol}: no H1/H4 + M15 aligned setup on candle ${setupKey}.`);
            this.activeM15Setups.delete(symbol);
            return;
        }

        this.activeM15Setups.set(symbol, setup);
        logger.info(`[Setup] ${symbol}: activated ${setup.direction} setup on ${setup.setupKey}.`);
    }

    async analyzeSymbol(symbol) {
        return this.refreshM15Setup(symbol);
    }

    async shutdown() {
        this.isRunning = false;
        clearInterval(this.analysisInterval);
        clearInterval(this.sessionRefreshInterval);
        clearInterval(this.entryTriggerInterval);
        clearInterval(this.dealIdMonitorInterval);
        clearInterval(this.priceMonitorInterval);
        if (this.positionGuard?.stop) this.positionGuard.stop();
        webSocketService.disconnect();
    }

    startPriceMonitor() {
        const interval = this.getEntryInitialIntervalMs();
        logger.info(`[PriceMonitor] Starting (every 1 minute) after ${interval}ms at ${new Date().toISOString()}`);
        if (this.priceMonitorInterval) clearInterval(this.priceMonitorInterval);

        const run = async () => {
            if (this.priceMonitorInProgress) {
                logger.warn("[PriceMonitor] Previous tick still running; skipping.");
                return;
            }
            this.priceMonitorInProgress = true;
            try {
                await priceLogger.logOneMinuteSnapshotsForSymbols(this.activeSymbols);
            } finally {
                this.priceMonitorInProgress = false;
            }
        };

        setTimeout(() => {
            run();
            this.priceMonitorInterval = setInterval(run, this.getEntryRepeatIntervalMs());
        }, interval);
    }

    async startMonitorOpenTrades() {
        return startMonitorOpenTrades(this, MONITOR_INTERVAL_MS);
    }

    async trailingStopCheck() {
        return trailingStopCheck(this);
    }

    async maxHoldCheck() {
        return maxHoldCheck(this);
    }

    logDeals() {
        return logDeals(this);
    }

    scheduleMidnightSessionRefresh() {
        const now = new Date();
        const nextMidnight = new Date(now);
        nextMidnight.setHours(24, 0, 0, 0); // Next 00:00
        const msUntilMidnight = nextMidnight - now;
        setTimeout(() => {
            this.refreshSessionAtMidnight();
            // After first run, repeat every 24h
            setInterval(() => this.refreshSessionAtMidnight(), 24 * 60 * 60 * 1000);
        }, msUntilMidnight);
        logger.info(`[Bot] Scheduled session refresh at midnight in ${(msUntilMidnight / 1000 / 60).toFixed(2)} minutes.`);
    }

    async refreshSessionAtMidnight() {
        try {
            logger.info("[Bot] Refreshing session at midnight...");
            await refreshSession();
            logger.info("[Bot] Session refreshed at midnight.");
        } catch (error) {
            logger.error("[bot.js][Bot] Midnight session refresh failed:", error);
        }
    }

    async closeAllPositions() {
        if (!this.positionGuard?.closeAllPositions) {
            logger.warn("[Bot] PositionGuard disabled; closeAllPositions skipped.");
            return false;
        }
        return this.positionGuard.closeAllPositions();
    }

    getInitialIntervalMs() {
        return DEV.MODE ? DEV.INTERVAL : PROD.INTERVAL;
    }

    getRepeatIntervalMs() {
        return DEV.MODE ? DEV.INTERVAL : ANALYSIS_REPEAT_MS;
    }

    getEntryInitialIntervalMs() {
        if (DEV.MODE) return DEV.INTERVAL;
        return this.delayToNextMinuteMs(5000);
    }

    getEntryRepeatIntervalMs() {
        return DEV.MODE ? DEV.INTERVAL : ENTRY_CHECK_REPEAT_MS;
    }

    delayToNextMinuteMs(extraMs = 0) {
        const now = new Date();
        return (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + extraMs;
    }

    toNumber(value) {
        if (value === undefined || value === null || value === "") return null;
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    }

    parseTimestampMs(value) {
        if (typeof value === "number") return value > 1e12 ? value : value * 1000;
        if (typeof value !== "string") return NaN;

        const trimmed = value.trim();
        if (!trimmed) return NaN;

        const direct = Date.parse(trimmed);
        if (!Number.isNaN(direct)) return direct;

        const normalized = trimmed.replace(/\//g, "-").replace(" ", "T");
        const withZone = /[zZ]|[+\-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
        const parsed = Date.parse(withZone);
        return Number.isNaN(parsed) ? NaN : parsed;
    }

    getCandleTimestampMs(candle) {
        if (!candle || typeof candle !== "object") return NaN;

        const raw = candle.timestampMs ?? candle.timestamp ?? candle.snapshotTimeUTC ?? candle.snapshotTime ?? null;
        if (raw === null) return NaN;

        if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
        return this.parseTimestampMs(String(raw));
    }

    getClosedCandles(candles, timeframeMinutes) {
        if (!Array.isArray(candles) || !candles.length) return [];
        if (candles.length === 1) return candles.slice();

        const last = candles[candles.length - 1];
        const lastTs = this.getCandleTimestampMs(last);
        const tfMs = timeframeMinutes * 60 * 1000;

        if (!Number.isFinite(lastTs)) {
            // Conservative fallback: drop the newest bar when timestamp cannot be trusted.
            return candles.slice(0, -1);
        }

        const isClosed = Date.now() >= lastTs + tfMs;
        return isClosed ? candles.slice() : candles.slice(0, -1);
    }

    buildCandleKey(symbol, candle) {
        const ts = this.getCandleTimestampMs(candle);
        if (Number.isFinite(ts)) return `${symbol}:${ts}`;

        const open = this.toNumber(candle?.open);
        const high = this.toNumber(candle?.high);
        const low = this.toNumber(candle?.low);
        const close = this.toNumber(candle?.close);
        if ([open, high, low, close].some((v) => v === null)) return null;

        return `${symbol}:${open}:${high}:${low}:${close}`;
    }

    buildM15Setup(symbol, indicators, setupKey, lastClosedM15) {
        const { d1, h4, h1, m15 } = indicators || {};
        if (!h1 || !h4 || !m15) return null;

        const trendBias = Strategy.trendBias(h1, h4);
        const h1Trend = Strategy.pickTrend(h1);
        const h4Trend = Strategy.pickTrend(h4);
        const m15Trend = Strategy.pickTrend(m15);

        if (trendBias === "neutral" || m15Trend === "neutral") return null;

        const direction = trendBias === "bullish" ? "BUY" : "SELL";
        const aligned = (direction === "BUY" && m15Trend === "bullish") || (direction === "SELL" && m15Trend === "bearish");
        if (!aligned) return null;

        const closedTs = this.getCandleTimestampMs(lastClosedM15);
        const expiresAtMs = Number.isFinite(closedTs) ? closedTs + M15_SETUP_TTL_MS : Date.now() + M15_SETUP_TTL_MS;

        return {
            symbol,
            setupKey,
            direction,
            activatedAt: new Date().toISOString(),
            expiresAtMs,
            context: {
                trendBias,
                h1Trend,
                h4Trend,
                m15Trend,
            },
            higherIndicators: { d1, h4, h1, m15 },
        };
    }

    async getBidAsk(symbol) {
        const marketDetails = await getMarketDetails(symbol);
        return {
            bid: marketDetails?.snapshot?.bid,
            ask: marketDetails?.snapshot?.offer,
        };
    }

    isValidPricePair(bid, ask) {
        return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0;
    }

    storeCandleHistory(symbol, { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data }) {
        this.candleHistory[symbol] = {
            D1: d1Data.prices.slice(-this.maxCandleHistory) || [],
            H4: h4Data.prices.slice(-this.maxCandleHistory) || [],
            H1: h1Data.prices.slice(-this.maxCandleHistory) || [],
            M15: m15Data.prices.slice(-this.maxCandleHistory) || [],
            M5: m5Data.prices.slice(-this.maxCandleHistory) || [],
            M1: m1Data.prices.slice(-this.maxCandleHistory) || [],
        };
    }

    getCandleHistory(symbol) {
        const history = this.candleHistory[symbol] || {};
        return {
            d1Candles: history.D1,
            h4Candles: history.H4,
            h1Candles: history.H1,
            m15Candles: history.M15,
            m5Candles: history.M5,
            m1Candles: history.M1,
        };
    }

    async buildIndicatorsSnapshot({ symbol, d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles }) {
        return {
            d1: await calcIndicators(d1Candles, symbol, TIMEFRAMES.D1),
            h4: await calcIndicators(h4Candles, symbol, TIMEFRAMES.H4),
            h1: await calcIndicators(h1Candles, symbol, TIMEFRAMES.H1),
            m15: await calcIndicators(m15Candles, symbol, TIMEFRAMES.M15),
            m5: await calcIndicators(m5Candles, symbol, TIMEFRAMES.M5),
            m1: await calcIndicators(m1Candles, symbol, TIMEFRAMES.M1),
        };
    }

    async isTradingAllowed(symbol) {
        const now = new Date();

        const day = now.getDay(); // 0 = Sunday, 6 = Saturday
        if (day === 0 || day === 6) {
            logger.info("[Bot] Trading blocked: Weekend.");
            return false;
        }

        // Session windows in this bot are defined in UTC.
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const currentMinutes = hour * 60 + minute;

        // Check if current time is inside any allowed window
        const allowed = this.allowedTradingWindows.some((win) => {
            if (win.start <= win.end) {
                return currentMinutes >= win.start && currentMinutes <= win.end;
            } else {
                // Overnight session (e.g. Sydney)
                return currentMinutes >= win.start || currentMinutes <= win.end;
            }
        });

        if (!allowed) {
            logger.info("[Bot] Trading blocked: Not in allowed session window (first/last 15 min excluded).");
            return false;
        }

        const newsBlocked = await isNewsTime(symbol);
        if (newsBlocked) {
            logger.info("[Bot] Trading blocked: High-impact news event detected.");
            return false;
        }
        return true;
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

const bot = new TradingBot();

bot.initialize().catch((error) => {
    logger.error("[bot.js] Bot initialization failed:", error);
    process.exit(1);
});
