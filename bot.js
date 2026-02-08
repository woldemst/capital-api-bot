import { startSession, pingSession, getHistorical, getAccountInfo, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { DEV, PROD, ANALYSIS, SESSIONS, CRYPTO_SYMBOLS, LIVE_MANAGEMENT } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators, tradeWatchIndicators } from "./indicators/indicators.js";
import { priceLogger } from "./utils/priceLogger.js";
import logger from "./utils/logger.js";
import { isNewsTime } from "./utils/newsChecker.js";
import { startMonitorOpenTrades, trailingStopCheck, maxHoldCheck, logDeals } from "./bot/monitors.js";

const { TIMEFRAMES } = ANALYSIS;
const ANALYSIS_REPEAT_MS = 5 * 60 * 1000;
const MONITOR_INTERVAL_MS = LIVE_MANAGEMENT.LOOP_MS;
const PRICE_MONITOR_REPEAT_MS = 60 * 1000;
const SYMBOL_ANALYSIS_DELAY_MS = 2000;
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
        this.analysisInProgress = false;
        this.monitorInterval = null; // Add monitor interval for open trades
        this.monitorInProgress = false; // Prevent overlapping monitor runs
        this.priceMonitorInterval = null;
        this.priceMonitorInProgress = false;
        this.dealIdMonitorInterval = null; // Interval handle for dealId monitor
        this.dealIdMonitorInProgress = false; // Prevent overlapping dealId checks
        this.maxCandleHistory = 200; // Rolling window size for indicators
        this.openedPositions = {}; // Track opened positions

        this.openedBrockerDealIds = [];
        this.activeSymbols = [];

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
            if (this.analysisInProgress) {
                logger.warn("[Bot] Previous analysis cycle still running; skipping this tick.");
                return;
            }

            this.analysisInProgress = true;
            try {
                await this.updateAccountInfo();
                await this.analyzeAllSymbols();
            } catch (error) {
                logger.error("[bot.js] Analysis interval error:", error);
            } finally {
                this.analysisInProgress = false;
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

    isCryptoSymbol(symbol) {
        return CRYPTO_SYMBOLS.includes(symbol);
    }

    parseMinutes(hhmm) {
        if (typeof hhmm !== "string") return NaN;
        const [hh, mm] = hhmm.split(":").map((p) => Number(p));
        if (!Number.isInteger(hh) || !Number.isInteger(mm)) return NaN;
        return hh * 60 + mm;
    }

    inSession(currentMinutes, startMinutes, endMinutes, { inclusiveEnd = false } = {}) {
        if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
        if (startMinutes < endMinutes) {
            return currentMinutes >= startMinutes && (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
        }
        return currentMinutes >= startMinutes || (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes); // Overnight session
    }

    async getActiveSymbols() {
        // SESSIONS in config.js are defined in UTC (see config.js), so we must evaluate in UTC as well.
        const now = new Date();
        const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

        const activeSessions = [];
        const activeSessionNames = [];

        for (const [name, session] of Object.entries(SESSIONS)) {
            if (name === "CRYPTO") {
                activeSessions.push(session?.SYMBOLS || []);
                activeSessionNames.push(name);
                continue;
            }

            const startMinutes = this.parseMinutes(session?.START);
            const endMinutes = this.parseMinutes(session?.END);
            if (!this.inSession(currentMinutes, startMinutes, endMinutes)) continue;

            activeSessions.push(session.SYMBOLS);
            activeSessionNames.push(name);
        }

        // Combine symbols from all active sessions, remove duplicates
        const combinedSet = new Set();
        activeSessions.forEach((arr) => (arr || []).forEach((symbol) => combinedSet.add(symbol)));
        const sessionSymbols = [...combinedSet];
        const tradableSymbols = [];

        for (const symbol of sessionSymbols) {
            if (await this.isTradingAllowed(symbol, { now, currentMinutes })) {
                tradableSymbols.push(symbol);
            }
        }

        logger.info(
            `[Bot] Active sessions (UTC): ${activeSessions.length} (${activeSessionNames.length ? activeSessionNames.join(", ") : "none"}), Tradable symbols: ${
                tradableSymbols.length ? tradableSymbols.join(", ") : "none"
            }`,
        );
        return tradableSymbols;
    }

    // Phase A: scan all active symbols and collect standardized MTF data.
    async scanActiveSymbols(symbols = []) {
        const scans = [];
        for (const symbol of symbols) {
            const scan = await this.scanSymbol(symbol);
            if (scan) scans.push(scan);
            await this.delay(SYMBOL_ANALYSIS_DELAY_MS);
        }
        return scans;
    }

    // Analyzes all symbols in the trading universe.
    async analyzeAllSymbols() {
        this.activeSymbols = await this.getActiveSymbols();
        const scans = await this.scanActiveSymbols(this.activeSymbols);
        for (const scan of scans) {
            await this.analyzeSymbol(scan);
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

    buildBarsMeta(candles = [], timeframe) {
        const lastBar = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
        return {
            timeframe,
            count: Array.isArray(candles) ? candles.length : 0,
            lastTimestamp: lastBar?.timestamp ?? lastBar?.snapshotTime ?? null,
        };
    }

    async scanSymbol(symbol) {
        logger.info(`\n\n=== Processing ${symbol} ===`);
        const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.maxCandleHistory);

        if (!d1Data?.prices || !h4Data?.prices || !h1Data?.prices || !m15Data?.prices || !m5Data?.prices || !m1Data?.prices) {
            logger.warn(`[Scan] Missing candle data for ${symbol}, skipping.`);
            return null;
        }

        this.storeCandleHistory(symbol, { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data });
        const { d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles } = this.getCandleHistory(symbol);
        if (!d1Candles || !h4Candles || !h1Candles || !m15Candles || !m5Candles || !m1Candles) {
            logger.warn(`[Scan] Incomplete history for ${symbol}, skipping.`);
            return null;
        }

        const indicators = await this.buildIndicatorsSnapshot({
            symbol,
            d1Candles,
            h4Candles,
            h1Candles,
            m15Candles,
            m5Candles,
            m1Candles,
        });

        return {
            symbol,
            tf: {
                D1: { indicators: indicators.d1, barsMeta: this.buildBarsMeta(d1Candles, "D1") },
                H4: { indicators: indicators.h4, barsMeta: this.buildBarsMeta(h4Candles, "H4") },
                H1: { indicators: indicators.h1, barsMeta: this.buildBarsMeta(h1Candles, "H1") },
                M15: { indicators: indicators.m15, barsMeta: this.buildBarsMeta(m15Candles, "M15") },
                M5: { indicators: indicators.m5, barsMeta: this.buildBarsMeta(m5Candles, "M5") },
                M1: { indicators: indicators.m1, barsMeta: this.buildBarsMeta(m1Candles, "M1") },
            },
            candles: { d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles },
        };
    }

    // Phases B/C/D execution based on one pre-scanned symbol packet.
    async analyzeSymbol(scan) {
        if (!scan?.symbol || !scan?.tf) return;
        const { symbol } = scan;
        const indicators = {
            d1: scan.tf?.D1?.indicators,
            h4: scan.tf?.H4?.indicators,
            h1: scan.tf?.H1?.indicators,
            m15: scan.tf?.M15?.indicators,
            m5: scan.tf?.M5?.indicators,
            m1: scan.tf?.M1?.indicators,
        };
        const candles = scan.candles || {};

        // --- Fetch real-time bid/ask ---
        const { bid, ask } = await this.getBidAsk(symbol);

        // console.log(marketDetails);

        // Guard: skip analysis if we don't have valid prices yet
        if (!this.isValidPricePair(bid, ask)) {
            logger.warn(`[bot.js][analyzeSymbol] Skipping ${symbol}: invalid bid/ask (bid=${bid}, ask=${ask})`);
            return;
        }

        // Pass bid/ask to trading logic
        const symbolTradingService = tradingService.getServiceForSymbol(symbol);
        await symbolTradingService.processPrice({
            symbol,
            indicators,
            candles,
            bid,
            ask,
            timeframes: TIMEFRAMES,
        });
    }

    async shutdown() {
        this.isRunning = false;
        clearInterval(this.analysisInterval);
        clearInterval(this.sessionRefreshInterval);
        clearInterval(this.dealIdMonitorInterval);
        clearInterval(this.priceMonitorInterval);
        if (this.positionGuard?.stop) this.positionGuard.stop();
        webSocketService.disconnect();
    }

    startPriceMonitor() {
        const interval = this.getPriceMonitorInitialIntervalMs();
        logger.info(`[PriceMonitor] Starting (every 1 minute) after ${interval}ms at ${new Date().toISOString()}`);
        if (this.priceMonitorInterval) clearInterval(this.priceMonitorInterval);

        const run = async () => {
            if (this.priceMonitorInProgress) {
                logger.warn("[PriceMonitor] Previous tick still running; skipping.");
                return;
            }
            if (this.analysisInProgress) {
                logger.debug("[PriceMonitor] Analysis in progress; skipping snapshot tick.");
                return;
            }
            this.priceMonitorInProgress = true;
            try {
                await priceLogger.logSnapshotsForSymbols(this.activeSymbols);
            } finally {
                this.priceMonitorInProgress = false;
            }
        };

        setTimeout(() => {
            run();
            this.priceMonitorInterval = setInterval(run, this.getPriceMonitorRepeatIntervalMs());
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

    getPriceMonitorInitialIntervalMs() {
        const now = new Date();
        return (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds() + 1000;
    }

    getPriceMonitorRepeatIntervalMs() {
        return PRICE_MONITOR_REPEAT_MS;
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

    async isTradingAllowed(symbol, context = {}) {
        const now = context.now instanceof Date ? context.now : new Date();
        const currentMinutes = Number.isFinite(context.currentMinutes) ? context.currentMinutes : now.getUTCHours() * 60 + now.getUTCMinutes();
        const isCrypto = this.isCryptoSymbol(symbol);

        // Crypto symbols trade 24/7, so no weekday/session-window restrictions.
        if (isCrypto) {
            return true;
        }

        const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
        if (day === 0 || day === 6) {
            return false;
        }

        // Check if current time is inside any allowed window
        const allowed = this.allowedTradingWindows.some((win) => {
            return this.inSession(currentMinutes, win.start, win.end, { inclusiveEnd: true });
        });

        if (!allowed) {
            return false;
        }

        const newsBlocked = await isNewsTime(symbol);
        if (newsBlocked) {
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
