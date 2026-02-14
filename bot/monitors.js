import { getOpenPositions, getHistorical } from "../api.js";
import { RISK, CRYPTO_SYMBOLS } from "../config.js";
import { calcIndicators } from "../indicators/indicators.js";
import tradingService from "../services/trading.js";
import webSocketService from "../services/websocket.js";
import { tradeWatchIndicators } from "../indicators/indicators.js";

import { tradeTracker } from "../utils/tradeLogger.js";
import logger from "../utils/logger.js";
import { priceLogger } from "../utils/priceLogger.js";

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
            await maxHoldCheck(bot);
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
            if (CRYPTO_SYMBOLS.includes(symbol)) {
                logger.info(`[Rollover] Skip close for crypto ${symbol}.`);
                continue;
            }
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
                currentPrice: pos.market.bid,
                trailingStop: pos.position.trailingStop,
            };

            await tradingService.updateTrailingStopIfNeeded(positionData, indicators);
        }
    } catch (error) {
        logger.error("[bot.js][Bot] Error in monitorOpenTrades:", error);
    }
}

export async function maxHoldCheck(bot) {
    try {
        const positions = await getOpenPositions();
        if (!positions?.positions?.length) return;

        const nowMs = Date.now();

        for (const pos of positions.positions) {
            const openRaw = pos?.position?.openTime ?? pos?.position?.createdDateUTC ?? pos?.position?.createdDate ?? pos?.openTime;

            logger.debug(`[Bot] Position ${pos?.market?.epic} - Open Time raw: ${openRaw}`);

            const openMs = parseOpenTimeMs(openRaw);

            if (Number.isNaN(openMs)) {
                logger.error(`[Bot] Could not parse open time for ${pos?.market?.epic}: ${openRaw}`);
                continue;
            }

            const heldMs = Math.max(0, nowMs - openMs);
            const minutesHeld = heldMs / 60000;

            logger.debug(`[Bot] Position ${pos?.market?.epic} held for ${minutesHeld.toFixed(2)} minutes of max ${RISK.MAX_HOLD_TIME}`);

            if (minutesHeld >= RISK.MAX_HOLD_TIME) {
                const dealId = pos?.position?.dealId ?? pos?.dealId;
                if (!dealId) {
                    logger.error(`[Bot] Missing dealId for ${pos?.market?.epic}, cannot close.`);
                    continue;
                }
                await tradingService.closePosition(dealId, "timeout");
                logger.info(`[Bot] Closed position ${pos?.market?.epic} after ${minutesHeld.toFixed(1)} minutes (max hold: ${RISK.MAX_HOLD_TIME})`);
            }
        }
    } catch (error) {
        logger.error("[Bot] Error in max hold monitor:", error);
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

function parseOpenTimeMs(openTime) {
    if (!openTime && openTime !== 0) return NaN;

    if (typeof openTime === "number") {
        return openTime < 1e12 ? openTime * 1000 : openTime;
    }

    if (typeof openTime === "string") {
        let s = openTime.trim();

        if (/^\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
            s = s.replace(" ", "T").replace(/\//g, "-");
        }

        if (!/[zZ]|[+\-]\d{2}:\d{2}$/.test(s)) {
            s += "Z";
        }

        const t = Date.parse(s);
        return Number.isNaN(t) ? NaN : t;
    }

    return NaN;
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
            await priceLogger.logSnapshotsForSymbols(bot.activeSymbols);
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
