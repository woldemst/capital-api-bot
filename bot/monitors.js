import { getOpenPositions, getHistorical } from "../api.js";
import { SESSIONS, LIVE_SYMBOLS, PRICE_LOGGER as PRICE_LOGGER_CONFIG } from "../config.js";
import { calcIndicators } from "../indicators/indicators.js";
import tradingService from "../services/trading.js";
import webSocketService from "../services/websocket.js";
import { tradeWatchIndicators } from "../indicators/indicators.js";

import { tradeTracker } from "../utils/tradeLogger.js";
import logger from "../utils/logger.js";
import { priceLogger } from "../utils/priceLogger.js";

const LIVE_SYMBOL_ALLOWLIST = new Set(
    (Array.isArray(LIVE_SYMBOLS) ? LIVE_SYMBOLS : [])
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter(Boolean),
);

function isLiveSymbolEnabled(symbol) {
    if (!LIVE_SYMBOL_ALLOWLIST.size) return true;
    return LIVE_SYMBOL_ALLOWLIST.has(String(symbol || "").toUpperCase());
}

function getConfiguredForexSymbols() {
    const set = new Set();
    for (const [sessionName, session] of Object.entries(SESSIONS || {})) {
        if (String(sessionName).toUpperCase() === "CRYPTO") continue;
        for (const symbol of session?.SYMBOLS || []) {
            const normalized = String(symbol || "").toUpperCase();
            if (normalized && isLiveSymbolEnabled(normalized)) set.add(normalized);
        }
    }
    return [...set];
}

function isForexMarketOpenUtc(now = new Date()) {
    const day = now.getUTCDay(); // 0=Sun, 6=Sat
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const sundayOpenMinutes = 22 * 60;
    const fridayCloseMinutes = 22 * 60;

    if (day === 6) return false; // Saturday closed
    if (day === 0) return currentMinutes >= sundayOpenMinutes; // Sunday opens late UTC
    if (day === 5) return currentMinutes < fridayCloseMinutes; // Friday closes late UTC
    return true; // Monday-Thursday
}

function getPriceLoggingSymbols(now = new Date()) {
    return isForexMarketOpenUtc(now) ? getConfiguredForexSymbols() : [];
}

export async function startMonitorOpenTrades(bot, intervalMs = 20 * 1000) {
    logger.info(`[Monitoring] Checking open trades at ${new Date().toISOString()}`);
    if (bot.monitorInterval) clearInterval(bot.monitorInterval);
    if (!bot.dealIdMonitorInterval) logDeals(bot);

    bot.monitorInterval = setInterval(async () => {
        if (bot.monitorInProgress) {
            logger.warn("[Monitoring] Previous monitor tick still running; skipping.");
            return;
        }

        bot.monitorInProgress = true;
        try {
            await trailingStopCheck(bot);
            await bot.delay(3000);
            await rolloverCloseCheck(bot);
            await bot.delay(3000);
        } finally {
            bot.monitorInProgress = false;
        }
    }, intervalMs);
}

export async function rolloverCloseCheck(bot) {
    const now = new Date();
    const timeZone = bot.rolloverTimeZone || "America/New_York";
    const rolloverMinutes = (bot.rolloverHour ?? 17) * 60 + (bot.rolloverMinute ?? 0);
    const bufferMinutes = bot.rolloverBufferMinutes ?? 10;
    const currentMinutes = getMinutesInTimeZone(timeZone, now);
    const inBuffer = currentMinutes >= rolloverMinutes - bufferMinutes && currentMinutes < rolloverMinutes;

    if (!inBuffer) return;

    const dateKey = getDateKeyInTimeZone(timeZone, now);
    if (bot.lastRolloverCloseKey === dateKey) return;
    bot.lastRolloverCloseKey = dateKey;

    try {
        const positions = await getOpenPositions();
        if (!positions?.positions?.length) {
            logger.info("[Rollover] No open positions to close.");
            return;
        }

        for (const pos of positions.positions) {
            const dealId = pos?.position?.dealId ?? pos?.dealId;
            const symbol = pos?.market?.epic ?? pos?.position?.epic ?? "unknown";
            if (!dealId) {
                logger.warn(`[Rollover] Missing dealId for ${symbol}, cannot close.`);
                continue;
            }
            await tradingService.closePosition(dealId, "rollover");
            logger.info(`[Rollover] Closed ${symbol} ahead of rollover (${timeZone}).`);
        }
    } catch (error) {
        logger.error("[Rollover] Error during rollover close check:", error);
    }
}

export async function trailingStopCheck(bot) {
    try {
        const positions = await getOpenPositions();
        const openCount = positions?.positions?.length || 0;
        logger.info(`[Monitoring] Trailing stop check at ${new Date().toISOString()} | open positions: ${openCount}`);
        if (!openCount) return;
        for (const pos of positions.positions) {
            const symbol = pos.market ? pos.market.epic : pos.position.epic;
            const dealId = pos?.position?.dealId ?? pos?.dealId;

            let indicators;
            try {
                const [m15Data, m5Data] = await Promise.all([getHistorical(symbol, "MINUTE_15", 50), getHistorical(symbol, "MINUTE_5", 50)]);
                if (!m15Data?.prices || !m5Data?.prices) {
                    logger.warn(`[Monitoring] Missing candles for ${symbol}, skipping trailing stop update.`);
                    continue;
                }
                indicators = {
                    m15: await calcIndicators(m15Data.prices),
                    m5: await calcIndicators(m5Data.prices),
                };
            } catch (error) {
                logger.warn(`[Monitoring] Failed to fetch indicators for ${symbol}: ${error.message}`);
                continue;
            }

            const positionData = {
                symbol,
                dealId: pos.position.dealId,
                currency: pos.position.currency,
                direction: pos.position.direction,
                size: pos.position.size,
                leverage: pos.position.leverage,
                entryPrice: pos.position.level,
                takeProfit: pos.position.profitLevel,
                stopLoss: pos.position.stopLevel,
                currentPrice:
                    String(pos.position.direction || "").toUpperCase() === "SELL"
                        ? (pos.market.offer ?? pos.market.ask ?? pos.market.bid)
                        : (pos.market.bid ?? pos.market.offer ?? pos.market.ask),
                trailingStop: pos.position.trailingStop,
            };

            await tradingService.updateTrailingStopIfNeeded(positionData, indicators);
        }
    } catch (error) {
        logger.error("[bot.js][Bot] Error in monitorOpenTrades:", error);
    }
}

export function logDeals(bot) {
    if (bot.dealIdMonitorInterval) {
        logger.warn("[DealID Monitor] Already running; skipping start.");
        return;
    }
    logger.info(`[DealID Monitor] Starting (every ${bot.checkInterval}ms)`);

    const run = async () => {
        if (bot.dealIdMonitorInProgress) {
            logger.debug("[DealID Monitor] Previous tick still running; skipping.");
            return;
        }
        bot.dealIdMonitorInProgress = true;
        const tickTs = new Date().toISOString();

        try {
            const res = await getOpenPositions();
            const positions = Array.isArray(res?.positions) ? res.positions : [];

            const brokerDeals = positions
                .map((p) => ({
                    dealId: p?.position?.dealId ?? p?.dealId,
                    symbol: p?.market?.epic ?? p?.position?.epic,
                }))
                .filter(Boolean);

            const brokerDealIds = brokerDeals.map((d) => d.dealId);
            const newlyOpened = [];

            for (const { dealId, symbol } of brokerDeals) {
                if (!bot.openedBrockerDealIds.includes(dealId)) {
                    bot.openedBrockerDealIds.push(dealId);
                    tradeTracker.registerOpenBrockerDeal(dealId, symbol);
                    newlyOpened.push(`${symbol || "unknown"}:${dealId}`);
                }
            }

            const closedDealIds = bot.openedBrockerDealIds.filter((id) => !brokerDealIds.includes(id));

            bot.openedBrockerDealIds = bot.openedBrockerDealIds.filter((id) => brokerDealIds.includes(id));

            const openCount = bot.openedBrockerDealIds.length;
            logger.info(`[DealID Monitor] tick ${tickTs} | openNow=${openCount}`);

            if (newlyOpened.length || closedDealIds.length) {
                const openedText = newlyOpened.length ? `opened=${newlyOpened.join(", ")}` : "opened=none";
                const closedText = closedDealIds.length ? `closed=${closedDealIds.join(", ")}` : "closed=none";
                logger.info(`[DealID Monitor] ${openedText} | ${closedText} | openNow=${openCount}`);
            }

            if (closedDealIds.length) {
                await tradeTracker.reconcileClosedDeals(closedDealIds);
                closedDealIds.length = 0;
            }
            return [];
        } catch (error) {
            logger.error("[DealID Monitor] Error:", error);
            return [];
        } finally {
            bot.dealIdMonitorInProgress = false;
        }
    };

    run();
    bot.dealIdMonitorInterval = setInterval(run, bot.checkInterval);
}

function getMinutesInTimeZone(timeZone, date = new Date()) {
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

function getDateKeyInTimeZone(timeZone, date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

export function startPriceMonitor(bot) {
    if (!PRICE_LOGGER_CONFIG?.ENABLED) {
        logger.info("[PriceMonitor] Disabled (PRICE_LOGGER_ENABLED is false).");
        if (bot.priceMonitorInterval) clearInterval(bot.priceMonitorInterval);
        return;
    }
    const interval = (60 - new Date().getUTCSeconds()) * 1000 - new Date().getUTCMilliseconds() + 1000;
    logger.info(`[PriceMonitor] Starting (every 1 minute) after ${interval}ms at ${new Date().toISOString()}`);
    if (bot.priceMonitorInterval) clearInterval(bot.priceMonitorInterval);

    const run = async () => {
        if (bot.priceMonitorInProgress) {
            logger.warn("[PriceMonitor] Previous tick still running; skipping.");
            return;
        }
        bot.priceMonitorInProgress = true;
        try {
            const symbolsToLog = getPriceLoggingSymbols(new Date());
            if (!symbolsToLog.length) {
                logger.debug("[PriceMonitor] No symbols scheduled for this tick.");
                return;
            }
            logger.debug(`[PriceMonitor] Logging ${symbolsToLog.length} symbols: ${symbolsToLog.join(", ")}`);
            await priceLogger.logSnapshotsForSymbols(symbolsToLog);
        } finally {
            bot.priceMonitorInProgress = false;
        }
    };

    setTimeout(() => {
        run();
        bot.priceMonitorInterval = setInterval(run, 60 * 1000);
    }, interval);
}

export async function startWebSocket(bot) {
    try {
        const activeSymbols = await bot.getActiveSymbols();
        // Initialize price tracker for all active symbols
        bot.latestPrices = {};
        activeSymbols.forEach((symbol) => {
            bot.latestPrices[symbol] = { analyzeSymbol: null, ask: null, ts: null };
        });

        webSocketService.connect(bot.tokens, activeSymbols, (data) => {
            const msg = JSON.parse(data.toString());
            const { payload } = msg;
            const epic = payload?.epic;
            if (!epic) return;

            bot.latestCandles[epic] = { latest: payload };

            // Update bid or ask based on priceType
            if (!bot.latestPrices[epic]) {
                bot.latestPrices[epic] = { bid: null, ask: null, ts: null };
            }

            if (payload.priceType === "bid") {
                bot.latestPrices[epic].bid = payload.c;
            } else if (payload.priceType === "ask") {
                bot.latestPrices[epic].ask = payload.c;
            }

            bot.latestPrices[epic].ts = Date.now();
            // Only log when we have both bid and ask
            if (bot.latestPrices[epic].bid !== null && bot.latestPrices[epic].ask !== null) {
                logger.debug(`[WebSocket] ${epic} - bid: ${bot.latestPrices[epic].bid}, ask: ${bot.latestPrices[epic].ask}`);
            }
        });
    } catch (error) {
        logger.error("[bot.js] WebSocket message processing error:", error.message);
    }
}
