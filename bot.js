import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens, refreshSession } from "./api.js";
import { TRADING, DEV, PROD, ANALYSIS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";
import { logTradeSnapshot } from "./utils/tradeLogger.js";

const { SYMBOLS } = TRADING;

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
        this.openedPositions = {}; // Track opened positions
    }

    // Initializes the bot, handles session retries, and starts trading or backtest mode.
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

                this.scheduleMidnightSessionRefresh();

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

    // Starts live trading mode: sets up WebSocket, session ping, analysis, and trade monitoring.
    async startLiveTrading(tokens) {
        try {
            // 1. Setup basic services
            this.setupWebSocket(tokens);
            this.startSessionPing();

            // 2. Initialize data
            await this.initializeCandleHistory();

            // // 3. Run immediate analysis
            // logger.info("[Bot] Running immediate analysis...");
            // await this.updateAccountInfo();
            // await this.analyzeAllSymbols();

            // 4. Only after immediate analysis, start the intervals
            await this.startAnalysisInterval();

            this.isRunning = true;
        } catch (error) {
            logger.error("[Bot] Error starting live trading:", error);
            throw error;
        }
    }

    async initializeCandleHistory() {
        for (const symbol of SYMBOLS) {
            try {
                const { h1Data, h4Data, d1Data } = await this.fetchHistoricalData(symbol);

                this.candleHistory[symbol] = {
                    H1: h1Data?.prices?.slice(-this.maxCandleHistory) || [],
                    H4: h4Data?.prices?.slice(-this.maxCandleHistory) || [],
                    D1: d1Data?.prices?.slice(-this.maxCandleHistory) || [],
                };
                logger.info(
                    `[Bot] Initialized candle history for ${symbol}: H1: ${this.candleHistory[symbol].H1.length}, H4: ${this.candleHistory[symbol].H4.length}, D1: ${this.candleHistory[symbol].D1.length}`
                );
            } catch (error) {
                logger.error(`[Bot] Error initializing candle history for ${symbol}:`, error);
            }
        }
    }

    // Sets up the WebSocket connection for real-time price data.
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

    // Starts the periodic analysis interval for scheduled trading logic.
    async startAnalysisInterval() {
        const interval = DEV.MODE ? DEV.INTERVAL : PROD.INTERVAL;
        logger.info(`[${DEV.MODE ? "DEV" : "PROD"}] Setting up analysis interval: ${interval}ms`);

        this.analysisInterval = setInterval(async () => {
            try {
                logger.info(`[Running scheduled analysis...]`);
                await this.updateAccountInfo();
                await this.analyzeAllSymbols();

                if (this.monitorInterval) {
                    clearInterval(this.monitorInterval);
                    this.monitorInterval = null;
                }

                // if (this.openedPositions && this.openedPositions > 0) {
                //     this.startMonitorOpenTrades();
                // }
            } catch (error) {
                logger.error("Analysis interval error:", error);
            }
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

                    const positions = await getOpenPositions();
                    if (positions?.positions) {
                        tradingService.setOpenTrades(positions.positions.map((p) => p.market.epic));
                        this.openedPositions = positions.positions.length;
                        logger.info(`Current open positions: ${positions.positions.length}`);
                    }
                    return; // Success - exit the method
                }
            } catch (error) {
                retries--;
                if (retries === 0) {
                    logger.error("Failed to update account info after all retries:", error);
                    // Don't throw - just continue with old values
                    return;
                }
                logger.warn(`Account info update failed, retrying... (${retries} attempts left)`);
                await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
        }
    }

    // Fetches historical data for all required timeframes for a symbol.
    // Returns D1, H4, and H1 data objects.
    async fetchHistoricalData(symbol) {
        const timeframes = [ANALYSIS.TIMEFRAMES.D1, ANALYSIS.TIMEFRAMES.H4, ANALYSIS.TIMEFRAMES.H1];

        const count = 70; // Fetch enough candles for EMA50
        const delays = [1000, 1000, 1000];
        const results = [];

        for (let i = 0; i < timeframes.length; i++) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, delays[i - 1]));
            try {
                const data = await getHistorical(symbol, timeframes[i], count);
                if (!data || !data.prices || data.prices.length === 0) {
                    logger.warn(`[fetchHistoricalData] No data for ${symbol} ${timeframes[i]}`);
                } else {
                    // logger.info(`[fetchHistoricalData] Fetched ${data.prices.length} bars for ${symbol} ${timeframes[i]}`);
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

        // Get latest H1 candle for real-time price
        const h1Candles = this.candleHistory[symbol].H1;
        const h4Candles = this.candleHistory[symbol].H4;
        const d1Candles = this.candleHistory[symbol].D1;

        if (!h1Candles || !h4Candles || !d1Candles) {
            logger.warn(`[${symbol}] No candle data available`);    
            return;
        }

        // Get latest real-time candle
        const latestCandle = this.latestCandles[symbol]?.latest;
        if (!latestCandle) {
            logger.info(`[Bot] No latest candle for ${symbol}, skipping analysis.`);
            return;
        }
        // Calculate trends and indicators
        const indicators = {
            d1Trend: (await calcIndicators(d1Candles, symbol, ANALYSIS.TIMEFRAMES.D1)).trend,
            h4Trend: (await calcIndicators(h4Candles, symbol, ANALYSIS.TIMEFRAMES.H4)).trend,
            h1: await calcIndicators(h1Candles, symbol, ANALYSIS.TIMEFRAMES.H1),
        };

        await tradingService.processPrice({
            symbol,
            indicators,
            h1Candle: latestCandle,
        });

        // Store the latest H1 candle for history
        h1Candles.push(latestCandle);
        if (h1Candles.length > this.maxCandleHistory) {
            h1Candles.shift();
        }
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
                // await tradingService.monitorOpenTrades(latestIndicatorsBySymbol);

                // --- Log trades every hour ---
                // if (!this._lastTradeLogTime || Date.now() - this._lastTradeLogTime > 59.5 * 60 * 1000) {
                //     await logTradeSnapshot(latestIndicatorsBySymbol, getOpenPositions);
                //     this._lastTradeLogTime = Date.now();
                // }
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
