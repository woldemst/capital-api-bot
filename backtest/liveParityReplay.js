import fs from "fs";
import path from "path";
import readline from "readline";
import { createIntradaySevenStepEngine } from "../intraday/engine.js";
import { DEFAULT_CRYPTO_INTRADAY_CONFIG, DEFAULT_INTRADAY_CONFIG, assetClassOfSymbol, mergeIntradayConfig } from "../intraday/config.js";
import { createIntradayRuntimeState, ensureStateDay, registerClosedTrade, registerOpenedTrade } from "../intraday/state.js";
import { RISK, SESSIONS } from "../config.js";

const DATA_DIR = path.join(process.cwd(), "backtest", "generated-dataset");
const TARGET_SYMBOLS_FROM_ENV = String(process.env.LIVE_PARITY_SYMBOLS || "")
    .split(",")
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
const TARGET_TIMEFRAMES = ["M1", "M5", "M15", "H1"];

const START_CAPITAL = Number.isFinite(Number(process.env.LIVE_PARITY_START_CAPITAL)) ? Number(process.env.LIVE_PARITY_START_CAPITAL) : 500;
const COMPOUND_RISK = envBool(process.env.LIVE_PARITY_COMPOUND_RISK, true);
const DAYS_BACK = Number.isFinite(Number(process.env.LIVE_PARITY_DAYS)) ? Number(process.env.LIVE_PARITY_DAYS) : null;
const MONTHS_BACK = Number.isFinite(Number(process.env.LIVE_PARITY_MONTHS_BACK)) ? Number(process.env.LIVE_PARITY_MONTHS_BACK) : 2;
const RANGE_START_FROM_ENV = String(process.env.LIVE_PARITY_FROM || "").trim();
const RANGE_END_FROM_ENV = String(process.env.LIVE_PARITY_TO || "").trim();
const PHASE1_RISK_PCT = Number.isFinite(Number(process.env.LIVE_PARITY_RISK_PCT_PHASE1))
    ? Number(process.env.LIVE_PARITY_RISK_PCT_PHASE1)
    : 0.05;
const PHASE2_RISK_PCT = Number.isFinite(Number(process.env.LIVE_PARITY_RISK_PCT_PHASE2)) ? Number(process.env.LIVE_PARITY_RISK_PCT_PHASE2) : null;
const PHASE2_START_AFTER_MONTHS = Number.isFinite(Number(process.env.LIVE_PARITY_PHASE2_START_AFTER_MONTHS))
    ? Number(process.env.LIVE_PARITY_PHASE2_START_AFTER_MONTHS)
    : null;
const RISK_PHASES_JSON_RAW = String(process.env.LIVE_PARITY_RISK_PHASES_JSON || "").trim();
const COST_MODEL_ENABLED = String(process.env.LIVE_PARITY_COST_MODEL || "").toLowerCase() === "true";
const SPREAD_PIPS = Number.isFinite(Number(process.env.LIVE_PARITY_SPREAD_PIPS)) ? Number(process.env.LIVE_PARITY_SPREAD_PIPS) : 1.2;
const SLIPPAGE_PIPS_PER_FILL = Number.isFinite(Number(process.env.LIVE_PARITY_SLIPPAGE_PIPS_PER_FILL))
    ? Number(process.env.LIVE_PARITY_SLIPPAGE_PIPS_PER_FILL)
    : 0.4;
const MAX_POSITIONS = Number.isFinite(Number(process.env.LIVE_PARITY_MAX_POSITIONS))
    ? Number(process.env.LIVE_PARITY_MAX_POSITIONS)
    : Number(RISK?.MAX_POSITIONS) || 5;
const GUARDS = RISK?.GUARDS || {};
const EXITS = RISK?.EXITS || {};
const MAX_DAILY_LOSS_PCT = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_PCT)) ? Number(GUARDS.MAX_DAILY_LOSS_PCT) : 0;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(process.env.LIVE_PARITY_MAX_OPEN_RISK_PCT))
    ? Number(process.env.LIVE_PARITY_MAX_OPEN_RISK_PCT)
    : Number.isFinite(Number(GUARDS.MAX_OPEN_RISK_PCT))
      ? Number(GUARDS.MAX_OPEN_RISK_PCT)
    : Math.max(PHASE1_RISK_PCT, Number(RISK?.CRYPTO_PER_TRADE) || PHASE1_RISK_PCT) * 2;
const MAX_LOSS_STREAK = Number.isFinite(Number(GUARDS.MAX_LOSS_STREAK)) ? Number(GUARDS.MAX_LOSS_STREAK) : 3;
const LOSS_STREAK_COOLDOWN_MINUTES = Number.isFinite(Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES))
    ? Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES)
    : 180;
const FILTER_REQUIRE_H1_M15_ALIGN = envBool(process.env.LIVE_PARITY_FILTER_REQUIRE_H1_M15_ALIGN, false);
const FILTER_REQUIRE_M15_M5_ALIGN = envBool(process.env.LIVE_PARITY_FILTER_REQUIRE_M15_M5_ALIGN, false);
const FILTER_REQUIRE_FVG = envBool(process.env.LIVE_PARITY_FILTER_REQUIRE_FVG, false);
const FILTER_REQUIRE_STRUCTURE_BREAK = envBool(process.env.LIVE_PARITY_FILTER_REQUIRE_STRUCTURE_BREAK, false);
const FILTER_MIN_H1_ADX = Number.isFinite(Number(process.env.LIVE_PARITY_FILTER_MIN_H1_ADX))
    ? Number(process.env.LIVE_PARITY_FILTER_MIN_H1_ADX)
    : null;
const FILTER_MAX_H1_ADX = Number.isFinite(Number(process.env.LIVE_PARITY_FILTER_MAX_H1_ADX))
    ? Number(process.env.LIVE_PARITY_FILTER_MAX_H1_ADX)
    : null;
const FILTER_MIN_M15_RSI = Number.isFinite(Number(process.env.LIVE_PARITY_FILTER_MIN_M15_RSI))
    ? Number(process.env.LIVE_PARITY_FILTER_MIN_M15_RSI)
    : null;
const FILTER_MAX_M15_RSI = Number.isFinite(Number(process.env.LIVE_PARITY_FILTER_MAX_M15_RSI))
    ? Number(process.env.LIVE_PARITY_FILTER_MAX_M15_RSI)
    : null;
const FILTER_SESSIONS = String(process.env.LIVE_PARITY_FILTER_SESSIONS || "")
    .split(",")
    .map((x) => String(x || "").trim().toUpperCase())
    .filter(Boolean);
const FILTER_SYMBOL_SESSIONS_RAW = String(process.env.LIVE_PARITY_FILTER_SYMBOL_SESSIONS || "").trim();
const MIN_PATTERN_TRADES = Number.isFinite(Number(process.env.LIVE_PARITY_MIN_PATTERN_TRADES))
    ? Math.max(1, Number(process.env.LIVE_PARITY_MIN_PATTERN_TRADES))
    : 25;
const REPORT_JSON_PATH = String(process.env.LIVE_PARITY_REPORT_PATH || "").trim();
const ENFORCE_MARGIN = envBool(
    process.env.LIVE_PARITY_ENFORCE_MARGIN ?? process.env.LIVE_PARITY_MARGIN_MODEL,
    false,
);
const MARGIN_UTILIZATION = Number.isFinite(Number(process.env.LIVE_PARITY_MARGIN_UTILIZATION))
    ? Math.min(1, Math.max(0.1, Number(process.env.LIVE_PARITY_MARGIN_UTILIZATION)))
    : 0.95;
const ACCOUNT_CURRENCY = String(process.env.LIVE_PARITY_ACCOUNT_CURRENCY || "EUR").trim().toUpperCase();
const LEVERAGE_FX_MAJOR = Number.isFinite(
    Number(process.env.LIVE_PARITY_LEVERAGE_FX_MAJOR ?? process.env.LIVE_PARITY_MAJOR_FX_LEVERAGE),
)
    ? Number(process.env.LIVE_PARITY_LEVERAGE_FX_MAJOR ?? process.env.LIVE_PARITY_MAJOR_FX_LEVERAGE)
    : 30;
const LEVERAGE_FX_NON_MAJOR = Number.isFinite(
    Number(process.env.LIVE_PARITY_LEVERAGE_FX_NON_MAJOR ?? process.env.LIVE_PARITY_NON_MAJOR_FX_LEVERAGE),
)
    ? Number(process.env.LIVE_PARITY_LEVERAGE_FX_NON_MAJOR ?? process.env.LIVE_PARITY_NON_MAJOR_FX_LEVERAGE)
    : 20;
const CONFIG_OVERRIDE_JSON_RAW = String(process.env.LIVE_PARITY_CONFIG_OVERRIDE_JSON || "").trim();
const CONFIG_OVERRIDE_FILE = String(process.env.LIVE_PARITY_CONFIG_OVERRIDE_FILE || "").trim();

const ROLLOVER_TIMEZONE = "America/New_York";
const ROLLOVER_HOUR = 17;
const ROLLOVER_MINUTE = 0;
const ROLLOVER_BUFFER_MINUTES = 10;

function envBool(rawValue, fallback = false) {
    if (rawValue === undefined || rawValue === null || rawValue === "") return Boolean(fallback);
    const normalized = String(rawValue).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return Boolean(fallback);
}

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function parseTimestamp(raw) {
    if (!raw) return null;
    const tsMs = Date.parse(String(raw));
    return Number.isFinite(tsMs) ? tsMs : null;
}

function parseConfigOverrides() {
    if (CONFIG_OVERRIDE_JSON_RAW) {
        return JSON.parse(CONFIG_OVERRIDE_JSON_RAW);
    }
    if (CONFIG_OVERRIDE_FILE) {
        const filePath = path.isAbsolute(CONFIG_OVERRIDE_FILE)
            ? CONFIG_OVERRIDE_FILE
            : path.join(process.cwd(), CONFIG_OVERRIDE_FILE);
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    return {};
}

function addUtcMonths(tsMs, monthsToAdd) {
    const d = new Date(tsMs);
    d.setUTCMonth(d.getUTCMonth() + monthsToAdd);
    return d.getTime();
}

function buildRiskPhases(actualStartMs) {
    if (RISK_PHASES_JSON_RAW) {
        const parsed = JSON.parse(RISK_PHASES_JSON_RAW);
        if (!Array.isArray(parsed) || !parsed.length) {
            throw new Error("LIVE_PARITY_RISK_PHASES_JSON must be a non-empty array.");
        }
        const phases = [];
        let cursorMs = actualStartMs;
        for (let i = 0; i < parsed.length; i += 1) {
            const raw = parsed[i] || {};
            const riskPct = Number(raw.riskPct);
            if (!(Number.isFinite(riskPct) && riskPct > 0)) {
                throw new Error(`Invalid riskPct in LIVE_PARITY_RISK_PHASES_JSON at index ${i}.`);
            }
            const months = raw.months === undefined || raw.months === null || raw.months === "" ? null : Number(raw.months);
            const endMs = Number.isFinite(months) && months > 0 ? addUtcMonths(cursorMs, months) : Number.POSITIVE_INFINITY;
            phases.push({
                index: i + 1,
                key: `PHASE_${i + 1}_${riskPctLabel(riskPct)}`,
                riskPct,
                startMs: cursorMs,
                endMs,
            });
            cursorMs = endMs;
        }
        return phases;
    }

    const phase2Enabled = Number.isFinite(PHASE2_RISK_PCT) && Number.isFinite(PHASE2_START_AFTER_MONTHS) && PHASE2_START_AFTER_MONTHS >= 0;
    if (!phase2Enabled) {
        return [
            {
                index: 1,
                key: `PHASE_1_${riskPctLabel(PHASE1_RISK_PCT)}`,
                riskPct: PHASE1_RISK_PCT,
                startMs: actualStartMs,
                endMs: Number.POSITIVE_INFINITY,
            },
        ];
    }

    const phase2StartMs = addUtcMonths(actualStartMs, PHASE2_START_AFTER_MONTHS);
    return [
        {
            index: 1,
            key: `PHASE_1_${riskPctLabel(PHASE1_RISK_PCT)}`,
            riskPct: PHASE1_RISK_PCT,
            startMs: actualStartMs,
            endMs: phase2StartMs,
        },
        {
            index: 2,
            key: `PHASE_2_${riskPctLabel(PHASE2_RISK_PCT)}`,
            riskPct: PHASE2_RISK_PCT,
            startMs: phase2StartMs,
            endMs: Number.POSITIVE_INFINITY,
        },
    ];
}

function describeRiskPlan(phases) {
    return phases
        .map((phase) => {
            const startIso = new Date(phase.startMs).toISOString();
            const endIso = Number.isFinite(phase.endMs) ? new Date(phase.endMs).toISOString() : "end";
            return `${phase.key} ${startIso} -> ${endIso}`;
        })
        .join("; ");
}

function cryptoPairOverridesForSymbols(symbols = []) {
    const overrides = {};
    for (const rawSymbol of Array.isArray(symbols) ? symbols : []) {
        const symbol = String(rawSymbol || "").trim().toUpperCase();
        if (!symbol || assetClassOfSymbol(symbol) !== "crypto") continue;
        overrides[symbol] = mergeIntradayConfig(DEFAULT_CRYPTO_INTRADAY_CONFIG, {
            strategyId: DEFAULT_CRYPTO_INTRADAY_CONFIG.strategyId,
        });
    }
    return overrides;
}

function utcDayKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

function weekStartUtc(tsMs) {
    const d = new Date(tsMs);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
}

function isoDate(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

function pct(value) {
    if (!Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(2)}%`;
}

function num(value, digits = 2) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(digits);
}

function riskPctLabel(riskPct) {
    return `${(Number(riskPct) * 100).toFixed(2)}%`;
}

function isLikelyForexPair(symbol) {
    return /^[A-Z]{6}$/.test(String(symbol || "").toUpperCase());
}

function isMajorFxPair(symbol) {
    const value = String(symbol || "").toUpperCase();
    if (!isLikelyForexPair(value)) return false;
    const majors = new Set(["USD", "EUR", "JPY", "GBP", "CAD", "CHF"]);
    const base = value.slice(0, 3);
    const quote = value.slice(3, 6);
    return majors.has(base) && majors.has(quote) && base !== quote;
}

function leverageForSymbol(symbol) {
    if (isLikelyForexPair(symbol)) {
        return isMajorFxPair(symbol) ? LEVERAGE_FX_MAJOR : LEVERAGE_FX_NON_MAJOR;
    }
    return LEVERAGE_FX_NON_MAJOR;
}

function estimateNotionalInAccountCurrency({ symbol, size, entryPrice }) {
    const qty = Math.abs(Number(size));
    const px = Number(entryPrice);
    if (!(qty > 0)) return null;

    const value = String(symbol || "").toUpperCase();
    if (isLikelyForexPair(value)) {
        const base = value.slice(0, 3);
        const quote = value.slice(3, 6);
        if (base === ACCOUNT_CURRENCY) return qty;
        if (quote === ACCOUNT_CURRENCY && Number.isFinite(px) && px > 0) return qty * px;
        // Fallback when no direct conversion is available in replay mode.
        return qty;
    }
    return Number.isFinite(px) && px > 0 ? qty * px : qty;
}

function pipSizeForSymbol(symbol) {
    const value = String(symbol || "").toUpperCase();
    return value.endsWith("JPY") ? 0.01 : 0.0001;
}

function spreadPriceForSymbol(symbol) {
    if (!COST_MODEL_ENABLED) return 0;
    return Math.max(0, SPREAD_PIPS) * pipSizeForSymbol(symbol);
}

function perFillCostDistance(symbol) {
    if (!COST_MODEL_ENABLED) return 0;
    const spreadHalfPips = Math.max(0, SPREAD_PIPS) * 0.5;
    const slippagePips = Math.max(0, SLIPPAGE_PIPS_PER_FILL);
    const costPips = spreadHalfPips + slippagePips;
    return costPips * pipSizeForSymbol(symbol);
}

function applyAdverseFill({ symbol, side, price, phase }) {
    const raw = Number(price);
    if (!Number.isFinite(raw)) return null;
    const normalizedSide = String(side || "").toUpperCase();
    if (!["LONG", "SHORT"].includes(normalizedSide)) return null;
    if (phase !== "entry" && phase !== "exit") return raw;

    const dist = perFillCostDistance(symbol);
    if (!(dist > 0)) return raw;

    if (phase === "entry") {
        return normalizedSide === "LONG" ? raw + dist : raw - dist;
    }
    return normalizedSide === "LONG" ? raw - dist : raw + dist;
}

function parseMinutes(hhmm) {
    if (typeof hhmm !== "string") return NaN;
    const [hh, mm] = hhmm.split(":").map((p) => Number(p));
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return NaN;
    return hh * 60 + mm;
}

function parseSymbolSessionFilter(raw) {
    const map = new Map();
    const text = String(raw || "").trim();
    if (!text) return map;
    const entries = text
        .split(";")
        .map((part) => String(part || "").trim())
        .filter(Boolean);
    for (const entry of entries) {
        const [symbolPart, sessionsPart = ""] = entry.split(":");
        const symbol = String(symbolPart || "").trim().toUpperCase();
        if (!symbol) continue;
        const sessions = String(sessionsPart || "")
            .split(/[|,+/]/)
            .map((s) => String(s || "").trim().toUpperCase())
            .filter(Boolean);
        map.set(symbol, new Set(sessions));
    }
    return map;
}

function symbolSessionFilterFromConfig(config = DEFAULT_INTRADAY_CONFIG) {
    const source = config?.symbolSessions;
    const map = new Map();
    if (!source || typeof source !== "object") return map;

    for (const [symbol, rawSessions] of Object.entries(source)) {
        const key = String(symbol || "").trim().toUpperCase();
        if (!key) continue;
        const sessions = Array.isArray(rawSessions)
            ? rawSessions
                  .map((session) => String(session || "").trim().toUpperCase())
                  .filter(Boolean)
            : [];
        map.set(key, new Set(sessions));
    }

    return map;
}

const FILTER_SYMBOL_SESSIONS = FILTER_SYMBOL_SESSIONS_RAW
    ? parseSymbolSessionFilter(FILTER_SYMBOL_SESSIONS_RAW)
    : symbolSessionFilterFromConfig(DEFAULT_INTRADAY_CONFIG);

function inSession(currentMinutes, startMinutes, endMinutes, { inclusiveEnd = false } = {}) {
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
    }
    return currentMinutes >= startMinutes || (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
}

function getMinutesInTimeZone(timeZone, tsMs) {
    const date = new Date(tsMs);
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

function getDateKeyInTimeZone(timeZone, tsMs) {
    const date = new Date(tsMs);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value ?? "0000";
    const month = parts.find((p) => p.type === "month")?.value ?? "00";
    const day = parts.find((p) => p.type === "day")?.value ?? "00";
    return `${year}-${month}-${day}`;
}

function isForexWeekendClosed(tsMs) {
    const d = new Date(tsMs);
    const day = d.getUTCDay();
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return true;
    if (day === 0 && minutes < 22 * 60) return true;
    if (day === 5 && minutes >= 22 * 60) return true;
    return false;
}

function getActiveSessionNames(tsMs) {
    const d = new Date(tsMs);
    const currentMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const names = [];
    for (const [name, session] of Object.entries(SESSIONS || {})) {
        if (String(name).toUpperCase() === "CRYPTO") continue;
        const start = parseMinutes(session?.START);
        const end = parseMinutes(session?.END);
        if (inSession(currentMinutes, start, end)) names.push(name);
    }
    return names;
}

function getActiveForexSymbols(tsMs) {
    if (isForexWeekendClosed(tsMs)) return [];
    const names = getActiveSessionNames(tsMs);
    const ordered = [];
    const set = new Set();
    for (const name of names) {
        const symbols = SESSIONS?.[name]?.SYMBOLS || [];
        for (const symbolRaw of symbols) {
            const symbol = String(symbolRaw || "").toUpperCase();
            if (!symbol || set.has(symbol)) continue;
            set.add(symbol);
            ordered.push(symbol);
        }
    }
    return ordered;
}

function isRolloverBuffer(tsMs) {
    const rolloverMinutes = ROLLOVER_HOUR * 60 + ROLLOVER_MINUTE;
    const nyMinutes = getMinutesInTimeZone(ROLLOVER_TIMEZONE, tsMs);
    return nyMinutes >= rolloverMinutes - ROLLOVER_BUFFER_MINUTES && nyMinutes < rolloverMinutes;
}

function pickTrend(indicator) {
    if (!indicator || typeof indicator !== "object") return "neutral";
    const ema20 = toNum(indicator.ema20);
    const ema50 = toNum(indicator.ema50);
    if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
    }
    const trend = String(indicator?.trend || "").toLowerCase();
    if (trend === "bullish" || trend === "bearish") return trend;
    return "neutral";
}

function tpProgress(side, entryPrice, takeProfit, currentPrice) {
    const entry = Number(entryPrice);
    const tp = Number(takeProfit);
    const price = Number(currentPrice);
    if (![entry, tp, price].every(Number.isFinite)) return null;
    const dist = Math.abs(tp - entry);
    if (dist <= 0) return null;
    if (side === "LONG") return (price - entry) / dist;
    if (side === "SHORT") return (entry - price) / dist;
    return null;
}

function toBar(row) {
    if (!row) return null;
    const o = toNum(row.open);
    const h = toNum(row.high);
    const l = toNum(row.low);
    const c = toNum(row.close);
    if (![o, h, l, c].every(Number.isFinite)) return null;
    return { t: row.timestamp, o, h, l, c };
}

async function loadJsonlRows(filePath, minTsMs, maxTsMs) {
    const rows = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line || !line.trim()) continue;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            continue;
        }
        const tsMs = Date.parse(String(row.timestamp || ""));
        if (!Number.isFinite(tsMs)) continue;
        if (tsMs < minTsMs) continue;
        // Some generated files are not strictly monotonic; keep scanning instead of breaking early.
        if (tsMs > maxTsMs) continue;
        rows.push({ ...row, tsMs });
    }
    return rows;
}

async function loadSymbolData(symbol, minTsMs, maxTsMs) {
    const out = { symbol };
    for (const tf of TARGET_TIMEFRAMES) {
        const filePath = path.join(DATA_DIR, `${symbol}_${tf}.jsonl`);
        out[tf] = await loadJsonlRows(filePath, minTsMs, maxTsMs);
    }
    return out;
}

function computeTradeSummaryForGuards(closedTrades) {
    let currentLossStreak = 0;
    let lastLossAtMs = null;
    for (const trade of closedTrades) {
        if (trade.r < 0) {
            currentLossStreak += 1;
            lastLossAtMs = trade.closeTsMs;
        } else if (trade.r > 0) {
            currentLossStreak = 0;
        }
    }
    return { currentLossStreak, lastLossAtMs };
}

function renderTable(headers, rows) {
    const widths = headers.map((h) => h.length);
    for (const row of rows) {
        row.forEach((cell, i) => {
            widths[i] = Math.max(widths[i], String(cell).length);
        });
    }
    const line = (cells) =>
        cells
            .map((cell, i) => {
                const text = String(cell);
                const pad = widths[i] - text.length;
                return `${text}${" ".repeat(Math.max(0, pad))}`;
            })
            .join(" | ");
    const sep = widths.map((w) => "-".repeat(w)).join("-|-");
    return [line(headers), sep, ...rows.map((r) => line(r))].join("\n");
}

function discoverSymbolsFromDataset() {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR);
    const tfBySymbol = new Map();
    const re = /^([A-Z0-9]+)_(M1|M5|M15|H1)\.jsonl$/i;
    for (const file of files) {
        const match = re.exec(file);
        if (!match) continue;
        const symbol = String(match[1] || "").toUpperCase();
        const tf = String(match[2] || "").toUpperCase();
        if (!symbol || !tf) continue;
        if (!tfBySymbol.has(symbol)) tfBySymbol.set(symbol, new Set());
        tfBySymbol.get(symbol).add(tf);
    }
    return [...tfBySymbol.entries()]
        .filter(([, tfSet]) => TARGET_TIMEFRAMES.every((tf) => tfSet.has(tf)))
        .map(([symbol]) => symbol)
        .sort((a, b) => a.localeCompare(b));
}

function adxValue(indicator) {
    return toNum(indicator?.adx?.adx ?? indicator?.adx);
}

function sideMatchesTrend(side, trend) {
    const normalizedSide = String(side || "").toUpperCase();
    if (trend === "bullish") return normalizedSide === "LONG";
    if (trend === "bearish") return normalizedSide === "SHORT";
    return false;
}

function adxBucket(adx) {
    if (!Number.isFinite(adx)) return "n/a";
    if (adx < 18) return "<18";
    if (adx < 25) return "18-24.99";
    if (adx < 35) return "25-34.99";
    return ">=35";
}

function rsiBucket(rsi) {
    if (!Number.isFinite(rsi)) return "n/a";
    if (rsi < 40) return "<40";
    if (rsi < 45) return "40-44.99";
    if (rsi < 55) return "45-54.99";
    if (rsi < 60) return "55-59.99";
    return ">=60";
}

function atrPctBucket(atrPct) {
    if (!Number.isFinite(atrPct)) return "n/a";
    if (atrPct < 0.0002) return "<0.02%";
    if (atrPct < 0.00035) return "0.02-0.035%";
    if (atrPct < 0.0006) return "0.035-0.06%";
    return ">=0.06%";
}

function weekdayLabel(tsMs) {
    const day = new Date(tsMs).getUTCDay();
    return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][day] || "UNK";
}

function utcHourBucket(tsMs) {
    const hour = new Date(tsMs).getUTCHours();
    if (hour < 6) return "00-05";
    if (hour < 12) return "06-11";
    if (hour < 18) return "12-17";
    return "18-23";
}

function buildEntryContext({ symbol, tsMs, decision, snapshot }) {
    const side = String(decision?.step5?.orderPlan?.side || "").toUpperCase();
    const h1 = snapshot?.indicators?.h1 || null;
    const m15 = snapshot?.indicators?.m15 || null;
    const m5 = snapshot?.indicators?.m5 || null;
    const activeSessionRaw = decision?.step1?.activeSession || snapshot?.sessions?.[0] || "UNKNOWN";
    const session = String(activeSessionRaw || "UNKNOWN").toUpperCase();
    const h1Trend = pickTrend(h1);
    const m15Trend = pickTrend(m15);
    const m5Trend = pickTrend(m5);
    const h1Adx = adxValue(h1);
    const m15Rsi = toNum(m15?.rsi);
    const m5Rsi = toNum(m5?.rsi);
    const m5AtrPct = toNum(m5?.atrPct);
    const regimeType = String(decision?.step2?.regimeType || "UNKNOWN").toUpperCase();
    const setupType = String(decision?.step3?.setupType || "NONE").toUpperCase();
    const triggerScore = toNum(decision?.step4?.triggerScore);
    const structureBreakOk = Boolean(decision?.step4?.logFields?.structureBreakOk);
    const fvgDetected = Boolean(decision?.step4?.fvg?.exists);

    return {
        symbol,
        side,
        session,
        regimeType,
        setupType,
        triggerScore,
        h1Trend,
        m15Trend,
        m5Trend,
        trendStack: `${h1Trend}|${m15Trend}|${m5Trend}`,
        sideAlignedH1: sideMatchesTrend(side, h1Trend),
        sideAlignedM15: sideMatchesTrend(side, m15Trend),
        sideAlignedM5: sideMatchesTrend(side, m5Trend),
        h1Adx,
        h1AdxBucket: adxBucket(h1Adx),
        m15Rsi,
        m15RsiBucket: rsiBucket(m15Rsi),
        m5Rsi,
        m5RsiBucket: rsiBucket(m5Rsi),
        m5AtrPct,
        m5AtrPctBucket: atrPctBucket(m5AtrPct),
        structureBreakOk,
        fvgDetected,
        weekday: weekdayLabel(tsMs),
        hourBucketUtc: utcHourBucket(tsMs),
    };
}

function passesEntryFilters(entryContext) {
    if (!entryContext) return { allowed: false, reason: "missing_entry_context" };

    if (FILTER_SESSIONS.length && !FILTER_SESSIONS.includes(entryContext.session)) {
        return { allowed: false, reason: "session_filter" };
    }

    if (FILTER_SYMBOL_SESSIONS.size) {
        const allowedSessions = FILTER_SYMBOL_SESSIONS.get(String(entryContext.symbol || "").toUpperCase());
        if (allowedSessions && !allowedSessions.has(String(entryContext.session || "").toUpperCase())) {
            return { allowed: false, reason: "symbol_session_filter" };
        }
    }

    if (FILTER_REQUIRE_H1_M15_ALIGN) {
        const aligned = entryContext.h1Trend === entryContext.m15Trend && entryContext.sideAlignedH1 && entryContext.sideAlignedM15;
        if (!aligned) return { allowed: false, reason: "h1_m15_align_filter" };
    }

    if (FILTER_REQUIRE_M15_M5_ALIGN) {
        const aligned = entryContext.m15Trend === entryContext.m5Trend && entryContext.sideAlignedM15 && entryContext.sideAlignedM5;
        if (!aligned) return { allowed: false, reason: "m15_m5_align_filter" };
    }

    if (Number.isFinite(FILTER_MIN_H1_ADX) && (!Number.isFinite(entryContext.h1Adx) || entryContext.h1Adx < FILTER_MIN_H1_ADX)) {
        return { allowed: false, reason: "min_h1_adx_filter" };
    }

    if (Number.isFinite(FILTER_MAX_H1_ADX) && (!Number.isFinite(entryContext.h1Adx) || entryContext.h1Adx > FILTER_MAX_H1_ADX)) {
        return { allowed: false, reason: "max_h1_adx_filter" };
    }

    if (Number.isFinite(FILTER_MIN_M15_RSI) && (!Number.isFinite(entryContext.m15Rsi) || entryContext.m15Rsi < FILTER_MIN_M15_RSI)) {
        return { allowed: false, reason: "min_m15_rsi_filter" };
    }

    if (Number.isFinite(FILTER_MAX_M15_RSI) && (!Number.isFinite(entryContext.m15Rsi) || entryContext.m15Rsi > FILTER_MAX_M15_RSI)) {
        return { allowed: false, reason: "max_m15_rsi_filter" };
    }

    if (FILTER_REQUIRE_FVG && !entryContext.fvgDetected) {
        return { allowed: false, reason: "fvg_filter" };
    }

    if (FILTER_REQUIRE_STRUCTURE_BREAK && !entryContext.structureBreakOk) {
        return { allowed: false, reason: "structure_break_filter" };
    }

    return { allowed: true, reason: null };
}

function ensureStat(map, group, value) {
    const key = `${group}|${value}`;
    if (!map.has(key)) {
        map.set(key, {
            group,
            value,
            trades: 0,
            wins: 0,
            losses: 0,
            netR: 0,
            grossWinR: 0,
            grossLossR: 0,
            rawPnl: 0,
        });
    }
    return map.get(key);
}

function applyTradeToStat(stat, trade) {
    stat.trades += 1;
    stat.netR += Number(trade?.r) || 0;
    stat.rawPnl += Number(trade?.rawPnl) || 0;
    if (trade.r > 0) {
        stat.wins += 1;
        stat.grossWinR += trade.r;
    } else if (trade.r < 0) {
        stat.losses += 1;
        stat.grossLossR += Math.abs(trade.r);
    }
}

function patternRowsFromStats(statMap, minTrades) {
    return [...statMap.values()]
        .filter((row) => row.trades >= minTrades)
        .map((row) => {
            const expectancyR = row.trades > 0 ? row.netR / row.trades : null;
            return {
                ...row,
                winrate: row.trades > 0 ? row.wins / row.trades : null,
                pf: row.grossLossR > 0 ? row.grossWinR / row.grossLossR : null,
                expectancyR,
            };
        });
}

function buildPatternStats(closedTrades, minTrades = MIN_PATTERN_TRADES) {
    const stats = new Map();
    for (const trade of closedTrades) {
        const ctx = trade?.entryContext || {};
        applyTradeToStat(ensureStat(stats, "symbol", ctx.symbol || "UNKNOWN"), trade);

        const pairs = [
            ["session", ctx.session],
            ["regime", ctx.regimeType],
            ["setup", ctx.setupType],
            ["trend_stack_h1_m15_m5", ctx.trendStack],
            ["h1_adx_bucket", ctx.h1AdxBucket],
            ["m15_rsi_bucket", ctx.m15RsiBucket],
            ["m5_rsi_bucket", ctx.m5RsiBucket],
            ["m5_atr_pct_bucket", ctx.m5AtrPctBucket],
            ["fvg_detected", ctx.fvgDetected ? "yes" : "no"],
            ["structure_break", ctx.structureBreakOk ? "yes" : "no"],
            ["weekday", ctx.weekday],
            ["utc_hour_bucket", ctx.hourBucketUtc],
            ["h1_m15_align", ctx.h1Trend === ctx.m15Trend ? "yes" : "no"],
            ["m15_m5_align", ctx.m15Trend === ctx.m5Trend ? "yes" : "no"],
            ["side_h1_align", ctx.sideAlignedH1 ? "yes" : "no"],
            ["side_m15_align", ctx.sideAlignedM15 ? "yes" : "no"],
            ["side_m5_align", ctx.sideAlignedM5 ? "yes" : "no"],
        ];
        for (const [group, value] of pairs) {
            const normalizedValue = value === undefined || value === null || value === "" ? "n/a" : String(value);
            applyTradeToStat(ensureStat(stats, group, normalizedValue), trade);
        }
    }

    const allRows = patternRowsFromStats(stats, minTrades);
    const bestRows = [...allRows]
        .sort((a, b) => {
            if ((b.expectancyR || -Infinity) !== (a.expectancyR || -Infinity)) return (b.expectancyR || -Infinity) - (a.expectancyR || -Infinity);
            return b.trades - a.trades;
        })
        .slice(0, 24);
    const worstRows = [...allRows]
        .sort((a, b) => {
            if ((a.expectancyR || Infinity) !== (b.expectancyR || Infinity)) return (a.expectancyR || Infinity) - (b.expectancyR || Infinity);
            return b.trades - a.trades;
        })
        .slice(0, 12);

    return { allRows, bestRows, worstRows };
}

function activeFilterSummary() {
    const active = [];
    if (FILTER_REQUIRE_H1_M15_ALIGN) active.push("require_h1_m15_align");
    if (FILTER_REQUIRE_M15_M5_ALIGN) active.push("require_m15_m5_align");
    if (FILTER_REQUIRE_FVG) active.push("require_fvg");
    if (FILTER_REQUIRE_STRUCTURE_BREAK) active.push("require_structure_break");
    if (Number.isFinite(FILTER_MIN_H1_ADX)) active.push(`min_h1_adx=${FILTER_MIN_H1_ADX}`);
    if (Number.isFinite(FILTER_MAX_H1_ADX)) active.push(`max_h1_adx=${FILTER_MAX_H1_ADX}`);
    if (Number.isFinite(FILTER_MIN_M15_RSI)) active.push(`min_m15_rsi=${FILTER_MIN_M15_RSI}`);
    if (Number.isFinite(FILTER_MAX_M15_RSI)) active.push(`max_m15_rsi=${FILTER_MAX_M15_RSI}`);
    if (FILTER_SESSIONS.length) active.push(`sessions=${FILTER_SESSIONS.join(",")}`);
    if (FILTER_SYMBOL_SESSIONS.size) {
        const pairs = [...FILTER_SYMBOL_SESSIONS.entries()]
            .map(([symbol, sessions]) => `${symbol}:${[...sessions].join("|")}`)
            .sort((a, b) => a.localeCompare(b));
        active.push(`symbol_sessions=${pairs.join(";")}`);
    }
    return active.length ? active.join("; ") : "none";
}

function writeJsonReport(payload) {
    if (!REPORT_JSON_PATH) return null;
    const outputPath = path.isAbsolute(REPORT_JSON_PATH) ? REPORT_JSON_PATH : path.join(process.cwd(), REPORT_JSON_PATH);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    return outputPath;
}

async function run() {
    const targetSymbols = TARGET_SYMBOLS_FROM_ENV.length ? TARGET_SYMBOLS_FROM_ENV : discoverSymbolsFromDataset();
    if (!targetSymbols.length) {
        throw new Error("No symbols with complete M1/M5/M15/H1 datasets found.");
    }

    const nowMs = Date.now();
    const envStartMs = parseTimestamp(RANGE_START_FROM_ENV);
    const envEndMs = parseTimestamp(RANGE_END_FROM_ENV);
    const endMs = Number.isFinite(envEndMs) ? envEndMs : nowMs;

    let startMs;
    if (Number.isFinite(envStartMs)) {
        startMs = envStartMs;
    } else if (Number.isFinite(DAYS_BACK) && DAYS_BACK > 0) {
        startMs = endMs - DAYS_BACK * 24 * 60 * 60 * 1000;
    } else {
        const rangeStart = new Date(endMs);
        rangeStart.setUTCMonth(rangeStart.getUTCMonth() - MONTHS_BACK);
        startMs = rangeStart.getTime();
    }
    if (!(endMs > startMs)) {
        throw new Error(`Invalid replay range: start=${new Date(startMs).toISOString()} end=${new Date(endMs).toISOString()}`);
    }
    const warmupStartMs = startMs - 3 * 24 * 60 * 60 * 1000;

    const loaded = await Promise.all(targetSymbols.map((s) => loadSymbolData(s, warmupStartMs, endMs)));
    const dataBySymbol = new Map(loaded.map((x) => [x.symbol, x]));

    for (const symbol of targetSymbols) {
        const d = dataBySymbol.get(symbol);
        if (!d || !d.M1.length || !d.M5.length || !d.M15.length || !d.H1.length) {
            throw new Error(`Missing required dataset for ${symbol}`);
        }
    }

    const actualStartMs = Math.max(
        startMs,
        ...targetSymbols.map((symbol) => {
            const row = dataBySymbol.get(symbol).M1.find((x) => x.tsMs >= startMs);
            return row ? row.tsMs : Number.POSITIVE_INFINITY;
        }),
    );
    if (!Number.isFinite(actualStartMs)) {
        throw new Error("No overlapping data in selected period.");
    }

    const riskPhases = buildRiskPhases(actualStartMs);
    const primaryRiskPct = Number(riskPhases[0]?.riskPct) || PHASE1_RISK_PCT;

    function riskPctForTs(tsMs) {
        for (const phase of riskPhases) {
            if (tsMs >= phase.startMs && tsMs < phase.endMs) return phase.riskPct;
        }
        return Number(riskPhases[riskPhases.length - 1]?.riskPct) || primaryRiskPct;
    }

    function phaseKeyForTs(tsMs) {
        for (const phase of riskPhases) {
            if (tsMs >= phase.startMs && tsMs < phase.endMs) return phase.key;
        }
        return String(riskPhases[riskPhases.length - 1]?.key || `PHASE_1_${riskPctLabel(primaryRiskPct)}`);
    }

    const timelineSet = new Set();
    for (const symbol of targetSymbols) {
        for (const row of dataBySymbol.get(symbol).M1) {
            if (row.tsMs < actualStartMs || row.tsMs > endMs) continue;
            timelineSet.add(row.tsMs);
        }
    }
    const timeline = [...timelineSet].sort((a, b) => a - b);
    if (!timeline.length) throw new Error("Empty timeline in selected period.");

    const configOverrides = parseConfigOverrides();
    const replayConfigBase = mergeIntradayConfig(
        {
            pairOverrides: cryptoPairOverridesForSymbols(targetSymbols),
        },
        configOverrides,
    );
    const engine = createIntradaySevenStepEngine(
        mergeIntradayConfig(replayConfigBase, {
            risk: {
                forexRiskPct: primaryRiskPct,
            },
        }),
    );
    const state = createIntradayRuntimeState({ strategyId: "INTRADAY_7STEP_FOREX" });

    const pointers = {};
    for (const symbol of targetSymbols) {
        pointers[symbol] = { M1: -1, M5: -1, M15: -1, H1: -1 };
    }

    let equity = START_CAPITAL;
    let equityPeak = START_CAPITAL;
    let maxDdAbs = 0;
    let maxDdPct = 0;

    const openPositions = new Map();
    const closedTrades = [];

    const pairStats = new Map();
    const weeklyStats = new Map();
    const weeklyPairStats = new Map();
    const phaseStats = new Map();
    const blockedByEntryFilter = new Map();
    let lastRolloverCloseKey = null;

    function ensurePair(symbol) {
        if (!pairStats.has(symbol)) {
            pairStats.set(symbol, { symbol, trades: 0, wins: 0, losses: 0, netR: 0, grossWinR: 0, grossLossR: 0, rawPnl: 0 });
        }
        return pairStats.get(symbol);
    }

    function ensureWeek(tsMs) {
        const key = weekStartUtc(tsMs);
        if (!weeklyStats.has(key)) {
            weeklyStats.set(key, {
                weekStartMs: key,
                trades: 0,
                wins: 0,
                losses: 0,
                netR: 0,
                grossWinR: 0,
                grossLossR: 0,
                rawPnl: 0,
                startEquity: equity,
                endEquity: equity,
                peakEquity: equity,
                maxDdPct: 0,
            });
        }
        return weeklyStats.get(key);
    }

    function ensureWeekPair(tsMs, symbol) {
        const weekKey = weekStartUtc(tsMs);
        const key = `${weekKey}|${symbol}`;
        if (!weeklyPairStats.has(key)) {
            weeklyPairStats.set(key, {
                weekStartMs: weekKey,
                symbol,
                trades: 0,
                wins: 0,
                losses: 0,
                netR: 0,
                grossWinR: 0,
                grossLossR: 0,
                rawPnl: 0,
            });
        }
        return weeklyPairStats.get(key);
    }

    function ensurePhase(tsMs) {
        const key = phaseKeyForTs(tsMs);
        if (!phaseStats.has(key)) {
            phaseStats.set(key, {
                phase: key,
                trades: 0,
                wins: 0,
                losses: 0,
                netR: 0,
                grossWinR: 0,
                grossLossR: 0,
                rawPnl: 0,
            });
        }
        return phaseStats.get(key);
    }

    function syncStateOpenPositions() {
        state.openPositions = new Map();
        for (const [symbol, pos] of openPositions.entries()) {
            state.openPositions.set(symbol, {
                symbol,
                side: pos.side,
                entryPrice: pos.entryPrice,
                currentSl: pos.currentSl,
                initialSl: pos.initialSl,
                takeProfit: pos.takeProfit,
                size: pos.size,
                entryTimestamp: pos.entryTimestamp,
                assetClass: "forex",
            });
        }
    }

    function updateEquityDrawdown(tsMs) {
        if (equity > equityPeak) equityPeak = equity;
        const ddAbs = equityPeak - equity;
        const ddPct = equityPeak > 0 ? ddAbs / equityPeak : 0;
        if (ddAbs > maxDdAbs) maxDdAbs = ddAbs;
        if (ddPct > maxDdPct) maxDdPct = ddPct;

        const week = ensureWeek(tsMs);
        week.endEquity = equity;
        if (equity > week.peakEquity) week.peakEquity = equity;
        const weekDdAbs = week.peakEquity - equity;
        const weekDdPct = week.peakEquity > 0 ? weekDdAbs / week.peakEquity : 0;
        if (weekDdPct > week.maxDdPct) week.maxDdPct = weekDdPct;
    }

    function closePosition({ symbol, pos, closePrice, tsMs, reason }) {
        const executedClosePrice = applyAdverseFill({ symbol, side: pos.side, price: closePrice, phase: "exit" });
        if (!Number.isFinite(executedClosePrice)) return;

        const riskDistance = Math.abs(pos.entryPrice - pos.initialSl);
        if (!(riskDistance > 0)) return;

        const pnlDistance = pos.side === "LONG" ? executedClosePrice - pos.entryPrice : pos.entryPrice - executedClosePrice;
        const r = pnlDistance / riskDistance;
        const pnl = pos.riskAmount * r;

        equity += pnl;
        updateEquityDrawdown(tsMs);

        const closed = {
            symbol,
            side: pos.side,
            plannedEntryPrice: pos.plannedEntryPrice,
            entryPrice: pos.entryPrice,
            rawClosePrice: closePrice,
            closePrice: executedClosePrice,
            sl: pos.initialSl,
            tp: pos.takeProfit,
            entryTsMs: pos.entryTsMs,
            closeTsMs: tsMs,
            entryTimestamp: pos.entryTimestamp,
            closeTimestamp: new Date(tsMs).toISOString(),
            riskPct: pos.riskPct,
            riskAmount: pos.riskAmount,
            r,
            rawPnl: pnl,
            reason,
            entryContext: pos.entryContext || null,
        };
        closedTrades.push(closed);

        const pair = ensurePair(symbol);
        pair.trades += 1;
        pair.netR += r;
        pair.rawPnl += pnl;
        if (r > 0) {
            pair.wins += 1;
            pair.grossWinR += r;
        } else if (r < 0) {
            pair.losses += 1;
            pair.grossLossR += Math.abs(r);
        }

        const week = ensureWeek(tsMs);
        week.trades += 1;
        week.netR += r;
        week.rawPnl += pnl;
        if (r > 0) {
            week.wins += 1;
            week.grossWinR += r;
        } else if (r < 0) {
            week.losses += 1;
            week.grossLossR += Math.abs(r);
        }

        const weekPair = ensureWeekPair(tsMs, symbol);
        weekPair.trades += 1;
        weekPair.netR += r;
        weekPair.rawPnl += pnl;
        if (r > 0) {
            weekPair.wins += 1;
            weekPair.grossWinR += r;
        } else if (r < 0) {
            weekPair.losses += 1;
            weekPair.grossLossR += Math.abs(r);
        }

        const phase = ensurePhase(pos.entryTsMs);
        phase.trades += 1;
        phase.netR += r;
        phase.rawPnl += pnl;
        if (r > 0) {
            phase.wins += 1;
            phase.grossWinR += r;
        } else if (r < 0) {
            phase.losses += 1;
            phase.grossLossR += Math.abs(r);
        }

        openPositions.delete(symbol);
        registerClosedTrade(state, { symbol, pnl });
    }

    function openRiskPct() {
        let sum = 0;
        for (const pos of openPositions.values()) sum += Number(pos.riskPct) || 0;
        return sum;
    }

    function openUsedMargin() {
        let sum = 0;
        for (const pos of openPositions.values()) {
            sum += Number(pos.marginRequired) || 0;
        }
        return sum;
    }

    function shouldBlockNewTrade(symbol, tsMs, nextRiskPct) {
        const dayKey = utcDayKey(tsMs);
        const periodClosed = closedTrades.filter((t) => utcDayKey(t.closeTsMs) === dayKey);
        const todayEstimatedPnlPct = periodClosed.reduce((sum, t) => sum + t.r * (Number(t.riskPct) || 0), 0);
        const todayEstimatedLossPctAbs = Math.abs(Math.min(0, todayEstimatedPnlPct));
        if (MAX_DAILY_LOSS_PCT > 0 && todayEstimatedLossPctAbs >= MAX_DAILY_LOSS_PCT) {
            return { blocked: true, reason: "daily_loss_limit" };
        }

        const { currentLossStreak, lastLossAtMs } = computeTradeSummaryForGuards(closedTrades);
        if (MAX_LOSS_STREAK > 0 && LOSS_STREAK_COOLDOWN_MINUTES > 0 && currentLossStreak >= MAX_LOSS_STREAK) {
            const cooldownMs = LOSS_STREAK_COOLDOWN_MINUTES * 60 * 1000;
            const cooldownActive = Number.isFinite(lastLossAtMs) ? tsMs - lastLossAtMs < cooldownMs : true;
            if (cooldownActive) {
                return { blocked: true, reason: "loss_streak_cooldown" };
            }
        }

        if (openRiskPct() + nextRiskPct > MAX_OPEN_RISK_PCT + 1e-9) {
            return { blocked: true, reason: "open_risk_cap" };
        }

        return { blocked: false, reason: null };
    }

    function applyTrailingAndBreakeven(pos, currentPrice, indicators) {
        const trailActivationProgress = Number.isFinite(Number(EXITS?.TRAIL_ACTIVATION_TP_PROGRESS))
            ? Number(EXITS.TRAIL_ACTIVATION_TP_PROGRESS)
            : 0.45;
        const breakevenActivationProgress = Number.isFinite(Number(EXITS?.BREAKEVEN_ACTIVATION_TP_PROGRESS))
            ? Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS)
            : 0.5;
        const trailFraction = Number.isFinite(Number(EXITS?.TRAIL_DISTANCE_TP_FRACTION)) ? Number(EXITS.TRAIL_DISTANCE_TP_FRACTION) : 0.18;
        const atrMultiplier = Number.isFinite(Number(EXITS?.TRAIL_DISTANCE_ATR_MULTIPLIER)) ? Number(EXITS.TRAIL_DISTANCE_ATR_MULTIPLIER) : 0.8;

        const progress = tpProgress(pos.side, pos.entryPrice, pos.takeProfit, currentPrice);
        if (!Number.isFinite(progress) || progress < trailActivationProgress) return;

        const m5 = indicators?.m5 || null;
        const m15 = indicators?.m15 || null;
        const m5Trend = pickTrend(m5);
        const m15Trend = pickTrend(m15);
        const broken =
            (pos.side === "LONG" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
            (pos.side === "SHORT" && (m5Trend === "bullish" || m15Trend === "bullish"));
        if (broken && EXITS?.SOFT_EXIT_ON_M5_M15_BREAK !== false && progress >= breakevenActivationProgress) {
            pos.currentSl = pos.entryPrice;
            return;
        }

        const entry = Number(pos.entryPrice);
        const tp = Number(pos.takeProfit);
        const price = Number(currentPrice);
        const tpDist = Math.abs(tp - entry);
        if (!(tpDist > 0)) return;
        const activation = pos.side === "LONG" ? entry + tpDist * trailActivationProgress : entry - tpDist * trailActivationProgress;
        const activated = pos.side === "LONG" ? price >= activation : price <= activation;
        if (!activated) return;

        const m5Atr = toNum(m5?.atr);
        const m15Atr = toNum(m15?.atr);
        const atrFloor = Math.max(
            0,
            (Number.isFinite(m5Atr) ? m5Atr : 0) * atrMultiplier,
            (Number.isFinite(m15Atr) ? m15Atr : 0) * atrMultiplier * 0.5,
        );
        const trailDist = Math.max(tpDist * trailFraction, atrFloor);
        const newSl = pos.side === "LONG" ? price - trailDist : price + trailDist;
        if (pos.side === "LONG") {
            if (!Number.isFinite(pos.currentSl) || newSl > pos.currentSl) pos.currentSl = newSl;
            return;
        }
        if (!Number.isFinite(pos.currentSl) || newSl < pos.currentSl) pos.currentSl = newSl;
    }

    for (const tsMs of timeline) {
        ensureStateDay(state, tsMs);
        updateEquityDrawdown(tsMs);

        const pointerMovedBySymbol = new Map();
        for (const symbol of targetSymbols) {
            const d = dataBySymbol.get(symbol);
            const ptr = pointers[symbol];
            const move = (arr, idx) => {
                let i = idx;
                while (i + 1 < arr.length && arr[i + 1].tsMs <= tsMs) i += 1;
                return i;
            };
            const prevM1 = ptr.M1;
            ptr.M1 = move(d.M1, ptr.M1);
            ptr.M5 = move(d.M5, ptr.M5);
            ptr.M15 = move(d.M15, ptr.M15);
            ptr.H1 = move(d.H1, ptr.H1);
            pointerMovedBySymbol.set(symbol, ptr.M1 !== prevM1);
        }

        syncStateOpenPositions();

        const rolloverKey = getDateKeyInTimeZone(ROLLOVER_TIMEZONE, tsMs);
        if (isRolloverBuffer(tsMs) && rolloverKey !== lastRolloverCloseKey) {
            lastRolloverCloseKey = rolloverKey;
            for (const [symbol, pos] of [...openPositions.entries()]) {
                const ptr = pointers[symbol];
                const row = ptr.M1 >= 0 ? dataBySymbol.get(symbol).M1[ptr.M1] : null;
                const closePrice = toNum(row?.close);
                if (!Number.isFinite(closePrice)) continue;
                closePosition({ symbol, pos, closePrice, tsMs, reason: "rollover" });
            }
            syncStateOpenPositions();
        }

        for (const [symbol, pos] of [...openPositions.entries()]) {
            if (!pointerMovedBySymbol.get(symbol)) continue;
            const ptr = pointers[symbol];
            if (ptr.M1 < 0) continue;
            const m1 = dataBySymbol.get(symbol).M1[ptr.M1];
            const high = toNum(m1?.high);
            const low = toNum(m1?.low);
            const sl = toNum(pos.currentSl);
            const tp = toNum(pos.takeProfit);
            let slHit = false;
            let tpHit = false;
            if (pos.side === "LONG") {
                slHit = Number.isFinite(low) && Number.isFinite(sl) && low <= sl;
                tpHit = Number.isFinite(high) && Number.isFinite(tp) && high >= tp;
            } else {
                slHit = Number.isFinite(high) && Number.isFinite(sl) && high >= sl;
                tpHit = Number.isFinite(low) && Number.isFinite(tp) && low <= tp;
            }
            if (slHit || tpHit) {
                const closePrice = slHit ? sl : tp;
                closePosition({ symbol, pos, closePrice, tsMs, reason: slHit ? "hit_sl" : "hit_tp" });
                continue;
            }

            if (ptr.M5 >= 0 && ptr.M15 >= 0) {
                const m5 = dataBySymbol.get(symbol).M5[ptr.M5];
                const m15 = dataBySymbol.get(symbol).M15[ptr.M15];
                const currentPrice = toNum(m1?.close);
                if (Number.isFinite(currentPrice)) {
                    applyTrailingAndBreakeven(pos, currentPrice, { m5, m15 });
                }
            }
        }

        syncStateOpenPositions();

        const activeUniverse = getActiveForexSymbols(tsMs).filter((s) => targetSymbols.includes(s));
        for (const symbol of activeUniverse) {
            const ptr = pointers[symbol];
            if (ptr.M1 < 0 || ptr.M5 < 2 || ptr.M15 < 1 || ptr.H1 < 0) continue;
            if (!pointerMovedBySymbol.get(symbol)) continue;

            const d = dataBySymbol.get(symbol);
            const m1 = d.M1[ptr.M1];
            const m5 = d.M5[ptr.M5];
            const m5Prev = d.M5[ptr.M5 - 1];
            const m5Prev2 = d.M5[ptr.M5 - 2];
            const m15 = d.M15[ptr.M15];
            const m15Prev = d.M15[ptr.M15 - 1];
            const h1 = d.H1[ptr.H1];

            const mid = toNum(m1?.close);
            if (!Number.isFinite(mid)) continue;
            const spread = spreadPriceForSymbol(symbol);
            const bid = mid - spread * 0.5;
            const ask = mid + spread * 0.5;

            const snapshot = {
                symbol,
                timestamp: m1.timestamp,
                bid,
                ask,
                mid,
                spread,
                sessions: getActiveSessionNames(tsMs),
                newsBlocked: false,
                equity,
                indicators: { h1, m15, m5, m1 },
                bars: {
                    h1: toBar(h1),
                    m15: toBar(m15),
                    m5: toBar(m5),
                    m1: toBar(m1),
                },
                prevBars: {
                    m15: toBar(m15Prev),
                    m5: toBar(m5Prev),
                },
                prev2Bars: {
                    m5: toBar(m5Prev2),
                },
            };

            const decision = engine.evaluateSnapshot({ snapshot, state });
            const plan = decision?.step5?.orderPlan || null;
            if (!decision?.step5?.valid || !plan) continue;

            if (openPositions.size >= MAX_POSITIONS) continue;
            if (openPositions.has(symbol)) continue;

            const entryContext = buildEntryContext({ symbol, tsMs, decision, snapshot });
            const filterDecision = passesEntryFilters(entryContext);
            if (!filterDecision.allowed) {
                const reason = filterDecision.reason || "entry_filter_block";
                blockedByEntryFilter.set(reason, (blockedByEntryFilter.get(reason) || 0) + 1);
                continue;
            }

            const phaseRiskPct = riskPctForTs(tsMs);

            const side = String(plan.side || "").toUpperCase();
            const plannedEntryPrice = toNum(plan.entryPrice);
            const sl = toNum(plan.sl);
            const tp = toNum(plan.tp);
            const plannedSize = toNum(plan.size);
            const plannedRiskAmount = toNum(plan.riskAmount);
            // Respect symbol-specific step5 sizing, then scale it by the active replay phase multiplier.
            const riskSizingEquity = COMPOUND_RISK ? equity : START_CAPITAL;
            const plannedRiskPct = equity > 0 && Number.isFinite(plannedRiskAmount) ? plannedRiskAmount / equity : null;
            let targetRiskPct = phaseRiskPct;
            if (Number.isFinite(plannedRiskPct) && plannedRiskPct > 0) {
                const phaseScale = primaryRiskPct > 0 ? phaseRiskPct / primaryRiskPct : 1;
                targetRiskPct = plannedRiskPct * phaseScale;
            }
            const targetRiskAmount = riskSizingEquity * targetRiskPct;
            let size = plannedSize;
            if (Number.isFinite(plannedSize) && Number.isFinite(plannedRiskAmount) && plannedRiskAmount > 0) {
                size = plannedSize * (targetRiskAmount / plannedRiskAmount);
            }
            const entryPrice = applyAdverseFill({ symbol, side, price: plannedEntryPrice, phase: "entry" });
            if (![entryPrice, sl, tp, size, targetRiskAmount].every(Number.isFinite)) continue;
            if (!(targetRiskAmount > 0 && size > 0)) continue;
            if (!(Math.abs(entryPrice - sl) > 0)) continue;

            let marginRequired = null;
            if (ENFORCE_MARGIN) {
                const leverage = leverageForSymbol(symbol);
                if (!(Number.isFinite(leverage) && leverage > 0)) continue;
                const availableMargin = Math.max(0, equity * MARGIN_UTILIZATION - openUsedMargin());
                const plannedNotional = estimateNotionalInAccountCurrency({ symbol, size, entryPrice });
                if (!(Number.isFinite(plannedNotional) && plannedNotional > 0)) continue;
                const maxNotional = availableMargin * leverage;
                if (!(maxNotional > 0)) continue;
                if (plannedNotional > maxNotional) {
                    size *= maxNotional / plannedNotional;
                }
                if (!(size > 0)) continue;
                const notionalAfterScale = estimateNotionalInAccountCurrency({ symbol, size, entryPrice });
                if (!(Number.isFinite(notionalAfterScale) && notionalAfterScale > 0)) continue;
                marginRequired = notionalAfterScale / leverage;
                if (!(marginRequired > 0)) continue;
                if (openUsedMargin() + marginRequired > equity * MARGIN_UTILIZATION + 1e-9) continue;
            }

            const riskAmount = size * Math.abs(entryPrice - sl);
            const effectiveRiskPct = equity > 0 ? riskAmount / equity : null;
            if (!(Number.isFinite(effectiveRiskPct) && effectiveRiskPct > 0)) continue;

            const guard = shouldBlockNewTrade(symbol, tsMs, effectiveRiskPct);
            if (guard.blocked) continue;

            const pos = {
                symbol,
                side,
                plannedEntryPrice,
                plannedRiskAmount,
                entryPrice,
                currentSl: sl,
                initialSl: sl,
                takeProfit: tp,
                size,
                riskPct: effectiveRiskPct,
                riskAmount,
                marginRequired,
                entryTsMs: tsMs,
                entryTimestamp: m1.timestamp,
                entryContext,
            };
            if (!["LONG", "SHORT"].includes(pos.side)) continue;

            openPositions.set(symbol, pos);
            registerOpenedTrade(state, {
                symbol,
                side: pos.side,
                entryPrice: pos.entryPrice,
                currentSl: pos.currentSl,
                initialSl: pos.initialSl,
                takeProfit: pos.takeProfit,
                size: pos.size,
                entryTimestamp: pos.entryTimestamp,
                assetClass: "forex",
            });
            syncStateOpenPositions();
        }
    }

    for (const [symbol, pos] of [...openPositions.entries()]) {
        const ptr = pointers[symbol];
        if (ptr.M1 < 0) continue;
        const row = dataBySymbol.get(symbol).M1[ptr.M1];
        const closePrice = toNum(row?.close);
        if (!Number.isFinite(closePrice)) continue;
        closePosition({ symbol, pos, closePrice, tsMs: row.tsMs, reason: "period_end" });
    }

    const trades = closedTrades.length;
    const wins = closedTrades.filter((t) => t.r > 0).length;
    const losses = closedTrades.filter((t) => t.r < 0).length;
    const netR = closedTrades.reduce((sum, t) => sum + t.r, 0);
    const grossWinR = closedTrades.reduce((sum, t) => sum + (t.r > 0 ? t.r : 0), 0);
    const grossLossR = closedTrades.reduce((sum, t) => sum + (t.r < 0 ? Math.abs(t.r) : 0), 0);
    const pf = grossLossR > 0 ? grossWinR / grossLossR : null;
    const rawPnl = equity - START_CAPITAL;
    const holdDurationsMinutes = closedTrades
        .map((t) => (Number.isFinite(t.closeTsMs) && Number.isFinite(t.entryTsMs) ? (t.closeTsMs - t.entryTsMs) / 60000 : null))
        .filter((v) => Number.isFinite(v) && v >= 0);
    const avgHoldMinutes = holdDurationsMinutes.length ? holdDurationsMinutes.reduce((sum, v) => sum + v, 0) / holdDurationsMinutes.length : null;
    const sortedHoldDurations = [...holdDurationsMinutes].sort((a, b) => a - b);
    const medianHoldMinutes = sortedHoldDurations.length ? sortedHoldDurations[Math.floor((sortedHoldDurations.length - 1) / 2)] : null;

    const pairRows = [...pairStats.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const weekRows = [...weeklyStats.values()].sort((a, b) => a.weekStartMs - b.weekStartMs);
    const weekPairRows = [...weeklyPairStats.values()].sort((a, b) =>
        a.weekStartMs === b.weekStartMs ? a.symbol.localeCompare(b.symbol) : a.weekStartMs - b.weekStartMs,
    );
    const phaseRows = [...phaseStats.values()].sort((a, b) => a.phase.localeCompare(b.phase));
    const patternStats = buildPatternStats(closedTrades, MIN_PATTERN_TRADES);
    const blockedFilterRows = [...blockedByEntryFilter.entries()].sort((a, b) => b[1] - a[1]);

    const overallTable = renderTable(
        ["Metric", "Value"],
        [
            ["Range", `${new Date(actualStartMs).toISOString()} -> ${new Date(endMs).toISOString()}`],
            ["Symbols", targetSymbols.join(", ")],
            ["Start Capital", `${num(START_CAPITAL)} EUR`],
            ["End Capital", `${num(equity)} EUR`],
            ["Raw PnL", `${num(rawPnl)} EUR`],
            ["Return", pct(START_CAPITAL > 0 ? rawPnl / START_CAPITAL : null)],
            ["Trades", String(trades)],
            ["Winrate", pct(trades ? wins / trades : null)],
            ["Net R", num(netR, 4)],
            ["Profit Factor", num(pf, 4)],
            ["Avg Hold Time", Number.isFinite(avgHoldMinutes) ? `${num(avgHoldMinutes)} min` : "n/a"],
            ["Median Hold Time", Number.isFinite(medianHoldMinutes) ? `${num(medianHoldMinutes)} min` : "n/a"],
            ["Max Drawdown", `${num(maxDdAbs)} EUR (${pct(maxDdPct)})`],
            ["Guards", `maxPos=${MAX_POSITIONS}, openRiskCap=${pct(MAX_OPEN_RISK_PCT)}, dailyLoss=${MAX_DAILY_LOSS_PCT > 0 ? pct(MAX_DAILY_LOSS_PCT) : "disabled"}`],
            [
                "Execution Model",
                COST_MODEL_ENABLED
                    ? `enabled (spread=${SPREAD_PIPS.toFixed(2)} pips, slippage=${SLIPPAGE_PIPS_PER_FILL.toFixed(2)} pips/fill)`
                    : "disabled (mid-only fills)",
            ],
            [
                "Margin Model",
                ENFORCE_MARGIN
                    ? `enabled (${ACCOUNT_CURRENCY}, util=${pct(MARGIN_UTILIZATION)}, majorFX=${LEVERAGE_FX_MAJOR}:1, nonMajorFX=${LEVERAGE_FX_NON_MAJOR}:1)`
                    : "disabled",
            ],
            [
                "Risk Plan",
                describeRiskPlan(riskPhases),
            ],
            ["Risk Sizing", COMPOUND_RISK ? "compounding" : `fixed_start_capital(${num(START_CAPITAL)} EUR)`],
            ["Entry Filters", activeFilterSummary()],
            ["Entry Filter Blocks", String(blockedFilterRows.reduce((sum, [, count]) => sum + count, 0))],
            ["Live Filters", "sessions+weekend+rollover included, historical news unavailable in dataset"],
        ],
    );

    const pairTable = renderTable(
        ["Pair", "Trades", "Winrate", "Net R", "PF", "Raw PnL EUR"],
        pairRows.map((r) => [
            r.symbol,
            String(r.trades),
            pct(r.trades ? r.wins / r.trades : null),
            num(r.netR, 4),
            num(r.grossLossR > 0 ? r.grossWinR / r.grossLossR : null, 4),
            num(r.rawPnl),
        ]),
    );

    const weeklyTable = renderTable(
        ["Week", "Trades", "Winrate", "Net R", "PF", "Raw PnL EUR", "Week Return", "Week Max DD"],
        weekRows.map((w) => [
            isoDate(w.weekStartMs),
            String(w.trades),
            pct(w.trades ? w.wins / w.trades : null),
            num(w.netR, 4),
            num(w.grossLossR > 0 ? w.grossWinR / w.grossLossR : null, 4),
            num(w.rawPnl),
            pct(w.startEquity > 0 ? (w.endEquity - w.startEquity) / w.startEquity : null),
            pct(w.maxDdPct),
        ]),
    );

    const weeklyPairSymbols = [...targetSymbols].sort((a, b) => a.localeCompare(b));
    const weeklyPairPivotMap = new Map();
    for (const w of weekRows) {
        const bucket = { week: isoDate(w.weekStartMs), total: 0 };
        for (const symbol of weeklyPairSymbols) bucket[symbol] = 0;
        weeklyPairPivotMap.set(isoDate(w.weekStartMs), bucket);
    }
    for (const row of weekPairRows) {
        const week = isoDate(row.weekStartMs);
        const bucket = weeklyPairPivotMap.get(week);
        if (!bucket) continue;
        bucket[row.symbol] = (bucket[row.symbol] || 0) + row.rawPnl;
        bucket.total += row.rawPnl;
    }
    const weeklyPairPivot = [...weeklyPairPivotMap.values()].sort((a, b) => a.week.localeCompare(b.week));
    const weeklyPairTable = renderTable(
        ["Week", ...weeklyPairSymbols, "Total"],
        weeklyPairPivot.map((r) => [r.week, ...weeklyPairSymbols.map((symbol) => num(r[symbol])), num(r.total)]),
    );

    const phaseTable = renderTable(
        ["Phase", "Trades", "Winrate", "Net R", "PF", "Raw PnL EUR"],
        phaseRows.map((r) => [
            r.phase,
            String(r.trades),
            pct(r.trades ? r.wins / r.trades : null),
            num(r.netR, 4),
            num(r.grossLossR > 0 ? r.grossWinR / r.grossLossR : null, 4),
            num(r.rawPnl),
        ]),
    );

    const filterBlockTable =
        blockedFilterRows.length > 0
            ? renderTable(
                  ["Filter Reason", "Count"],
                  blockedFilterRows.map(([reason, count]) => [reason, String(count)]),
              )
            : null;

    const bestPatternRows =
        patternStats.bestRows.length > 0
            ? patternStats.bestRows
            : [
                  {
                      group: "n/a",
                      value: `No pattern with >=${MIN_PATTERN_TRADES} trades`,
                      trades: 0,
                      winrate: null,
                      expectancyR: null,
                      netR: 0,
                      pf: null,
                      rawPnl: 0,
                  },
              ];
    const worstPatternRows =
        patternStats.worstRows.length > 0
            ? patternStats.worstRows
            : [
                  {
                      group: "n/a",
                      value: `No pattern with >=${MIN_PATTERN_TRADES} trades`,
                      trades: 0,
                      winrate: null,
                      expectancyR: null,
                      netR: 0,
                      pf: null,
                      rawPnl: 0,
                  },
              ];
    const patternBestTable = renderTable(
        ["Group", "Value", "Trades", "Winrate", "Exp R/Trade", "Net R", "PF", "Raw PnL EUR"],
        bestPatternRows.map((r) => [
            r.group,
            r.value,
            String(r.trades),
            pct(r.winrate),
            num(r.expectancyR, 4),
            num(r.netR, 4),
            num(r.pf, 4),
            num(r.rawPnl),
        ]),
    );
    const patternWorstTable = renderTable(
        ["Group", "Value", "Trades", "Winrate", "Exp R/Trade", "Net R", "PF", "Raw PnL EUR"],
        worstPatternRows.map((r) => [
            r.group,
            r.value,
            String(r.trades),
            pct(r.winrate),
            num(r.expectancyR, 4),
            num(r.netR, 4),
            num(r.pf, 4),
            num(r.rawPnl),
        ]),
    );

    const reportPath = writeJsonReport({
        generatedAt: new Date().toISOString(),
        config: {
            targetSymbols,
            targetTimeframes: TARGET_TIMEFRAMES,
            startCapital: START_CAPITAL,
            daysBack: DAYS_BACK,
            monthsBack: MONTHS_BACK,
            rangeStartFromEnv: RANGE_START_FROM_ENV || null,
            rangeEndFromEnv: RANGE_END_FROM_ENV || null,
            phase1RiskPct: PHASE1_RISK_PCT,
            phase2RiskPct: PHASE2_RISK_PCT,
            phase2StartAfterMonths: PHASE2_START_AFTER_MONTHS,
            riskPhases,
            costModelEnabled: COST_MODEL_ENABLED,
            spreadPips: SPREAD_PIPS,
            slippagePipsPerFill: SLIPPAGE_PIPS_PER_FILL,
            enforceMargin: ENFORCE_MARGIN,
            marginUtilization: MARGIN_UTILIZATION,
            accountCurrency: ACCOUNT_CURRENCY,
            leverageFxMajor: LEVERAGE_FX_MAJOR,
            leverageFxNonMajor: LEVERAGE_FX_NON_MAJOR,
            maxPositions: MAX_POSITIONS,
            maxOpenRiskPct: MAX_OPEN_RISK_PCT,
            compoundRisk: COMPOUND_RISK,
            filters: activeFilterSummary(),
            minPatternTrades: MIN_PATTERN_TRADES,
            configOverrides: Object.keys(configOverrides || {}).length ? configOverrides : null,
        },
        summary: {
            rangeStartIso: new Date(actualStartMs).toISOString(),
            rangeEndIso: new Date(endMs).toISOString(),
            trades,
            wins,
            losses,
            winrate: trades ? wins / trades : null,
            netR,
            grossWinR,
            grossLossR,
            profitFactor: pf,
            startCapital: START_CAPITAL,
            endCapital: equity,
            rawPnl,
            returnPct: START_CAPITAL > 0 ? rawPnl / START_CAPITAL : null,
            avgHoldMinutes,
            medianHoldMinutes,
            maxDrawdownAbs: maxDdAbs,
            maxDrawdownPct: maxDdPct,
        },
        blockedEntryFilters: blockedFilterRows.map(([reason, count]) => ({ reason, count })),
        pairRows,
        weekRows: weekRows.map((w) => ({ ...w, week: isoDate(w.weekStartMs) })),
        weekPairRows: weekPairRows.map((w) => ({ ...w, week: isoDate(w.weekStartMs) })),
        phaseRows,
        patternStats,
        closedTrades,
    });

    const replayLabel =
        Number.isFinite(envStartMs) || Number.isFinite(envEndMs)
            ? `CUSTOM RANGE (${new Date(actualStartMs).toISOString()} -> ${new Date(endMs).toISOString()})`
            : `${MONTHS_BACK} MONTHS`;
    console.log(`\n=== LIVE PARITY REPLAY (${replayLabel}) ===`);
    console.log(overallTable);
    console.log("\n=== BY RISK PHASE ===");
    console.log(phaseTable);
    console.log("\n=== BY PAIR ===");
    console.log(pairTable);
    console.log("\n=== WEEKLY PORTFOLIO ===");
    console.log(weeklyTable);
    console.log("\n=== WEEKLY RAW PNL BY PAIR ===");
    console.log(weeklyPairTable);
    if (filterBlockTable) {
        console.log("\n=== ENTRY FILTER BLOCKS ===");
        console.log(filterBlockTable);
    }
    console.log(`\n=== TOP ENTRY PATTERNS (MIN ${MIN_PATTERN_TRADES} TRADES) ===`);
    console.log(patternBestTable);
    console.log(`\n=== WEAKEST ENTRY PATTERNS (MIN ${MIN_PATTERN_TRADES} TRADES) ===`);
    console.log(patternWorstTable);
    if (reportPath) {
        console.log(`\nReport written to: ${reportPath}`);
    }
}

run().catch((error) => {
    console.error("[liveParityReplay] Failed:", error);
    process.exit(1);
});
