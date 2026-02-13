import { startSession, pingSession, getHistorical, getAccountInfo, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { DEV, PROD, ANALYSIS, SESSIONS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators/indicators.js";
import logger from "./utils/logger.js";
import { getNewsStatus } from "./utils/newsChecker.js";
import { startMonitorOpenTrades, trailingStopCheck, maxHoldCheck, logDeals, startPriceMonitor, startWebSocket } from "./bot/monitors.js";

const { TIMEFRAMES } = ANALYSIS;
const ANALYSIS_REPEAT_MS = 5 * 60 * 1000;
const MONITOR_INTERVAL_MS = 60 * 1000;
class TradingBot {
    constructor() {
        this.isRunning = false;
        this.analysisInterval = null;
        this.analysisStartTimeout = null;
        this.analysisInProgress = false;
        this.sessionRefreshInterval = null;
        this.sessionPingInterval = null;
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
        this.activeSymbols = [];

        this.allowedTradingWindows = [
            // Trade from London+NY overlap (13:00 UTC) through NY, Sydney, Tokyo until 07:00 UTC.
            { start: 13 * 60, end: 7 * 60 },
        ];
        this.tokens = null;
    }

    async initialize() {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await startSession();
                const tokens = getSessionTokens();
                if (!tokens.cst || !tokens.xsecurity) throw new Error("Invalid session tokens");
                this.tokens = tokens;
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

    async startLiveTrading() {
        try {
            // startWebSocket(this);
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
                logger.warn("[bot.js] Previous analysis still running; skipping this tick.");
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

        this.analysisStartTimeout = setTimeout(() => {
            void runAnalysis();
            // After first run, repeat every 5 minutes
            this.analysisInterval = setInterval(() => {
                void runAnalysis();
            }, this.getRepeatIntervalMs());
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

    async analyzeAllSymbols() {
        this.activeSymbols = await this.getActiveSymbols();
        for (const symbol of this.activeSymbols) {
            await this.analyzeSymbol(symbol);
            await this.delay(2000);
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
            logger.debug(
                `[CandleFetch] ${symbol}: fetched ${timeframes.D1}, ${timeframes.H4}, ${timeframes.H1}, ${timeframes.M15}, ${timeframes.M5}, ${timeframes.M1}`,
            );
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
        clearTimeout(this.analysisStartTimeout);
        clearInterval(this.analysisInterval);
        clearInterval(this.sessionRefreshInterval);
        clearInterval(this.sessionPingInterval);
        clearInterval(this.monitorInterval);
        clearInterval(this.dealIdMonitorInterval);
        clearInterval(this.priceMonitorInterval);
        webSocketService.disconnect();
    }

    startPriceMonitor() {
        return startPriceMonitor(this);
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

    async buildIndicatorsSnapshot({ d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, m1Candles }) {
        return {
            d1: await calcIndicators(d1Candles),
            h4: await calcIndicators(h4Candles),
            h1: await calcIndicators(h1Candles),
            m15: await calcIndicators(m15Candles),
            m5: await calcIndicators(m5Candles),
            m1: await calcIndicators(m1Candles),
        };
    }

    async isTradingAllowed(symbol, context = {}) {
        const now = context.now instanceof Date ? context.now : new Date();
        const currentMinutes = Number.isFinite(context.currentMinutes) ? context.currentMinutes : now.getUTCHours() * 60 + now.getUTCMinutes();

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

        const news = await getNewsStatus(symbol, {
            now,
            includeImpacts: ["High", "Medium"],
            windowsByImpact: {
                High: { preMinutes: 30, postMinutes: 5 },
                Medium: { preMinutes: 15, postMinutes: 2 },
            },
        });

        if (news.blocked) {
            const titles = news.blockingEvents.map((e) => `${e.impact}:${e.country}:${e.title}`);
            logger.info(`[Bot][News] Trading blocked for ${symbol} until ${news.blockUntilUtc?.toISOString()}. Events: ${titles.join(" | ")}`);
            return false;
        }

        return true;
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

const bot = new TradingBot();

const now = new Date();
const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
if (day === 0 || day === 6) {
    logger.info("[Bot] It's the weekend. Bot will not start until Monday.");
} else {
    bot.initialize().catch((error) => {
        logger.error("[bot.js] Bot initialization failed:", error);
        process.exit(1);
    });
}
