import { startSession, pingSession, getHistorical, getAccountInfo, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { DEV, PROD, ANALYSIS, SESSIONS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators/indicators.js";
import { priceLogger } from "./utils/priceLogger.js";
import logger from "./utils/logger.js";
import { isNewsTime } from "./utils/newsChecker.js";
import { startMonitorOpenTrades, trailingStopCheck, maxHoldCheck, logDeals } from "./bot/monitors.js";

const { TIMEFRAMES } = ANALYSIS;
const ANALYSIS_REPEAT_MS = 5 * 60 * 1000;
const MONITOR_INTERVAL_MS = 60 * 1000;
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
        this.monitorInterval = null; // Add monitor interval for open trades
        this.monitorInProgress = false; // Prevent overlapping monitor runs
        this.priceMonitorInterval = null;
        this.priceMonitorInProgress = false;
        this.dealIdMonitorInterval = null; // Interval handle for dealId monitor
        this.dealIdMonitorInProgress = false; // Prevent overlapping dealId checks
        this.maxCandleHistory = 200; // Rolling window size for indicators
        this.openedPositions = {}; // Track opened positions

        this.openedBrockerDealIds = [];
        this.activeSymbols = this.getActiveSymbols();
        this.positionGuard = null;

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
        const now = new Date();
        const hour = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));

        // Helper to check if hour is in session
        const inSession = (start, end) => {
            if (start < end) return hour >= start && hour < end;
            return hour >= start || hour < end; // Overnight session
        };

        const activeSessions = [];
        if (inSession(8, 17)) activeSessions.push(SESSIONS.LONDON.SYMBOLS);
        if (inSession(13, 21)) activeSessions.push(SESSIONS.NY.SYMBOLS);
        if (inSession(22, 7)) activeSessions.push(SESSIONS.SYDNEY.SYMBOLS);
        if (inSession(0, 9)) activeSessions.push(SESSIONS.TOKYO.SYMBOLS);

        // Combine symbols from all active sessions, remove duplicates
        let combined = [];
        activeSessions.forEach((arr) => combined.push(...arr));
        combined = [...new Set(combined)];

        logger.info(`[Bot] Active sessions: ${activeSessions.length}, Trading symbols: ${combined.join(", ")}`);
        return combined;
    }

    // Analyzes all symbols in the trading universe.

    async analyzeAllSymbols() {
        for (const symbol of this.activeSymbols) {
            if (!(await this.isTradingAllowed(symbol))) {
                logger.info("[Bot] Skipping analysis: Trading not allowed at this time.");
                return;
            }
            await this.analyzeSymbol(symbol);
            await this.delay(SYMBOL_ANALYSIS_DELAY_MS);
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

    // Analyzes a single symbol: fetches data, calculates indicators, and triggers trading logic.
    async analyzeSymbol(symbol) {
        logger.info(`\n\n=== Processing ${symbol} ===`);

        const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.maxCandleHistory);

        if (!d1Data?.prices || !h4Data?.prices || !h1Data?.prices || !m15Data?.prices || !m5Data?.prices || !m1Data?.prices) {
            logger.warn(`[bot.js][analyzeSymbol] Missing candle data for ${symbol}, skipping analysis.`);
            return;
        }

        this.storeCandleHistory(symbol, { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data });
        const { d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles } = this.getCandleHistory(symbol);

        if (!d1Candles || !h4Candles || !h1Candles || !m15Candles || !m5Candles || !m1Candles) {
            logger.error(
                `[bot.js][analyzeSymbol] Incomplete candle data for ${symbol} ( D1: ${!!d1Candles}, H4: ${!!h4Candles}, H1: ${!!h1Candles}, M15: ${!!m15Candles}, M5: ${!!m5Candles}, M1: ${!!m1Candles} skipping analysis.`,
            );
            return;
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

        const candles = { d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles };

        // --- Fetch real-time bid/ask ---
        const { bid, ask } = await this.getBidAsk(symbol);

        // console.log(marketDetails);

        // Guard: skip analysis if we don't have valid prices yet
        if (!this.isValidPricePair(bid, ask)) {
            logger.warn(`[bot.js][analyzeSymbol] Skipping ${symbol}: invalid bid/ask (bid=${bid}, ask=${ask})`);
            return;
        }

        // Pass bid/ask to trading logic
        await tradingService.processPrice({
            symbol,
            indicators,
            candles,
            bid,
            ask,
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
        const interval = this.getInitialIntervalMs();
        logger.info(`[PriceMonitor] Starting (every 5 minutes) after ${interval}ms at ${new Date().toISOString()}`);
        if (this.priceMonitorInterval) clearInterval(this.priceMonitorInterval);

        const run = async () => {
            if (this.priceMonitorInProgress) {
                logger.warn("[PriceMonitor] Previous tick still running; skipping.");
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
            this.priceMonitorInterval = setInterval(run, this.getRepeatIntervalMs());
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

        // Get current time in minutes (Berlin time)
        const hour = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));
        const minute = Number(now.toLocaleString("en-US", { minute: "2-digit", timeZone: "Europe/Berlin" }));
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
