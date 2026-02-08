import { getOpenPositions, getHistorical } from "../api.js";
import { ANALYSIS, CRYPTO_SYMBOLS, LIVE_MANAGEMENT, RISK } from "../config.js";
import { calcIndicators } from "../indicators/indicators.js";
import tradingService from "../services/trading.js";
import { logTradeManagementEvent, tradeTracker } from "../utils/tradeLogger.js";
import logger from "../utils/logger.js";

const { TIMEFRAMES } = ANALYSIS;
const EPSILON = 1e-9;
const DEFERRED_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const LIVE_INDICATOR_CACHE_TTL_MS = Math.max(LIVE_MANAGEMENT.LOOP_MS * 3, 60 * 1000);

const liveTradeState = new Map();
const deferredCloseLogTimestamps = new Map();
const liveIndicatorCache = new Map();

function toNumber(value) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function normalizeDirection(direction) {
    return String(direction || "").toUpperCase();
}

function isCryptoSymbol(symbol) {
    return CRYPTO_SYMBOLS.includes(String(symbol || "").toUpperCase());
}

function isForexMarketClosedUtc(now = new Date()) {
    const day = now.getUTCDay(); // 0 Sunday, 6 Saturday
    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Weekend close window for FX.
    if (day === 6) return true; // Saturday
    if (day === 0 && currentMinutes < 22 * 60) return true; // Sunday before 22:00 UTC
    if (day === 5 && currentMinutes >= 22 * 60) return true; // Friday after 22:00 UTC

    // Capital.com FX daily maintenance break (Mon-Thu): ~22:00-22:05 UTC.
    if (day >= 1 && day <= 4 && currentMinutes >= 22 * 60 && currentMinutes < 22 * 60 + 5) {
        return true;
    }

    return false;
}

function canManageSymbolNow(symbol, now = new Date()) {
    if (isCryptoSymbol(symbol)) return true; // Crypto is 24/7
    return !isForexMarketClosedUtc(now); // Forex is not tradable over the weekend
}

function shouldLogDeferredClose(dealId, nowMs = Date.now()) {
    const key = String(dealId || "");
    if (!key) return false;

    const last = deferredCloseLogTimestamps.get(key);
    if (!Number.isFinite(last) || nowMs - last >= DEFERRED_LOG_COOLDOWN_MS) {
        deferredCloseLogTimestamps.set(key, nowMs);
        return true;
    }
    return false;
}

function currentMarketPrice(position) {
    const direction = normalizeDirection(position?.direction);
    const bid = toNumber(position?.bid);
    const ask = toNumber(position?.ask);
    if (direction === "BUY") return bid ?? ask;
    if (direction === "SELL") return ask ?? bid;
    return bid ?? ask;
}

function computeRMultiple(direction, entryPrice, stopLoss, currentPrice) {
    const entry = toNumber(entryPrice);
    const stop = toNumber(stopLoss);
    const price = toNumber(currentPrice);
    if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(price)) return null;

    const riskDistance = Math.abs(entry - stop);
    if (!isFiniteNumber(riskDistance) || riskDistance <= 0) return null;

    const dir = normalizeDirection(direction);
    if (dir === "BUY") return (price - entry) / riskDistance;
    if (dir === "SELL") return (entry - price) / riskDistance;
    return null;
}

function buildInitialState() {
    return {
        peakR: -Infinity,
        currentR: 0,
        givebackPct: 0,
        decayCount: 0,
        partialClosed: false,
        last: {
            macdHistM5: null,
            adxM5: null,
            rsiM1: null,
        },
    };
}

function evaluateWeakeningSignals({ direction, indicators, state }) {
    const reasons = [];
    let weakSignals = 0;
    const dir = normalizeDirection(direction);

    const m5Hist = toNumber(indicators?.m5?.macdHist);
    const m5HistPrev = toNumber(state?.last?.macdHistM5);
    if (isFiniteNumber(m5Hist)) {
        const bullishWeak = dir === "BUY" && (m5Hist < 0 || (isFiniteNumber(m5HistPrev) && m5Hist < m5HistPrev));
        const bearishWeak = dir === "SELL" && (m5Hist > 0 || (isFiniteNumber(m5HistPrev) && m5Hist > m5HistPrev));
        if (bullishWeak || bearishWeak) {
            weakSignals += 1;
            reasons.push("MACD_AGAINST_POSITION_M5");
        }
    }

    const m5Adx = toNumber(indicators?.m5?.adxValue);
    const m5AdxPrev = toNumber(state?.last?.adxM5);
    if (isFiniteNumber(m5Adx)) {
        if (m5Adx < LIVE_MANAGEMENT.WEAKENING_ADX_FLOOR) {
            weakSignals += 1;
            reasons.push("ADX_LOW_M5");
        } else if (isFiniteNumber(m5AdxPrev) && m5Adx < m5AdxPrev) {
            weakSignals += 1;
            reasons.push("ADX_DECREASING_M5");
        }
    }

    const m1Rsi = toNumber(indicators?.m1?.rsi);
    const m1RsiPrev = toNumber(state?.last?.rsiM1);
    if (isFiniteNumber(m1Rsi)) {
        const bullishWeak = dir === "BUY" && (m1Rsi <= 50 || (isFiniteNumber(m1RsiPrev) && m1Rsi < m1RsiPrev));
        const bearishWeak = dir === "SELL" && (m1Rsi >= 50 || (isFiniteNumber(m1RsiPrev) && m1Rsi > m1RsiPrev));
        if (bullishWeak || bearishWeak) {
            weakSignals += 1;
            reasons.push("RSI_REVERTING_M1");
        }
    }

    return { weakSignals, reasons };
}

function extractPositionData(rawPosition) {
    const position = rawPosition?.position || rawPosition || {};
    const market = rawPosition?.market || {};

    return {
        dealId: position?.dealId ?? rawPosition?.dealId,
        symbol: market?.epic ?? position?.epic,
        direction: position?.direction,
        size: toNumber(position?.size),
        entryPrice: toNumber(position?.level),
        takeProfit: toNumber(position?.profitLevel),
        stopLoss: toNumber(position?.stopLevel),
        bid: toNumber(market?.bid),
        ask: toNumber(market?.offer ?? market?.ask),
        openTime: position?.openTime ?? position?.createdDateUTC ?? position?.createdDate ?? rawPosition?.openTime,
    };
}

async function getLiveIndicatorsBySymbol(symbol, cycleCache = new Map(), nowMs = Date.now()) {
    if (cycleCache.has(symbol)) return cycleCache.get(symbol);

    const cached = liveIndicatorCache.get(symbol);
    if (cached && nowMs - cached.ts < LIVE_INDICATOR_CACHE_TTL_MS) {
        cycleCache.set(symbol, cached.snapshot);
        return cached.snapshot;
    }

    try {
        const [m5Data, m1Data] = await Promise.all([getHistorical(symbol, TIMEFRAMES.M5, 80), getHistorical(symbol, TIMEFRAMES.M1, 120)]);
        if (!m5Data?.prices || !m1Data?.prices) {
            const empty = { m5: null, m1: null };
            cycleCache.set(symbol, empty);
            return empty;
        }

        const snapshot = {
            m5: await calcIndicators(m5Data.prices),
            m1: await calcIndicators(m1Data.prices),
        };
        liveIndicatorCache.set(symbol, { ts: nowMs, snapshot });
        cycleCache.set(symbol, snapshot);
        return snapshot;
    } catch (error) {
        const reason = error?.response?.data?.errorCode || error?.message || "unknown_error";
        logger.warn(`[Monitoring] Live indicators fetch failed for ${symbol}: ${reason}`);
        const fallback = cached?.snapshot || { m5: null, m1: null };
        cycleCache.set(symbol, fallback);
        return fallback;
    }
}

export async function startMonitorOpenTrades(bot, intervalMs = LIVE_MANAGEMENT.LOOP_MS) {
    if (bot.monitorInterval) {
        logger.debug("[Monitoring] Live management loop already running; skipping restart.");
        return;
    }

    logger.info(`[Monitoring] Starting live management every ${intervalMs}ms at ${new Date().toISOString()}`);
    if (!bot.dealIdMonitorInterval) logDeals(bot);

    bot.monitorInterval = setInterval(async () => {
        if (bot.monitorInProgress) {
            logger.warn("[Monitoring] Previous monitor tick still running; skipping.");
            return;
        }

        bot.monitorInProgress = true;
        try {
            if (bot.analysisInProgress) {
                logger.debug("[Monitoring] Analysis in progress; skipping live management tick.");
                return;
            }

            await runLiveTradeManagementCycle(bot);
            await maxHoldCheck(bot);
        } catch (error) {
            logger.error("[Monitoring] Live management tick failed:", error?.response?.data || error?.message || error);
        } finally {
            bot.monitorInProgress = false;
        }
    }, intervalMs);
}

export async function trailingStopCheck(bot) {
    await runLiveTradeManagementCycle(bot);
}

async function runLiveTradeManagementCycle(bot) {
    if (bot?.analysisInProgress) return;

    logger.info(`[Monitoring] Live trade management tick at ${new Date().toISOString()}`);
    const res = await getOpenPositions();
    const positions = Array.isArray(res?.positions) ? res.positions : [];
    if (!positions.length) {
        liveTradeState.clear();
        liveIndicatorCache.clear();
        return;
    }

    const indicatorCache = new Map();
    const activeDealIds = new Set();
    const activeSymbols = new Set();
    const now = new Date();
    const nowMs = now.getTime();

    for (const rawPosition of positions) {
        try {
            const pos = extractPositionData(rawPosition);
            if (!pos?.dealId || !pos?.symbol) continue;
            activeDealIds.add(String(pos.dealId));
            activeSymbols.add(String(pos.symbol));

            const marketOpen = canManageSymbolNow(pos.symbol, now);
            if (!marketOpen) continue;

            let state = liveTradeState.get(String(pos.dealId));
            if (!state) {
                state = buildInitialState();
                liveTradeState.set(String(pos.dealId), state);
            }

            const indicators = await getLiveIndicatorsBySymbol(pos.symbol, indicatorCache, nowMs);
            if (!indicators?.m5 || !indicators?.m1) continue;

            const currentPrice = currentMarketPrice(pos);
            const currentR = computeRMultiple(pos.direction, pos.entryPrice, pos.stopLoss, currentPrice);
            if (!isFiniteNumber(currentR)) continue;

            const peakR = Math.max(state.peakR, currentR);
            const givebackPct = peakR > EPSILON ? (peakR - currentR) / Math.max(peakR, EPSILON) : 0;

            const weakening = evaluateWeakeningSignals({ direction: pos.direction, indicators, state });
            let decayCount = state.decayCount;
            if (weakening.weakSignals >= 2) decayCount += 1;
            else decayCount = Math.max(0, decayCount - 1);

            let action = "NO_ACTION";
            const reasonCodes = [...weakening.reasons];

            if (
                !state.partialClosed &&
                currentR >= LIVE_MANAGEMENT.PARTIAL_MIN_R &&
                givebackPct >= LIVE_MANAGEMENT.PARTIAL_GIVEBACK_PCT &&
                decayCount >= LIVE_MANAGEMENT.PARTIAL_DECAY_COUNT
            ) {
                const sizeToClose = (toNumber(pos.size) || 0) * LIVE_MANAGEMENT.PARTIAL_CLOSE_FRACTION;
                const partialSuccess = await tradingService.closePartialPosition(pos, sizeToClose, "DECAY_GIVEBACK");
                if (partialSuccess) {
                    action = "PARTIAL_CLOSE";
                    state.partialClosed = true;
                    reasonCodes.push("PARTIAL_CONDITION_MET");
                }
            }

            if (
                action === "NO_ACTION" &&
                state.partialClosed &&
                (decayCount >= LIVE_MANAGEMENT.FULL_CLOSE_AFTER_PARTIAL_DECAY || currentR <= LIVE_MANAGEMENT.FULL_CLOSE_AFTER_PARTIAL_MIN_R)
            ) {
                const closed = await tradingService.closePosition(pos.dealId, "decay_exit");
                if (closed) {
                    action = "FULL_CLOSE";
                    reasonCodes.push("POST_PARTIAL_DECAY_PERSISTED");
                }
            }

            if (
                action === "NO_ACTION" &&
                currentR <= LIVE_MANAGEMENT.EARLY_FULL_CLOSE_MIN_R &&
                decayCount >= LIVE_MANAGEMENT.EARLY_FULL_CLOSE_DECAY_COUNT
            ) {
                const closed = await tradingService.closePosition(pos.dealId, "early_invalidation");
                if (closed) {
                    action = "FULL_CLOSE";
                    reasonCodes.push("EARLY_INVALIDATION");
                }
            }

            if (
                action === "NO_ACTION" &&
                currentR >= LIVE_MANAGEMENT.TIGHTEN_SL_MIN_R &&
                decayCount >= LIVE_MANAGEMENT.TIGHTEN_SL_DECAY_COUNT
            ) {
                const tightened = await tradingService.updateTrailingStopIfNeeded(
                    {
                        ...pos,
                        currentPrice,
                    },
                    {
                        m5: indicators.m5,
                        m15: indicators.m5,
                    },
                );
                if (tightened) {
                    action = "TIGHTEN_SL";
                    reasonCodes.push("TIGHTEN_SL_CONDITION_MET");
                }
            }

            logTradeManagementEvent({
                dealId: pos.dealId,
                symbol: pos.symbol,
                action,
                reasonCodes: reasonCodes.length ? reasonCodes : ["NO_ACTION"],
                metrics: {
                    currentR,
                    peakR,
                    givebackPct,
                    decayCount,
                    partialClosed: Boolean(state.partialClosed),
                    price: currentPrice,
                },
                indicatorsSnapshot: {
                    m5: indicators.m5,
                    m1: indicators.m1,
                },
            });

            state.peakR = peakR;
            state.currentR = currentR;
            state.givebackPct = givebackPct;
            state.decayCount = decayCount;
            state.last = {
                macdHistM5: toNumber(indicators?.m5?.macdHist),
                adxM5: toNumber(indicators?.m5?.adxValue),
                rsiM1: toNumber(indicators?.m1?.rsi),
            };

            if (action === "FULL_CLOSE") {
                liveTradeState.delete(String(pos.dealId));
            } else {
                liveTradeState.set(String(pos.dealId), state);
            }
        } catch (error) {
            logger.error(`[Monitoring] Trade management failed for ${rawPosition?.market?.epic || "UNKNOWN"}:`, error?.response?.data || error?.message || error);
        }
    }

    for (const dealId of [...liveTradeState.keys()]) {
        if (!activeDealIds.has(String(dealId))) {
            liveTradeState.delete(String(dealId));
        }
    }

    for (const symbol of [...liveIndicatorCache.keys()]) {
        if (!activeSymbols.has(String(symbol))) {
            liveIndicatorCache.delete(String(symbol));
        }
    }
}

export async function maxHoldCheck() {
    try {
        const positions = await getOpenPositions();
        if (!positions?.positions?.length) return;

        const nowMs = Date.now();
        const now = new Date();

        for (const raw of positions.positions) {
            const pos = extractPositionData(raw);
            const openMs = parseOpenTimeMs(pos.openTime);
            if (Number.isNaN(openMs)) continue;

            const minutesHeld = Math.max(0, nowMs - openMs) / 60000;
            if (minutesHeld >= RISK.MAX_HOLD_TIME && pos.dealId) {
                if (!canManageSymbolNow(pos.symbol, now)) {
                    if (shouldLogDeferredClose(pos.dealId, nowMs)) {
                        logger.debug(`[Monitoring] Max-hold close deferred for ${pos.symbol} (${pos.dealId}): market closed.`);
                    }
                    continue;
                }
                const closed = await tradingService.closePosition(pos.dealId, "timeout");
                if (closed) {
                    deferredCloseLogTimestamps.delete(String(pos.dealId));
                    liveTradeState.delete(String(pos.dealId));
                    logger.info(`[Monitoring] Closed ${pos.symbol} (${pos.dealId}) by max hold (${minutesHeld.toFixed(1)}min).`);
                } else {
                    logger.warn(`[Monitoring] Max-hold close failed for ${pos.symbol} (${pos.dealId}); will retry next cycle.`);
                }
            }
        }
    } catch (error) {
        logger.error("[Monitoring] Error in max-hold check:", error);
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
            logger.warn("[DealID Monitor] Previous tick still running; skipping.");
            return;
        }
        bot.dealIdMonitorInProgress = true;

        try {
            const res = await getOpenPositions();
            const positions = Array.isArray(res?.positions) ? res.positions : [];

            const brokerDeals = positions
                .map((p) => ({
                    dealId: p?.position?.dealId ?? p?.dealId,
                    symbol: p?.market?.epic ?? p?.position?.epic,
                }))
                .filter((x) => x?.dealId);

            const brokerDealIds = brokerDeals.map((d) => d.dealId);

            for (const { dealId, symbol } of brokerDeals) {
                if (!bot.openedBrockerDealIds.includes(dealId)) {
                    bot.openedBrockerDealIds.push(dealId);
                    tradeTracker.registerOpenBrockerDeal(dealId, symbol);
                }
            }

            const closedDealIds = bot.openedBrockerDealIds.filter((id) => !brokerDealIds.includes(id));
            bot.openedBrockerDealIds = bot.openedBrockerDealIds.filter((id) => brokerDealIds.includes(id));

            if (closedDealIds.length) {
                await tradeTracker.reconcileClosedDeals(closedDealIds);
                for (const id of closedDealIds) liveTradeState.delete(String(id));
            }
        } catch (error) {
            logger.error("[DealID Monitor] Error:", error);
        } finally {
            bot.dealIdMonitorInProgress = false;
        }
    };

    run();
    bot.dealIdMonitorInterval = setInterval(run, bot.checkInterval);
}

function parseOpenTimeMs(openTime) {
    if (!openTime && openTime !== 0) return NaN;
    if (typeof openTime === "number") return openTime < 1e12 ? openTime * 1000 : openTime;

    if (typeof openTime === "string") {
        let s = openTime.trim();
        if (/^\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
            s = s.replace(" ", "T").replace(/\//g, "-");
        }
        if (!/[zZ]|[+\-]\d{2}:\d{2}$/.test(s)) s += "Z";
        const t = Date.parse(s);
        return Number.isNaN(t) ? NaN : t;
    }

    return NaN;
}
