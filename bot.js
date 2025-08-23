import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens, refreshSession, getMarketDetails } from "./api.js";
import { TRADING, DEV, PROD, ANALYSIS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators, analyzeTrend } from "./indicators.js";
import logger from "./utils/logger.js";

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
        this.tradingHours = { start: 2, end: 22 };
    }

    async initialize() {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await startSession();
                const tokens = getSessionTokens();
                if (!tokens.cst || !tokens.xsecurity) throw new Error("Invalid session tokens");
                await this.startLiveTrading();
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
            // this.setupWebSocket(tokens); // just for 15, 5, 1 minute candles
            this.startSessionPing();

            this.startAnalysisInterval();

            this.isRunning = true;
        } catch (error) {
            logger.error("[bot.js][Bot] Error starting live trading:", error);
            throw error;
        }
    }

    // WebSocket connection is just for 15, 5, 1 minute candles
    // setupWebSocket(tokens) {
    //     webSocketService.connect(tokens, SYMBOLS, (data) => {
    //         try {
    //             const message = JSON.parse(data.toString());

    //             if (message.payload?.epic) {
    //                 const candle = message.payload;
    //                 const symbol = candle.epic;
    //                 // Just store the latest candle for each symbol
    //                 this.latestCandles[symbol] = { latest: candle };
    //             }
    //         } catch (error) {
    //             logger.error("[bot.js] WebSocket message processing error:", error.message, data?.toString());
    //         }
    //     });
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
        const interval = DEV.MODE ? DEV.INTERVAL : PROD.INTERVAL;
        logger.info(`[${DEV.MODE ? "DEV" : "PROD"}] Setting up analysis interval: ${interval}ms`);

        this.analysisInterval = setInterval(async () => {
            try {
                // if (!this.isTradingAllowed()) {
                //     logger.info("[Bot] Skipping analysis: Trading not allowed at this time.");
                //     return;
                // }

                await this.updateAccountInfo();
                await this.analyzeAllSymbols();

                if (this.monitorInterval) {
                    clearInterval(this.monitorInterval);
                    this.monitorInterval = null;
                }

                this.startMonitorOpenTrades();
            } catch (error) {
                logger.error("[bot.js] Analysis interval error:", error);
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
                    logger.error("[bot.js] Failed to update account info after all retries:", error);
                    // Don't throw - just continue with old values
                    return;
                }
                logger.warn(`Account info update failed, retrying... (${retries} attempts left)`);
                await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
        }
    }

    // Analyzes all symbols in the trading universe.
    async analyzeAllSymbols() {
        for (const symbol of SYMBOLS) {
            await this.analyzeSymbol(symbol);
            await this.delay(2000); // Add at least 1 second delay between symbols
        }
    }

    // Analyzes a single symbol: fetches data, calculates indicators, and triggers trading logic.
    async analyzeSymbol(symbol) {
        logger.info(`\n\n=== Processing ${symbol} ===`);

        // Fetch latest historical data for each timeframe
        // const d1Data = await getHistorical(symbol, "DAY", this.maxCandleHistory);
        // await this.delay(500);
        // const h4Data = await getHistorical(symbol, "HOUR_4", this.maxCandleHistory);
        // await this.delay(500);
        const h1Data = await getHistorical(symbol, "HOUR", this.maxCandleHistory);
        await this.delay(500);
        const m15Data = await getHistorical(symbol, "MINUTE_15", this.maxCandleHistory);
        await this.delay(500);
        const m5Data = await getHistorical(symbol, "MINUTE_5", this.maxCandleHistory);
        await this.delay(500);
        const m1Data = await getHistorical(symbol, "MINUTE", this.maxCandleHistory);

        // Overwrite candle history with fresh data
        this.candleHistory[symbol] = {
            // D1: d1Data.prices.slice(-this.maxCandleHistory) || [],
            // H4: h4Data.prices.slice(-this.maxCandleHistory) || [],
            H1: h1Data.prices.slice(-this.maxCandleHistory) || [],
            M15: m15Data.prices.slice(-this.maxCandleHistory) || [],
            M5: m5Data.prices.slice(-this.maxCandleHistory) || [],
            M1: m1Data.prices.slice(-this.maxCandleHistory) || [],
        };

        // const d1Candles = this.candleHistory[symbol].D1;
        // const h4Candles = this.candleHistory[symbol].H4;
        const h1Candles = this.candleHistory[symbol].H1;
        const m15Candles = this.candleHistory[symbol].M15;
        const m5Candles = this.candleHistory[symbol].M5;
        const m1Candles = this.candleHistory[symbol].M1;

        if (!h1Candles || !m15Candles || !m5Candles || !m1Candles) {
            logger.error(`[bot.js][analyzeSymbol] Incomplete candle data for ${symbol} (H1: ${!!h1Candles}, M15: ${!!m15Candles}, M5: ${!!m5Candles}, M1: ${!!m1Candles}), skipping analysis.`);
            return;
        }

        const indicators = {
            // d1: await calcIndicators(d1Candles, symbol, ANALYSIS.TIMEFRAMES.D1),
            // h4: await calcIndicators(h4Candles, symbol, ANALYSIS.TIMEFRAMES.H4),
            h1: await calcIndicators(h1Candles, symbol, ANALYSIS.TIMEFRAMES.H1),
            m15: await calcIndicators(m15Candles, symbol, ANALYSIS.TIMEFRAMES.M15),
            m5: await calcIndicators(m5Candles, symbol, ANALYSIS.TIMEFRAMES.M5),
            m1: await calcIndicators(m1Candles, symbol, ANALYSIS.TIMEFRAMES.M1),
        };

        const trendAnalysis = await analyzeTrend(symbol, getHistorical);

        // --- Fetch real-time bid/ask ---
        const marketDetails = await getMarketDetails(symbol);
        const bid = marketDetails?.snapshot?.bid;
        const ask = marketDetails?.snapshot?.offer;

        // Pass bid/ask to trading logic
        await tradingService.processPrice({
            symbol,
            indicators,
            trendAnalysis,
            h1Candles: h1Candles,
            m15Candles: m15Candles,
            m5Candles: m5Candles,
            m1Candles: m1Candles,
            bid,
            ask,
        });
    }

    async shutdown() {
        this.isRunning = false;
        clearInterval(this.analysisInterval);
        clearInterval(this.sessionRefreshInterval);
        webSocketService.disconnect();
    }

    startMonitorOpenTrades() {
        const interval = 30 * 1000;
        logger.info("\n\n[Monitoring] Starting open trade monitor interval (every 30 seconds)");
        this.monitorInterval = setInterval(async () => {
            logger.info(`[Monitoring] Checking open trades at ${new Date().toISOString()}`);
            try {
                const positions = await getOpenPositions();
                for (const pos of positions.positions) {
                    console.log("pos", pos);

                    const positionData = {
                        dealId: pos.dealId,
                        direction: pos.position.direction,
                        entryPrice: pos.position.level,
                        takeProfit: pos.position.profitLevel,
                        stopLoss: pos.position.stopLevel,
                        currentPrice: pos.market.bid, // or offer, depending on direction
                    };
                    await tradingService.updateTrailingStopIfNeeded(positionData);
                }
                // logger.info("[Monitoring] monitorOpenTrades completed");
            } catch (error) {
                logger.error("[bot.js][Bot] Error in monitorOpenTrades:", error);
            }
        }, interval); // every 1 min
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

    // Checks if trading is allowed (not weekend, and within trading hours)
    isTradingAllowed() {
        const now = new Date();
        const day = now.getDay(); // 0 = Sunday, 6 = Saturday
        const hour = now.getHours();

        // Block weekends
        if (day === 0 || day === 6) {
            logger.info("[Bot] Trading blocked: Weekend.");
            return false;
        }
        // Block outside trading hours (22:00 - 02:00)
        if (hour < this.tradingHours.start || hour >= this.tradingHours.end) {
            logger.info(`[Bot] Trading blocked: Outside trading hours (${this.tradingHours.start}:00-${this.tradingHours.end}:00).`);
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
