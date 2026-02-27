import { ATR, EMA } from "technicalindicators";

export const CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID = "CRYPTO_LIQUIDITY_WINDOW_MOMENTUM";
export const CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE = "Europe/Berlin";

function toNum(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function safeDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
}

function isoFromMs(tsMs) {
    return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
}

function round(value, decimals = 8) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(decimals));
}

function median(values) {
    const nums = values.filter((v) => Number.isFinite(v));
    if (!nums.length) return null;
    const arr = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function normalizeSide(side) {
    const s = String(side || "").toUpperCase();
    if (s === "BUY" || s === "LONG") return "LONG";
    if (s === "SELL" || s === "SHORT") return "SHORT";
    return null;
}

export function parseHhMmToMinutes(hhmm) {
    if (typeof hhmm !== "string") return null;
    const [hRaw, mRaw] = hhmm.split(":");
    const h = Number(hRaw);
    const m = Number(mRaw);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
}

function formatHhMm(minutes) {
    if (!Number.isFinite(minutes)) return null;
    const m = ((Math.floor(minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${hh}:${mm}`;
}

function getZonedParts(timestamp, timeZone = CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE) {
    const d = safeDate(timestamp);
    if (!d) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(d);
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? "";
    const year = Number(pick("year"));
    const month = Number(pick("month"));
    const day = Number(pick("day"));
    const hour = Number(pick("hour"));
    const minute = Number(pick("minute"));
    const second = Number(pick("second"));
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    return { year, month, day, hour, minute, second };
}

export function getMinutesInTimeZone(timestamp, timeZone = CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE) {
    const parts = getZonedParts(timestamp, timeZone);
    if (!parts) return null;
    return parts.hour * 60 + parts.minute;
}

export function getDateKeyInTimeZone(timestamp, timeZone = CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE) {
    const parts = getZonedParts(timestamp, timeZone);
    if (!parts) return null;
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isMinuteInWindow(currentMinutes, startMinutes, endMinutes, { inclusiveEnd = false } = {}) {
    if (!Number.isFinite(currentMinutes) || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
    }
    return currentMinutes >= startMinutes || (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
}

export function evaluateLiquidityWindowGate({
    timestamp,
    timeZone = CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE,
    windowStart = "14:00",
    windowEnd = "20:00",
} = {}) {
    const minutes = getMinutesInTimeZone(timestamp, timeZone);
    const startMinutes = parseHhMmToMinutes(windowStart);
    const endMinutes = parseHhMmToMinutes(windowEnd);
    const withinWindow = isMinuteInWindow(minutes, startMinutes, endMinutes);
    return {
        timeZone,
        windowStart,
        windowEnd,
        windowStartMinutes: startMinutes,
        windowEndMinutes: endMinutes,
        currentMinutes: minutes,
        withinWindow,
        windowGatePassed: withinWindow,
    };
}

function parseCandleTimestamp(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === "") return null;
    if (typeof rawValue === "number") {
        const d = new Date(rawValue);
        return Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    const raw = String(rawValue).trim();
    if (!raw) return null;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;

    const igUtc = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (igUtc) {
        const [, y, m, d, hh, mm, ss = "00"] = igUtc;
        const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
        const ts = Date.parse(iso);
        return Number.isFinite(ts) ? ts : null;
    }
    return null;
}

export function normalizeBar(rawBar, { fallbackTsMs = null } = {}) {
    if (!rawBar || typeof rawBar !== "object") return null;

    const close = toNum(rawBar.close ?? rawBar.c ?? rawBar.Close ?? rawBar.closePrice?.bid ?? rawBar.closePrice?.ask);
    const high = toNum(rawBar.high ?? rawBar.h ?? rawBar.High ?? rawBar.highPrice?.bid ?? rawBar.highPrice?.ask);
    const low = toNum(rawBar.low ?? rawBar.l ?? rawBar.Low ?? rawBar.lowPrice?.bid ?? rawBar.lowPrice?.ask);
    const open = toNum(rawBar.open ?? rawBar.o ?? rawBar.Open ?? rawBar.openPrice?.bid ?? rawBar.openPrice?.ask);
    if (![close, high, low].every(Number.isFinite)) return null;

    const volume = toNum(
        rawBar.volume ??
            rawBar.v ??
            rawBar.lastTradedVolume ??
            rawBar.lastTradedVolumeValue ??
            rawBar.lastTradeVolume ??
            rawBar.totalVolume,
    );

    const tsMs =
        parseCandleTimestamp(rawBar.timestamp ?? rawBar.t ?? rawBar.snapshotTimeUTC ?? rawBar.snapshotTime ?? rawBar.time ?? rawBar.date) ??
        (Number.isFinite(fallbackTsMs) ? fallbackTsMs : null);

    return {
        t: isoFromMs(tsMs),
        tsMs,
        o: open,
        h: high,
        l: low,
        c: close,
        v: volume,
    };
}

export function normalizeBars(rawBars = [], { dropLast = false } = {}) {
    if (!Array.isArray(rawBars)) return [];
    const source = dropLast && rawBars.length > 0 ? rawBars.slice(0, -1) : rawBars;
    return source.map((bar) => normalizeBar(bar)).filter(Boolean);
}

function emaLast(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const out = EMA.calculate({ period, values });
    return out.length ? out[out.length - 1] : null;
}

function emaSeries(values, period) {
    if (!Array.isArray(values) || values.length < period) return [];
    return EMA.calculate({ period, values });
}

function atrLastFromBars(bars, period = 14) {
    if (!Array.isArray(bars) || bars.length < period + 1) return null;
    const highs = bars.map((b) => b.h);
    const lows = bars.map((b) => b.l);
    const closes = bars.map((b) => b.c);
    const out = ATR.calculate({ period, high: highs, low: lows, close: closes });
    return out.length ? out[out.length - 1] : null;
}

function positiveSlopeForLastDiffs(series, diffCount) {
    if (!Array.isArray(series) || series.length < diffCount + 1) return false;
    for (let i = 0; i < diffCount; i += 1) {
        const idx = series.length - 1 - i;
        const prevIdx = idx - 1;
        if (!(Number.isFinite(series[idx]) && Number.isFinite(series[prevIdx]) && series[idx] - series[prevIdx] > 0)) {
            return false;
        }
    }
    return true;
}

function negativeSlopeForLastDiffs(series, diffCount) {
    if (!Array.isArray(series) || series.length < diffCount + 1) return false;
    for (let i = 0; i < diffCount; i += 1) {
        const idx = series.length - 1 - i;
        const prevIdx = idx - 1;
        if (!(Number.isFinite(series[idx]) && Number.isFinite(series[prevIdx]) && series[idx] - series[prevIdx] < 0)) {
            return false;
        }
    }
    return true;
}

function trWithPrevClose(bar, prevClose) {
    if (!bar || !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) return null;
    if (!Number.isFinite(prevClose)) return Math.abs(bar.h - bar.l);
    return Math.max(Math.abs(bar.h - bar.l), Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
}

export function detectJumpRegime({
    bars5m = [],
    atr14 = null,
    jumpThresholdPct = 0.009,
    jumpAtrMult = 2.5,
    lookbackBars = 12,
    nowTsMs = null,
    cooldownMinutes = 60,
} = {}) {
    const bars = Array.isArray(bars5m) ? bars5m : [];
    if (bars.length < 2) {
        return {
            jumpDetected: false,
            latestJumpTsMs: null,
            jumpMetricUsed: null,
            jumpCooldownRemainingMinutes: 0,
            metrics: [],
        };
    }

    const startIdx = Math.max(1, bars.length - Number(lookbackBars || 12));
    let latestJumpTsMs = null;
    let jumpMetricUsed = null;
    let jumpFound = false;
    const metrics = [];

    for (let i = startIdx; i < bars.length; i += 1) {
        const bar = bars[i];
        const prev = bars[i - 1];
        const prevClose = prev?.c;
        const ret = Number.isFinite(prevClose) && prevClose !== 0 ? (bar.c - prevClose) / prevClose : null;
        const tr = trWithPrevClose(bar, prevClose);
        const byReturn = Number.isFinite(ret) && Math.abs(ret) >= Number(jumpThresholdPct || 0);
        const byAtr = Number.isFinite(tr) && Number.isFinite(atr14) && atr14 > 0 && tr >= Number(jumpAtrMult || 0) * atr14;
        metrics.push({
            tsMs: bar?.tsMs ?? null,
            return5m: ret,
            trueRange: tr,
            byReturn,
            byAtr,
        });

        if (byReturn || byAtr) {
            jumpFound = true;
            latestJumpTsMs = Number.isFinite(bar?.tsMs) ? bar.tsMs : latestJumpTsMs;
            jumpMetricUsed = byReturn && byAtr ? "return5m|trueRangeAtr" : byReturn ? "return5m" : "trueRangeAtr";
        }
    }

    let remaining = 0;
    if (Number.isFinite(latestJumpTsMs) && Number.isFinite(nowTsMs)) {
        const elapsed = (nowTsMs - latestJumpTsMs) / 60000;
        remaining = Math.max(0, Number(cooldownMinutes || 0) - elapsed);
    } else if (jumpFound) {
        remaining = Number(cooldownMinutes || 0);
    }

    return {
        jumpDetected: jumpFound && remaining > 0,
        latestJumpTsMs,
        jumpMetricUsed,
        jumpCooldownRemainingMinutes: remaining,
        metrics,
    };
}

function resolveSymbolConfig(config, symbol) {
    const upper = String(symbol || "").toUpperCase();
    const perSymbol = config?.perSymbolOverrides?.[upper] || {};
    return {
        maxSpreadPct: toNum(perSymbol.maxSpreadPct) ?? toNum(config?.spread?.maxSpreadPctDefault) ?? 0.0012,
        jumpThresholdPct: toNum(perSymbol.jumpThresholdPct) ?? 0.013,
        stopAtrMult: toNum(perSymbol.stopAtrMult) ?? 1.2,
        minStopPct: toNum(perSymbol.minStopPct) ?? 0.0035,
    };
}

function activeRiskProfile(config) {
    const risk = config?.risk || {};
    const profile = String(risk.riskProfile || "normal").toLowerCase() === "aggressive" ? "aggressive" : "normal";
    const riskPct = profile === "aggressive" ? toNum(risk.riskPctAggressive) ?? 0.015 : toNum(risk.riskPctNormal) ?? 0.0035;
    const dailyLossLimitPct =
        profile === "aggressive" ? toNum(risk.dailyLossLimitPctAggressive) ?? 0.03 : toNum(risk.dailyLossLimitPctNormal) ?? 0.01;
    return {
        profile,
        riskPct,
        dailyLossLimitPct,
        maxLeverageCrypto: toNum(risk.maxLeverageCrypto) ?? 2,
    };
}

export function calculateCryptoPositionSizeFromRisk({
    equity,
    entryPrice,
    stopPrice,
    riskPct,
    maxLeverage = 2,
    minSize = 0.1,
    precision = 3,
} = {}) {
    const eq = toNum(equity);
    const entry = toNum(entryPrice);
    const stop = toNum(stopPrice);
    const rp = toNum(riskPct);
    if (![eq, entry, stop, rp].every(Number.isFinite) || eq <= 0 || entry <= 0 || rp <= 0) {
        return {
            size: null,
            riskAmount: null,
            stopDistance: null,
            leverageCapped: false,
        };
    }

    const stopDistance = Math.abs(entry - stop);
    if (!(stopDistance > 0)) {
        return {
            size: null,
            riskAmount: eq * rp,
            stopDistance: 0,
            leverageCapped: false,
        };
    }

    const riskAmount = eq * rp;
    let rawSize = riskAmount / stopDistance;
    let leverageCapped = false;
    const leverageLimit = toNum(maxLeverage);
    if (Number.isFinite(leverageLimit) && leverageLimit > 0) {
        const maxNotional = eq * leverageLimit;
        const maxSizeByLeverage = maxNotional / entry;
        if (Number.isFinite(maxSizeByLeverage) && maxSizeByLeverage > 0 && rawSize > maxSizeByLeverage) {
            rawSize = maxSizeByLeverage;
            leverageCapped = true;
        }
    }

    const minAllowed = Number.isFinite(Number(minSize)) ? Number(minSize) : 0;
    const factor = 10 ** (Number.isInteger(precision) ? precision : 3);
    let size = Math.floor(rawSize * factor) / factor;
    if (size < minAllowed) size = minAllowed;
    if (!(size > 0)) size = null;

    return {
        size,
        riskAmount,
        stopDistance,
        leverageCapped,
    };
}

function selectEntryPrice({ side, bid, ask, fallbackClose }) {
    const s = normalizeSide(side);
    const bidNum = toNum(bid);
    const askNum = toNum(ask);
    if (s === "LONG") return askNum ?? ((Number.isFinite(bidNum) && Number.isFinite(askNum)) ? (bidNum + askNum) / 2 : bidNum ?? fallbackClose ?? askNum);
    if (s === "SHORT") return bidNum ?? ((Number.isFinite(bidNum) && Number.isFinite(askNum)) ? (bidNum + askNum) / 2 : askNum ?? fallbackClose ?? bidNum);
    return fallbackClose ?? ((Number.isFinite(bidNum) && Number.isFinite(askNum)) ? (bidNum + askNum) / 2 : bidNum ?? askNum);
}

function currentExitMarkPrice({ side, bid, ask, mid, fallbackClose }) {
    const s = normalizeSide(side);
    const bidNum = toNum(bid);
    const askNum = toNum(ask);
    const midNum = toNum(mid) ?? (Number.isFinite(bidNum) && Number.isFinite(askNum) ? (bidNum + askNum) / 2 : null);
    if (s === "LONG") return bidNum ?? midNum ?? askNum ?? fallbackClose;
    if (s === "SHORT") return askNum ?? midNum ?? bidNum ?? fallbackClose;
    return midNum ?? bidNum ?? askNum ?? fallbackClose;
}

export function computeStrategyTradeCountersForDay({
    events = [],
    symbol,
    dayKey,
    timeZone = CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE,
} = {}) {
    const targetSymbol = String(symbol || "").toUpperCase();
    let tradesTodayTotal = 0;
    let tradesTodaySymbol = 0;
    let lastExitAtMs = null;

    for (const event of Array.isArray(events) ? events : []) {
        const type = String(event?.type || "").toUpperCase();
        const eventSymbol = String(event?.symbol || "").toUpperCase();
        const tsMs = parseCandleTimestamp(event?.timestamp);
        if (!Number.isFinite(tsMs)) continue;
        const eventDayKey = getDateKeyInTimeZone(tsMs, timeZone);
        if (eventDayKey !== dayKey) continue;

        if (type === "OPEN") {
            tradesTodayTotal += 1;
            if (eventSymbol === targetSymbol) tradesTodaySymbol += 1;
        }
        if (type === "EXIT" && eventSymbol === targetSymbol) {
            if (!Number.isFinite(lastExitAtMs) || tsMs > lastExitAtMs) lastExitAtMs = tsMs;
        }
    }

    return {
        tradesTodayTotal,
        tradesTodaySymbol,
        lastExitAtMs,
    };
}

function buildNoTrade(result, decisionLog, reasonCode) {
    return {
        ...result,
        action: "NO_TRADE",
        reasonCode,
        decisionLog: {
            ...decisionLog,
            decision: "NO_TRADE",
        },
    };
}

function buildManage(result, decisionLog, decision = "MANAGE") {
    return {
        ...result,
        decisionLog: {
            ...decisionLog,
            decision,
        },
    };
}

function normalizeOpenPosition(position = {}) {
    const side = normalizeSide(position.side ?? position.direction ?? position.signal);
    if (!side) return null;
    const entryPrice = toNum(position.entryPrice ?? position.level);
    const currentSl = toNum(position.currentSl ?? position.stopLoss ?? position.stopLevel);
    const takeProfit = toNum(position.takeProfit ?? position.tp ?? position.profitLevel);
    const initialSl = toNum(position.initialSl ?? position.initialStopLoss ?? position.stopLossInitial ?? position.stopLoss ?? position.stopLevel);
    const openedAtTsMs = parseCandleTimestamp(position.entryTimestamp ?? position.openedAt ?? position.openedAtIso ?? position.openedAtMs);

    return {
        dealId: position.dealId ?? null,
        symbol: String(position.symbol || "").toUpperCase(),
        side,
        size: toNum(position.size),
        entryPrice,
        currentSl,
        takeProfit,
        initialSl,
        openedAtTsMs,
        openedAt: isoFromMs(openedAtTsMs),
    };
}

function computeManagementDecision({
    config,
    position,
    bid,
    ask,
    mid,
    nowTsMs,
    atr14,
    fallbackClose,
} = {}) {
    const pos = normalizeOpenPosition(position);
    if (!pos || !Number.isFinite(pos.entryPrice) || !Number.isFinite(pos.initialSl)) {
        return {
            action: "MANAGE",
            manageAction: null,
            exitReason: null,
            rMultiple: null,
            unrealizedR: null,
            currentMark: null,
            holdMinutes: null,
        };
    }

    const currentMark = currentExitMarkPrice({ side: pos.side, bid, ask, mid, fallbackClose });
    const dir = pos.side === "LONG" ? 1 : -1;
    const riskDistance = Math.abs(pos.entryPrice - pos.initialSl);
    const unrealizedR =
        Number.isFinite(currentMark) && riskDistance > 0 ? ((currentMark - pos.entryPrice) * dir) / riskDistance : null;
    const holdMinutes =
        Number.isFinite(pos.openedAtTsMs) && Number.isFinite(nowTsMs) ? Math.max(0, (nowTsMs - pos.openedAtTsMs) / 60000) : null;

    const exits = config?.exits || {};
    const timeStopMinutes = toNum(exits.timeStopMinutes) ?? 120;
    const timeStopMinR = toNum(exits.timeStopMinR) ?? 0.3;
    if (Number.isFinite(holdMinutes) && holdMinutes >= timeStopMinutes && (!Number.isFinite(unrealizedR) || unrealizedR < timeStopMinR)) {
        return {
            action: "EXIT",
            manageAction: null,
            exitReason: "time_stop",
            rMultiple: unrealizedR,
            unrealizedR,
            currentMark,
            holdMinutes,
        };
    }

    const moveStopToBreakevenAtR = toNum(exits.moveStopToBreakevenAtR) ?? 0.8;
    const breakevenBufferR = toNum(exits.breakevenBufferR) ?? 0.05;
    const trailingEnabled = Boolean(exits?.trailing?.enabled);
    const trailingAtrMult = toNum(exits?.trailing?.atrMult) ?? 1;
    const trailingActivateAtR = toNum(exits?.trailing?.activateAtR) ?? 1;

    let desiredSl = null;
    let manageReason = null;

    if (Number.isFinite(unrealizedR) && riskDistance > 0 && unrealizedR >= moveStopToBreakevenAtR) {
        desiredSl = pos.entryPrice + dir * riskDistance * breakevenBufferR;
        manageReason = "breakeven";
    }

    if (
        trailingEnabled &&
        Number.isFinite(unrealizedR) &&
        unrealizedR >= trailingActivateAtR &&
        Number.isFinite(currentMark) &&
        Number.isFinite(atr14) &&
        atr14 > 0
    ) {
        const trailCandidate = pos.side === "LONG" ? currentMark - trailingAtrMult * atr14 : currentMark + trailingAtrMult * atr14;
        if (!Number.isFinite(desiredSl)) {
            desiredSl = trailCandidate;
            manageReason = "trail";
        } else if (pos.side === "LONG") {
            if (trailCandidate > desiredSl) {
                desiredSl = trailCandidate;
                manageReason = "trail";
            }
        } else if (trailCandidate < desiredSl) {
            desiredSl = trailCandidate;
            manageReason = "trail";
        }
    }

    if (Number.isFinite(desiredSl)) {
        const currentSl = toNum(pos.currentSl);
        const improves =
            !Number.isFinite(currentSl) ||
            (pos.side === "LONG" && desiredSl > currentSl + 1e-12) ||
            (pos.side === "SHORT" && desiredSl < currentSl - 1e-12);
        if (improves) {
            return {
                action: "MANAGE",
                manageAction: {
                    type: "MOVE_SL",
                    newStopLoss: desiredSl,
                    reason: manageReason || "manage",
                },
                exitReason: null,
                rMultiple: unrealizedR,
                unrealizedR,
                currentMark,
                holdMinutes,
            };
        }
    }

    return {
        action: "MANAGE",
        manageAction: null,
        exitReason: null,
        rMultiple: unrealizedR,
        unrealizedR,
        currentMark,
        holdMinutes,
    };
}

export function evaluateCryptoLiquidityWindowMomentum({
    symbol,
    timestamp,
    bid = null,
    ask = null,
    mid = null,
    candles5m = [],
    candles1h = [],
    config,
    equity = null,
    openPosition = null,
    counters = {},
    entryContext = {},
} = {}) {
    const upperSymbol = String(symbol || "").toUpperCase();
    const now = safeDate(timestamp);
    const nowTsMs = now?.getTime?.() ?? null;
    const tz = config?.timezone || CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE;
    const windowCfg = config?.window || {};
    const windowGate = evaluateLiquidityWindowGate({
        timestamp: nowTsMs,
        timeZone: tz,
        windowStart: windowCfg.start || "14:00",
        windowEnd: windowCfg.end || "20:00",
    });

    const m5BarsRaw = Array.isArray(candles5m) ? candles5m : [];
    const h1BarsRaw = Array.isArray(candles1h) ? candles1h : [];
    const m5Bars = m5BarsRaw.map((bar) => normalizeBar(bar)).filter(Boolean);
    const h1Bars = h1BarsRaw.map((bar) => normalizeBar(bar)).filter(Boolean);

    const m5Closes = m5Bars.map((b) => b.c).filter(Number.isFinite);
    const h1Closes = h1Bars.map((b) => b.c).filter(Number.isFinite);
    const signalCfg = config?.signal || {};
    const dataCfg = config?.data || {};
    const jumpCfg = config?.jump || {};
    const entryCfg = config?.entry || {};
    const symbolCfg = resolveSymbolConfig(config || {}, upperSymbol);
    const riskProfile = activeRiskProfile(config || {});
    const lastM5 = m5Bars.length ? m5Bars[m5Bars.length - 1] : null;
    const lastH1 = h1Bars.length ? h1Bars[h1Bars.length - 1] : null;
    const fallbackClose = lastM5?.c ?? null;

    const emaFastPeriod = Number(signalCfg.emaFastPeriod || 9);
    const emaSlowPeriod = Number(signalCfg.emaSlowPeriod || 21);
    const slopeLookbackCandles = Number(signalCfg.slopeLookbackCandles || 3);
    const h1EmaPeriod = Number(signalCfg?.trendFilter1h?.emaPeriod || 50);
    const useH1TrendFilter = Boolean(signalCfg?.trendFilter1h?.enabled);

    const emaFastSeries = emaSeries(m5Closes, emaFastPeriod);
    const emaSlowSeries = emaSeries(m5Closes, emaSlowPeriod);
    const emaFast = emaFastSeries.length ? emaFastSeries[emaFastSeries.length - 1] : null;
    const emaSlow = emaSlowSeries.length ? emaSlowSeries[emaSlowSeries.length - 1] : null;
    const atr14 = atrLastFromBars(m5Bars, 14);

    const h1EmaSeries = emaSeries(h1Closes, h1EmaPeriod);
    const h1Ema50 = h1EmaSeries.length ? h1EmaSeries[h1EmaSeries.length - 1] : null;
    const h1Ema50Prev = h1EmaSeries.length > 1 ? h1EmaSeries[h1EmaSeries.length - 2] : null;
    const h1Slope = Number.isFinite(h1Ema50) && Number.isFinite(h1Ema50Prev) ? h1Ema50 - h1Ema50Prev : null;
    const h1Close = lastH1?.c ?? null;

    const volumeNow = toNum(lastM5?.v);
    const volumeLookback = m5Bars.slice(Math.max(0, m5Bars.length - 51), -1).map((b) => toNum(b.v)).filter(Number.isFinite);
    const volumeMedian = volumeLookback.length >= 50 ? median(volumeLookback.slice(-50)) : null;
    const volumeUnavailable = !Number.isFinite(volumeNow) || !Number.isFinite(volumeMedian);
    const volumeMult = toNum(signalCfg.volumeMult) ?? 1.1;
    const volumeGatePassed = volumeUnavailable ? true : volumeNow >= volumeMedian * volumeMult;

    const emaSlopeLongOk = positiveSlopeForLastDiffs(emaFastSeries, slopeLookbackCandles);
    const emaSlopeShortOk = negativeSlopeForLastDiffs(emaFastSeries, slopeLookbackCandles);
    const closePrice = lastM5?.c ?? null;
    const longSignalBase =
        Number.isFinite(emaFast) && Number.isFinite(emaSlow) && Number.isFinite(closePrice) && emaFast > emaSlow && emaSlopeLongOk && closePrice > emaFast;
    const shortSignalBase =
        Number.isFinite(emaFast) && Number.isFinite(emaSlow) && Number.isFinite(closePrice) && emaFast < emaSlow && emaSlopeShortOk && closePrice < emaFast;

    const trendFilterLongPassed = !useH1TrendFilter
        ? true
        : Number.isFinite(h1Slope) && Number.isFinite(h1Close) && Number.isFinite(h1Ema50) && h1Slope > 0 && h1Close > h1Ema50;
    const trendFilterShortPassed = !useH1TrendFilter
        ? true
        : Number.isFinite(h1Slope) && Number.isFinite(h1Close) && Number.isFinite(h1Ema50) && h1Slope < 0 && h1Close < h1Ema50;

    const longSignal = longSignalBase && volumeGatePassed && trendFilterLongPassed;
    const shortSignal = shortSignalBase && volumeGatePassed && trendFilterShortPassed;

    const bidNum = toNum(bid);
    const askNum = toNum(ask);
    const midNum = toNum(mid) ?? (Number.isFinite(bidNum) && Number.isFinite(askNum) ? (bidNum + askNum) / 2 : null);
    const spreadPct =
        Number.isFinite(bidNum) && Number.isFinite(askNum) && Number.isFinite(midNum) && midNum !== 0 ? Math.abs(askNum - bidNum) / midNum : null;
    const spreadUnavailable = !Number.isFinite(spreadPct);
    const spreadGatePassed = spreadUnavailable ? true : spreadPct <= symbolCfg.maxSpreadPct;

    const jump = detectJumpRegime({
        bars5m: m5Bars,
        atr14,
        jumpThresholdPct: symbolCfg.jumpThresholdPct,
        jumpAtrMult: toNum(jumpCfg.jumpAtrMult) ?? 2.5,
        lookbackBars: Number(jumpCfg.lookbackBars5m || 12),
        nowTsMs,
        cooldownMinutes: Number(jumpCfg.cooldownMinutes || 60),
    });

    const lastExitAtMs = parseCandleTimestamp(counters?.lastExitAt ?? counters?.lastExitAtMs);
    const cooldownMinutes = Number(entryCfg.cooldownMinutes || 30);
    const cooldownRemaining =
        Number.isFinite(lastExitAtMs) && Number.isFinite(nowTsMs) ? Math.max(0, cooldownMinutes - (nowTsMs - lastExitAtMs) / 60000) : 0;

    const tradesTodaySymbol = Number.isFinite(Number(counters?.tradesTodaySymbol)) ? Number(counters.tradesTodaySymbol) : 0;
    const tradesTodayTotal = Number.isFinite(Number(counters?.tradesTodayTotal)) ? Number(counters.tradesTodayTotal) : 0;
    const maxTradesPerSymbolPerDay = Number(entryCfg.maxTradesPerSymbolPerDay || 1);
    const maxTradesPerDay = Number(entryCfg.maxTradesPerDay || 2);

    const startOfDayEquity = toNum(counters?.startOfDayEquity);
    const realizedPnlToday = toNum(counters?.realizedPnlToday) ?? 0;
    const dailyLossPct = Number.isFinite(startOfDayEquity) && startOfDayEquity > 0 ? Math.abs(Math.min(0, realizedPnlToday / startOfDayEquity)) : null;
    const dailyLossLimitHit = Number.isFinite(dailyLossPct) && dailyLossPct >= riskProfile.dailyLossLimitPct;

    const minCandles5m = Number(dataCfg.minCandles5m || 200);
    const minCandles1h = Number(dataCfg.minCandles1h || 50);
    const dataGate5mPassed = m5Bars.length >= minCandles5m;
    const dataGate1hPassed = !useH1TrendFilter || h1Bars.length >= minCandles1h;
    const dataGatePassed = dataGate5mPassed && dataGate1hPassed;

    const m5BarKey =
        lastM5 && (lastM5.t || (Number.isFinite(lastM5.tsMs) ? `ts:${lastM5.tsMs}` : `ohlc:${[lastM5.o, lastM5.h, lastM5.l, lastM5.c].join("|")}`));
    const newClosedBarReady = entryContext?.requireNewClosedBar ? Boolean(entryContext?.isNewClosedBar) : true;

    const decisionLog = {
        strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
        timestamp: now?.toISOString?.() || null,
        symbol: upperSymbol,
        timeframe: "M5",
        windowGatePassed: Boolean(windowGate.windowGatePassed),
        withinWindow: Boolean(windowGate.withinWindow),
        windowStart: windowGate.windowStart,
        windowEnd: windowGate.windowEnd,
        timezone: tz,
        spreadPct: round(spreadPct, 8),
        spreadUnavailable,
        spreadGatePassed,
        jumpDetected: Boolean(jump.jumpDetected),
        jumpMetricUsed: jump.jumpMetricUsed ?? null,
        jumpCooldownRemaining: round(jump.jumpCooldownRemainingMinutes, 4) ?? 0,
        cooldownRemaining: round(cooldownRemaining, 4) ?? 0,
        tradesTodaySymbol,
        tradesTodayTotal,
        indicators: {
            emaFast: round(emaFast, 8),
            emaSlow: round(emaSlow, 8),
            atr14: round(atr14, 8),
            volumeNow: round(volumeNow, 8),
            volumeMedian: round(volumeMedian, 8),
        },
        signalFlags: {
            longSignal,
            shortSignal,
            longSignalBase,
            shortSignalBase,
            volumeGatePassed,
            volumeUnavailable,
            trendFilterPassed: useH1TrendFilter ? (longSignal ? trendFilterLongPassed : shortSignal ? trendFilterShortPassed : true) : true,
            trendFilterLongPassed,
            trendFilterShortPassed,
        },
        gates: {
            dataGatePassed,
            dataGate5mPassed,
            dataGate1hPassed,
            dailyLossLimitHit,
            spreadGatePassed,
            jumpGatePassed: !jump.jumpDetected,
            cooldownGatePassed: cooldownRemaining <= 0,
            perSymbolTradeCapPassed: tradesTodaySymbol < maxTradesPerSymbolPerDay,
            totalTradeCapPassed: tradesTodayTotal < maxTradesPerDay,
            newClosedBarReady,
            externalEntryAllowed: entryContext?.externalEntryAllowed !== false,
        },
    };

    const result = {
        action: "NO_TRADE",
        side: null,
        reasonCode: null,
        orderPlan: null,
        manageAction: null,
        exitReason: null,
        m5BarKey: m5BarKey ?? null,
        metrics: {
            atr14,
            emaFast,
            emaSlow,
            h1Ema50,
            h1Slope,
            closePrice,
            spreadPct,
            dailyLossPct,
        },
        decisionLog,
    };

    if (openPosition) {
        const mgmt = computeManagementDecision({
            config,
            position: openPosition,
            bid: bidNum,
            ask: askNum,
            mid: midNum,
            nowTsMs,
            atr14,
            fallbackClose,
        });
        result.action = mgmt.action;
        result.manageAction = mgmt.manageAction;
        result.exitReason = mgmt.exitReason;
        result.metrics.unrealizedR = mgmt.unrealizedR;
        result.metrics.holdMinutes = mgmt.holdMinutes;
        result.metrics.currentMark = mgmt.currentMark;
        result.metrics.rMultipleAtExit = mgmt.rMultiple;
        if (mgmt.action === "EXIT") {
            return buildManage(
                {
                    ...result,
                    reasonCode: mgmt.exitReason || "manage_exit",
                },
                {
                    ...decisionLog,
                    decision: "EXIT",
                    exitReason: mgmt.exitReason || "manage_exit",
                    RmultipleAtExit: round(mgmt.rMultiple, 8),
                },
                "EXIT",
            );
        }
        return buildManage(
            {
                ...result,
                reasonCode: mgmt.manageAction ? `manage_${String(mgmt.manageAction.reason || "update")}` : "manage_hold",
            },
            {
                ...decisionLog,
                decision: "MANAGE",
                manageAction: mgmt.manageAction
                    ? {
                          type: mgmt.manageAction.type,
                          newStopLoss: round(mgmt.manageAction.newStopLoss, 8),
                          reason: mgmt.manageAction.reason,
                      }
                    : null,
            },
        );
    }

    if (!windowGate.withinWindow) return buildNoTrade(result, decisionLog, "outside_liquidity_window");
    if (!dataGatePassed) return buildNoTrade(result, decisionLog, "insufficient_candles");
    if (dailyLossLimitHit) return buildNoTrade(result, decisionLog, "daily_loss_limit_hit");
    if (!spreadGatePassed) return buildNoTrade(result, decisionLog, "spread_too_wide");
    if (jump.jumpDetected) return buildNoTrade(result, decisionLog, "jump_cooldown_active");
    if (cooldownRemaining > 0) return buildNoTrade(result, decisionLog, "post_exit_cooldown_active");
    if (tradesTodaySymbol >= maxTradesPerSymbolPerDay) return buildNoTrade(result, decisionLog, "max_trades_symbol_reached");
    if (tradesTodayTotal >= maxTradesPerDay) return buildNoTrade(result, decisionLog, "max_trades_day_reached");
    if (entryContext?.externalEntryAllowed === false) return buildNoTrade(result, decisionLog, String(entryContext?.externalBlockReason || "external_entry_block"));
    if (!newClosedBarReady) return buildNoTrade(result, decisionLog, "await_new_5m_close");

    let side = null;
    if (longSignal) side = "LONG";
    else if (shortSignal) side = "SHORT";
    else return buildNoTrade(result, decisionLog, "signal_not_confirmed");

    const entryPrice = selectEntryPrice({ side, bid: bidNum, ask: askNum, fallbackClose });
    if (!Number.isFinite(entryPrice) || !(entryPrice > 0)) return buildNoTrade(result, decisionLog, "invalid_entry_price");
    if (!Number.isFinite(atr14) || atr14 <= 0) return buildNoTrade(result, decisionLog, "atr_unavailable");

    const atrStop = atr14 * symbolCfg.stopAtrMult;
    const minStopDistance = entryPrice * symbolCfg.minStopPct;
    const stopDistance = Math.max(atrStop, minStopDistance);
    if (!(stopDistance > 0)) return buildNoTrade(result, decisionLog, "invalid_stop_distance");

    const dir = side === "LONG" ? 1 : -1;
    const sl = entryPrice - dir * stopDistance;
    const tpR = toNum(config?.exits?.tpR) ?? 1.25;
    const tp = entryPrice + dir * stopDistance * tpR;

    const sizing = calculateCryptoPositionSizeFromRisk({
        equity,
        entryPrice,
        stopPrice: sl,
        riskPct: riskProfile.riskPct,
        maxLeverage: riskProfile.maxLeverageCrypto,
        minSize: 0.1,
        precision: 3,
    });
    if (!Number.isFinite(sizing.size) || sizing.size <= 0) return buildNoTrade(result, decisionLog, "invalid_position_size");

    result.action = "OPEN";
    result.side = side;
    result.reasonCode = side === "LONG" ? "open_long_signal" : "open_short_signal";
    result.orderPlan = {
        strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
        symbol: upperSymbol,
        side,
        orderType: "MARKET",
        requestedPrice: entryPrice,
        entryPrice,
        sl,
        tp,
        size: sizing.size,
        riskPct: riskProfile.riskPct,
        riskAmount: sizing.riskAmount,
        stopDistance: sizing.stopDistance,
        tpDistance: Math.abs(tp - entryPrice),
        rr: tpR,
        leverageCapped: Boolean(sizing.leverageCapped),
        riskProfile: riskProfile.profile,
    };

    result.decisionLog = {
        ...decisionLog,
        decision: side === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
        orderType: "MARKET",
        requestedPrice: round(entryPrice, 8),
        sl: round(sl, 8),
        tp: round(tp, 8),
        size: round(sizing.size, 8),
        riskAmount: round(sizing.riskAmount, 8),
        stopDistance: round(sizing.stopDistance, 8),
    };

    return result;
}

export function buildBacktestDecisionLogRecord({
    evaluation,
    snapshot,
    symbol,
    timestamp,
} = {}) {
    const log = evaluation?.decisionLog || {};
    const record = {
        strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
        timestamp: timestamp || snapshot?.timestamp || null,
        symbol: String(symbol || snapshot?.symbol || "").toUpperCase(),
        timeframe: log.timeframe || "M5",
        windowGatePassed: Boolean(log.windowGatePassed),
        withinWindow: Boolean(log.withinWindow),
        windowStart: log.windowStart || "14:00",
        windowEnd: log.windowEnd || "20:00",
        timezone: log.timezone || CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_TIMEZONE,
        spreadPct: log.spreadPct ?? null,
        spreadUnavailable: Boolean(log.spreadUnavailable),
        jumpDetected: Boolean(log.jumpDetected),
        jumpMetricUsed: log.jumpMetricUsed ?? null,
        jumpCooldownRemaining: log.jumpCooldownRemaining ?? 0,
        cooldownRemaining: log.cooldownRemaining ?? 0,
        tradesTodaySymbol: toNum(log.tradesTodaySymbol) ?? 0,
        tradesTodayTotal: toNum(log.tradesTodayTotal) ?? 0,
        indicators: log.indicators || null,
        signalFlags: log.signalFlags || null,
        decision: log.decision || evaluation?.action || "NO_TRADE",
    };

    if (evaluation?.orderPlan) {
        record.orderType = evaluation.orderPlan.orderType || "MARKET";
        record.requestedPrice = round(evaluation.orderPlan.requestedPrice, 8);
        record.filledPrice = null;
        record.sl = round(evaluation.orderPlan.sl, 8);
        record.tp = round(evaluation.orderPlan.tp, 8);
        record.size = round(evaluation.orderPlan.size, 8);
        record.riskAmount = round(evaluation.orderPlan.riskAmount, 8);
        record.stopDistance = round(evaluation.orderPlan.stopDistance, 8);
    }

    if (evaluation?.action === "EXIT") {
        record.RmultipleAtExit = round(evaluation?.metrics?.rMultipleAtExit, 8);
    }

    return record;
}
