import { startSession, pingSession, getHistorical, getAccountInfo, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { DEV, PROD, ANALYSIS, SESSIONS, CRYPTO_SYMBOLS, TRADING_WINDOWS, NEWS_GUARD } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators/indicators.js";
import logger from "./utils/logger.js";
import { getNewsStatus } from "./utils/newsChecker.js";
import { startMonitorOpenTrades, trailingStopCheck, logDeals, startPriceMonitor, startWebSocket } from "./bot/monitors.js";
import { startHubServer } from "./services/hubServer.js";

const { TIMEFRAMES } = ANALYSIS;
const ANALYSIS_REPEAT_MS = 60 * 1000;
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
        this.maxCandleHistoryExtended = 260; // Used by strategies that need >=200 closed candles
        this.openedPositions = {}; // Track opened positions

        this.openedBrockerDealIds = [];
        this.activeSymbols = [];

        this.allowedTradingWindows = TRADING_WINDOWS.FOREX.map((window) => ({ ...window }));
        this.cryptoTradingWindows = TRADING_WINDOWS.CRYPTO.map((window) => ({ ...window }));
        this.rolloverTimeZone = "America/New_York";
        this.rolloverHour = 17;
        this.rolloverMinute = 0;
        this.rolloverBufferMinutes = 10;
        this.lastRolloverCloseKey = null;
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
                logger.info("[Bot] Session pinged successfully");
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

        // First run: align to next minute + 5 seconds
        const interval = this.getInitialIntervalMs();
        logger.info(`[${DEV.MODE ? "DEV" : "PROD"}] Setting up analysis interval: ${interval}ms`);

        this.analysisStartTimeout = setTimeout(() => {
            void runAnalysis();
            // After first run, repeat every minute
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
                    if (accountData.accounts[0].currency) {
                        tradingService.setAccountCurrency(accountData.accounts[0].currency);
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

        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    toIsoTimestamp(value) {
        const tsMs = this.toTimestampMs(value);
        return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    }

    toTimestampMsLocalNoZone(value) {
        if (value === undefined || value === null || value === "") return null;
        if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
        if (typeof value === "number") {
            const dt = new Date(value);
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }
        const raw = String(value).trim();
        if (!raw) return null;

        // Intentionally parse timezone-less values in local timezone for market update fields.
        const localParsed = Date.parse(raw);
        return Number.isFinite(localParsed) ? localParsed : null;
    }

    toIsoTimestampLocalNoZone(value) {
        const tsMs = this.toTimestampMsLocalNoZone(value);
        return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    }

    chooseTimestampClosestToReference(candidatesMs = [], referenceMs = null) {
        const finite = [...new Set(candidatesMs.filter((v) => Number.isFinite(v)))];
        if (!finite.length) return null;
        if (!Number.isFinite(referenceMs)) return finite[0];
        let best = finite[0];
        let bestDistance = Math.abs(best - referenceMs);
        for (let i = 1; i < finite.length; i += 1) {
            const candidate = finite[i];
            const distance = Math.abs(candidate - referenceMs);
            if (distance < bestDistance) {
                best = candidate;
                bestDistance = distance;
            }
        }
        return best;
    }

    inSession(currentMinutes, startMinutes, endMinutes, { inclusiveEnd = false } = {}) {
        if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
        if (startMinutes < endMinutes) {
            return currentMinutes >= startMinutes && (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
        }
        return currentMinutes >= startMinutes || (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes); // Overnight session
    }

    getMinutesInTimeZone(timeZone, date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).formatToParts(date);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        return hour * 60 + minute;
    }

    isCryptoSymbol(symbol) {
        return CRYPTO_SYMBOLS.includes(symbol);
    }

    getActiveSessionNames(now = new Date()) {
        const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        const activeSessionNames = [];

        for (const [name, session] of Object.entries(SESSIONS)) {
            if (name === "CRYPTO") {
                activeSessionNames.push(name);
                continue;
            }

            const startMinutes = this.parseMinutes(session?.START);
            const endMinutes = this.parseMinutes(session?.END);
            if (this.inSession(currentMinutes, startMinutes, endMinutes)) {
                activeSessionNames.push(name);
            }
        }

        return activeSessionNames;
    }

    async getActiveSymbols() {
        // SESSIONS in config.js are defined in UTC (see config.js), so we must evaluate in UTC as well.
        const now = new Date();
        const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

        const activeSessions = [];
        const activeSessionNames = this.getActiveSessionNames(now);

        for (const name of activeSessionNames) {
            const session = SESSIONS?.[name];
            if (session?.SYMBOLS) {
                activeSessions.push(session.SYMBOLS);
            }
        }

        // Combine symbols from all active sessions, remove duplicates
        const combinedSet = new Set();
        activeSessions.forEach((arr) => (arr || []).forEach((symbol) => combinedSet.add(symbol)));
        const sessionSymbols = [...combinedSet];
        const tradableSymbols = [];
        const blockedByReason = {};
        const blockedDetails = [];

        for (const symbol of sessionSymbols) {
            const checkContext = { now, currentMinutes, rejectReason: null, rejectDetail: null };
            if (await this.isTradingAllowed(symbol, checkContext)) {
                tradableSymbols.push(symbol);
                continue;
            }
            const reason = checkContext.rejectReason || "filtered_unknown";
            blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
            blockedDetails.push(
                `${symbol}:${reason}${checkContext.rejectDetail ? `(${checkContext.rejectDetail})` : ""}`,
            );
        }

        const blockedSummary = Object.entries(blockedByReason)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(", ");

        logger.info(
            `[Bot] Active sessions (UTC): ${activeSessions.length} (${activeSessionNames.length ? activeSessionNames.join(", ") : "none"}), Session symbols: ${
                sessionSymbols.length ? sessionSymbols.join(", ") : "none"
            }, Tradable symbols: ${tradableSymbols.length ? tradableSymbols.join(", ") : "none"
            }`,
        );
        if (blockedSummary) {
            logger.info(`[Bot][Filter] Blocked summary: ${blockedSummary}`);
        }
        if (blockedDetails.length) {
            logger.debug(`[Bot][Filter] Blocked detail: ${blockedDetails.join(", ")}`);
        }
        if (!sessionSymbols.length) {
            logger.warn(
                `[Bot][Filter] Active sessions produced zero symbols. Sessions: ${activeSessionNames.length ? activeSessionNames.join(", ") : "none"}`,
            );
        }
        if (!tradableSymbols.length && sessionSymbols.length) {
            logger.warn(
                `[Bot][Filter] All session symbols were filtered out this tick. SessionCount=${activeSessions.length}, SymbolCount=${sessionSymbols.length}`,
            );
        }
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
        logger.info(`[Analyze] Processing ${symbol}`);

        const historyLength = this.getHistoryLengthForSymbol(symbol);
        const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, historyLength);

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
        const latestM1Timestamp = m1Candles?.[m1Candles.length - 1]?.timestamp;
        const { bid, ask, timestamp: marketTimestamp } = await this.getBidAsk(symbol, latestM1Timestamp);
        const timestamp = marketTimestamp || this.toIsoTimestamp(latestM1Timestamp) || new Date().toISOString();
        const activeSessions = this.getActiveSessionNames(new Date()).filter((sessionName) => {
            if (sessionName === "CRYPTO") return this.isCryptoSymbol(symbol);
            const sessionSymbols = SESSIONS?.[sessionName]?.SYMBOLS || [];
            return sessionSymbols.includes(symbol);
        });
        let newsBlocked = false;
        if (!this.isCryptoSymbol(symbol)) {
            try {
                const news = await getNewsStatus(symbol, {
                    now: new Date(timestamp),
                    includeImpacts: NEWS_GUARD.INCLUDE_IMPACTS,
                    windowsByImpact: NEWS_GUARD.WINDOWS_BY_IMPACT,
                });
                newsBlocked = Boolean(news?.blocked);
            } catch (error) {
                logger.warn(`[Analyze] News check failed for ${symbol}: ${error.message}`);
            }
        }

        // Pass bid/ask to trading logic
        await tradingService.processPrice({
            symbol,
            indicators,
            candles,
            bid,
            ask,
            timestamp,
            sessions: activeSessions,
            newsBlocked,
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

    async getBidAsk(symbol, referenceTimestamp = null) {
        const marketDetails = await getMarketDetails(symbol);
        const snapshot = marketDetails?.snapshot || {};
        const rawCandidates = [
            snapshot?.updateTime,
            snapshot?.updateTimeUTC,
            snapshot?.timestamp,
            snapshot?.snapshotTimeUTC,
            snapshot?.snapshotTime,
        ].filter((v) => v !== undefined && v !== null && v !== "");
        const parsedCandidates = [];
        for (const raw of rawCandidates) {
            const asLocal = this.toTimestampMsLocalNoZone(raw);
            const asUtc = this.toTimestampMs(raw);
            if (Number.isFinite(asLocal)) parsedCandidates.push(asLocal);
            if (Number.isFinite(asUtc)) parsedCandidates.push(asUtc);
        }
        const referenceMs = this.toTimestampMs(referenceTimestamp);
        const selectedTsMs = this.chooseTimestampClosestToReference(parsedCandidates, referenceMs);
        const marketTimestamp = Number.isFinite(selectedTsMs) ? new Date(selectedTsMs).toISOString() : null;
        return {
            bid: snapshot?.bid,
            ask: snapshot?.offer,
            timestamp: marketTimestamp,
        };
    }

    storeCandleHistory(symbol, { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data }) {
        const historyLimit = this.getHistoryLengthForSymbol(symbol);
        this.candleHistory[symbol] = {
            D1: d1Data.prices.slice(-historyLimit) || [],
            H4: h4Data.prices.slice(-historyLimit) || [],
            H1: h1Data.prices.slice(-historyLimit) || [],
            M15: m15Data.prices.slice(-historyLimit) || [],
            M5: m5Data.prices.slice(-historyLimit) || [],
            M1: m1Data.prices.slice(-historyLimit) || [],
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
        context.rejectReason = null;
        context.rejectDetail = null;

        if (this.isCryptoSymbol(symbol)) {
            if (typeof tradingService.shouldAlwaysEvaluateCryptoSymbol === "function" && tradingService.shouldAlwaysEvaluateCryptoSymbol(symbol)) {
                return true;
            }
            // Crypto is traded 24/7.
            return true;
        }

        const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
        const sundayOpenMinutes = 22 * 60;
        const fridayCloseMinutes = 22 * 60;
        if (day === 6) {
            context.rejectReason = "weekend_saturday";
            return false;
        }
        if (day === 0 && currentMinutes < sundayOpenMinutes) {
            context.rejectReason = "weekend_pre_open";
            return false;
        }
        if (day === 5 && currentMinutes >= fridayCloseMinutes) {
            context.rejectReason = "weekend_post_close";
            return false;
        }

        // Forex timing is already controlled by session symbols (getActiveSymbols),
        // plus weekend and rollover/news blocks below.

        const rolloverMinutes = this.rolloverHour * 60 + this.rolloverMinute;
        const nyMinutes = this.getMinutesInTimeZone(this.rolloverTimeZone, now);
        const inRolloverBuffer = nyMinutes >= rolloverMinutes - this.rolloverBufferMinutes && nyMinutes < rolloverMinutes;

        if (inRolloverBuffer) {
            context.rejectReason = "rollover_buffer";
            logger.info(
                `[Bot][Rollover] Entry blocked (${this.rolloverTimeZone} ${this.rolloverHour}:${String(this.rolloverMinute).padStart(2, "0")}, buffer ${this.rolloverBufferMinutes}m).`,
            );
            return false;
        }

        const news = await getNewsStatus(symbol, {
            now,
            includeImpacts: NEWS_GUARD.INCLUDE_IMPACTS,
            windowsByImpact: NEWS_GUARD.WINDOWS_BY_IMPACT,
        });

        if (news.blocked) {
            const titles = news.blockingEvents.map((e) => `${e.impact}:${e.country}:${e.title}`);
            context.rejectReason = "news_blocked";
            context.rejectDetail = titles.slice(0, 2).join(" | ");
            logger.info(`[Bot][News] Trading blocked for ${symbol} until ${news.blockUntilUtc?.toISOString()}. Events: ${titles.join(" | ")}`);
            return false;
        }

        return true;
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getHistoryLengthForSymbol(symbol) {
        if (typeof tradingService.shouldAlwaysEvaluateCryptoSymbol === "function" && tradingService.shouldAlwaysEvaluateCryptoSymbol(symbol)) {
            return Math.max(this.maxCandleHistory, this.maxCandleHistoryExtended);
        }
        return this.maxCandleHistory;
    }
}

startHubServer();

const bot = new TradingBot();

const hasAlwaysOnCrypto = Array.isArray(CRYPTO_SYMBOLS) && CRYPTO_SYMBOLS.length > 0;
const now = new Date();
const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
if ((day === 0 || day === 6) && !hasAlwaysOnCrypto) {
    logger.info("[Bot] It's the weekend. Bot will not start until Monday.");
} else {
    if ((day === 0 || day === 6) && hasAlwaysOnCrypto) {
        logger.info("[Bot] Weekend detected, but CRYPTO symbols are configured. Starting bot.");
    }
    bot.initialize().catch((error) => {
        logger.error("[bot.js] Bot initialization failed:", error);
        process.exit(1);
    });
}
