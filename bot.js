// --- TradingBot: Main orchestrator for trading logic, data flow, and scheduling ---
// Human-readable, robust, and well-commented for maintainability.

import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens, refreshSession } from "./api.js";
import { TRADING, DEV_MODE, DEV, ANALYSIS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";
import { logTradeSnapshot } from "./utils/tradeLogger.js";

const { SYMBOLS, MAX_POSITIONS } = TRADING;

class TradingBot {
    constructor() {
        this.isRunning = false;
        this.analysisInterval = null;
        this.sessionRefreshInterval = null;
        this.pingInterval = 9 * 60 * 1000;
        this.maxRetries = 3;
        this.retryDelay = 30000; // 30 seconds
        this.latestCandles = {}; // Store latest candles for each symbol
        this.candleHistory = {}; // symbol -> array of candles
        this.monitorInterval = null; // Add monitor interval for open trades
        this.maxCandleHistory = 120; // Rolling window size for indicators
    }

    /**
     * Initializes the bot, handles session retries, and starts trading or backtest mode.
     */
    async initialize() {
        let retryCount = 0;

        while (retryCount < this.maxRetries) {
            try {
                await startSession();
                const tokens = getSessionTokens();

                if (!tokens.cst || !tokens.xsecurity) {
                    logger.error(`[Bot] Invalid session tokens, attempt ${retryCount + 1}/${this.maxRetries}`);
                    throw new Error("Invalid session tokens");
                }

                await this.startLiveTrading(tokens);

                this.scheduleMidnightSessionRefresh(); // <-- Schedule midnight refresh
                return; // Success, exit the retry loop
            } catch (error) {
                retryCount++;
                logger.error(`[Bot] Initialization attempt ${retryCount} failed:`, error);

                if (retryCount < this.maxRetries) {
                    logger.info(`[Bot] Refreshing session and retrying in ${this.retryDelay / 1000}s...`);
                    await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
                    await refreshSession();
                } else {
                    logger.error("[Bot] Max retry attempts reached. Shutting down.");
                    throw error;
                }
            }
        }
    }

    /**
     * Starts live trading mode: sets up WebSocket, session ping, analysis, and trade monitoring.
     */
    async startLiveTrading(tokens) {
        this.setupWebSocket(tokens);
        this.startSessionPing();
        this.startAnalysisInterval();
        this.startMonitorOpenTrades();
        this.isRunning = true;
    }

    /**
     * Sets up the WebSocket connection for real-time price data.
     * Only stores the latest candle for each symbol (no merging, no history).
     */
    setupWebSocket(tokens) {
        webSocketService.connect(tokens, SYMBOLS, (data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.payload?.epic) {
                    const candle = message.payload;
                    const symbol = candle.epic;
                    // Just store the latest candle for each symbol
                    this.latestCandles[symbol] = { latest: candle };
                }
            } catch (error) {
                logger.error("WebSocket message processing error:", error.message, data?.toString());
            }
        });
    }

    // Starts a periodic session ping to keep the API session alive.
    startSessionPing() {
        this.sessionPingInterval = setInterval(async () => {
            try {
                await pingSession();
                logger.info("Session pinged successfully");
            } catch (error) {
                logger.error("Session ping failed:", error.message);
            }
        }, this.pingInterval);
    }

    /**
     * Starts the periodic analysis interval for scheduled trading logic.
     */
    startAnalysisInterval() {
        const interval = DEV_MODE ? DEV.ANALYSIS_INTERVAL_MS : 58 * 60 * 1000; // 58 minutes for production, 1 minute in dev mode
        logger.info(`[${DEV_MODE ? "DEV" : "PROD"}] Starting analysis interval: ${interval}s`);
        this.analysisInterval = setInterval(async () => {
            try {
                logger.info(`[Running scheduled analysis...`);
                await this.updateAccountInfo();
                await this.analyzeAllSymbols();
            } catch (error) {
                logger.error("Analysis interval error:", error);
            }
        }, interval);
    }

    // Updates account balance, margin, and open trades in the trading service.
    async updateAccountInfo() {
        try {
            const accountData = await getAccountInfo();
            if (accountData?.accounts?.[0]?.balance?.balance) {
                tradingService.setAccountBalance(accountData.accounts[0].balance.balance);
                // Set available margin if present
                if (typeof accountData.accounts[0].balance.available !== "undefined") {
                    tradingService.setAvailableMargin(accountData.accounts[0].balance.available);
                }
            } else {
                throw new Error("Invalid account data structure");
            }

            const positions = await getOpenPositions();
            if (positions?.positions) {
                tradingService.setOpenTrades(positions.positions.map((p) => p.market.epic));
                logger.info(`Current open positions: ${positions.positions.length}`);
            }
        } catch (error) {
            logger.error("Failed to update account info:", error);
            throw error;
        }
    }

    // Fetches historical data for all required timeframes for a symbol.
    // Returns D1, H4, and H1 data objects.
    async fetchHistoricalData(symbol) {
        const timeframes = [ANALYSIS.TIMEFRAMES.D1, ANALYSIS.TIMEFRAMES.H4, ANALYSIS.TIMEFRAMES.H1];

        const count = 200; // Fetch enough candles for EMA200
        const delays = [1000, 1000, 1000];
        const results = [];

        for (let i = 0; i < timeframes.length; i++) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, delays[i - 1]));
            try {
                const data = await getHistorical(symbol, timeframes[i], count);
                if (!data || !data.prices || data.prices.length === 0) {
                    logger.warn(`[fetchHistoricalData] No data for ${symbol} ${timeframes[i]}`);
                } else {
                    logger.info(`[fetchHistoricalData] Fetched ${data.prices.length} bars for ${symbol} ${timeframes[i]}`);
                }
                results.push(data);
            } catch (err) {
                logger.error(`[fetchHistoricalData] Error fetching ${symbol} ${timeframes[i]}:`, err);
                results.push(null);
            }
        }

        // logger.info("Result data:", JSON.stringify(results, null, 2));

        return {
            d1Data: results[0],
            h4Data: results[1],
            h1Data: results[2],
        };
    }

    // Analyzes a single symbol: fetches data, calculates indicators, and triggers trading logic.
    async analyzeSymbol(symbol) {
        logger.info(`\n\n=== Processing ${symbol} ===`);
        const { d1Data, h4Data, h1Data } = await this.fetchHistoricalData(symbol);
        // console.log("d1Data", d1Data, "h4Data", h4Data, "h1Data", h1Data);

        const indicators = {
            d1: await calcIndicators(d1Data.prices), // Daily trend direction
            h4: await calcIndicators(h4Data.prices), // Trend direction
            h1: await calcIndicators(h1Data.prices), // Setup confirmation
        };

        // console.log(indicators);

        const trendAnalysis = {
            d1Trend: indicators.d1.isBullishTrend ? "bullish" : "bearish",
            h4Trend: indicators.h4.isBullishTrend ? "bullish" : "bearish",
        };
        // logger.info(`Trend analysis for ${symbol}: D1 - ${trendAnalysis.d1Trend}, H4 - ${trendAnalysis.h4Trend}`);

        // Use the latest real-time merged candle for bid/ask
        const latestCandle = this.latestCandles[symbol]?.latest;
        // console.log("latestCandle", latestCandle);

        if (!latestCandle) {
            logger.info(`[Bot] No latest candle for ${symbol}, skipping analysis.`);
            return;
        }
        await tradingService.processPrice({
            ...latestCandle,
            symbol: symbol,
            indicators,
            trendAnalysis,
            d1Data: d1Data.prices,
            h4Data: h4Data.prices,
            h1Data: h1Data.prices,
        });

        // Store the latest candles for history
        const currentHistory = this.candleHistory[symbol] || [];
        currentHistory.push(latestCandle);
        // Keep only the last N candles
        if (currentHistory.length > this.maxCandleHistory) {
            currentHistory.shift();
        }
        this.candleHistory[symbol] = currentHistory;
    }

    // Analyzes all symbols in the trading universe.
    async analyzeAllSymbols() {
        for (const symbol of SYMBOLS) {
            if (!this.latestCandles[symbol]?.latest) continue;
            try {
                await this.analyzeSymbol(symbol);
            } catch (error) {
                logger.error(`Error analyzing ${symbol}:`, error.message);
            }
        }
    }

    /**
     * Cleanly shuts down the bot and all intervals/connections.
     */
    async shutdown() {
        this.isRunning = false;
        clearInterval(this.analysisInterval);
        clearInterval(this.sessionRefreshInterval);
        webSocketService.disconnect();
    }

    startMonitorOpenTrades() {
        logger.info("\n\n[Monitoring] Starting open trade monitor interval (every 1 minute)");
        this.monitorInterval = setInterval(async () => {
            logger.info(`[Monitoring] Checking open trades at ${new Date().toISOString()}`);
            try {
                const latestIndicatorsBySymbol = {};
                for (const symbol of TRADING.SYMBOLS) {
                    const history = this.candleHistory[symbol] || [];
                    logger.info(`[Monitoring] Symbol: ${symbol}, history length: ${history.length}`);
                    if (history.length > 5) {
                        // calculate indicators
                        latestIndicatorsBySymbol[symbol] = await calcIndicators(history, symbol);
                        logger.info(`[Monitoring] Calculated indicators for ${symbol}`);
                    } else {
                        logger.warn(`[Monitoring] Not enough candle history for ${symbol} to calculate indicators (have ${history.length})`);
                        latestIndicatorsBySymbol[symbol] = {};
                    }
                }
                await tradingService.monitorOpenTrades(latestIndicatorsBySymbol);
                // --- Log trades every hour ---
                if (!this._lastTradeLogTime || Date.now() - this._lastTradeLogTime > 59.5 * 60 * 1000) {
                    await logTradeSnapshot(latestIndicatorsBySymbol, getOpenPositions);
                    this._lastTradeLogTime = Date.now();
                }
                logger.info("[Monitoring] monitorOpenTrades completed");
            } catch (error) {
                logger.error("[Bot] Error in monitorOpenTrades:", error);
            }
        }, 1 * 60 * 1000); // every 1 min
    }

    /**
     * Schedules a session refresh at midnight every day.
     */
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
            logger.error("[Bot] Midnight session refresh failed:", error);
        }
    }
}

// Create and start the bot
const bot = new TradingBot();
bot.initialize().catch((error) => {
    logger.error("Bot initialization failed:", error);
    process.exit(1);
});
