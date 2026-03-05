import axios from "axios";
import xml2js from "xml2js";

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";

function positiveNumberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CACHE_TTL_MS = positiveNumberOr(process.env.NEWS_CACHE_TTL_MS, 55 * 60 * 1000);
const STALE_CACHE_MAX_AGE_MS = positiveNumberOr(process.env.NEWS_STALE_CACHE_MAX_AGE_MS, 24 * 60 * 60 * 1000);
const ERROR_BACKOFF_MS = positiveNumberOr(process.env.NEWS_ERROR_BACKOFF_MS, 60 * 1000);
const RATE_LIMIT_BACKOFF_MS = positiveNumberOr(process.env.NEWS_429_BACKOFF_MS, 5 * 60 * 1000);

let cachedEvents = null;
let cachedAtMs = 0;
let fetchCooldownUntilMs = 0;
let lastWarningAtMs = 0;

// If the feed is NOT UTC, set this env var to the feed offset in minutes.
// Example: America/Chicago (CST) is typically -360 minutes.
const NEWS_SOURCE_TZ_OFFSET_MINUTES = Number(process.env.NEWS_SOURCE_TZ_OFFSET_MINUTES ?? "0");

const DEFAULT_WINDOWS_BY_IMPACT = {
    High: { preMinutes: 30, postMinutes: 5 },
    Medium: { preMinutes: 15, postMinutes: 2 },
    Low: { preMinutes: 0, postMinutes: 0 },
};

const HIGH_RISK_TITLE_KEYWORDS = [
    "CPI",
    "inflation",
    "NFP",
    "Non-Farm",
    "Payrolls",
    "FOMC",
    "rate",
    "interest rate",
    "ECB",
    "Fed",
    "BoE",
    "BoJ",
    "press conference",
    "statement",
    "minutes",
];

function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function parseRetryAfterMs(retryAfterHeader) {
    if (retryAfterHeader === undefined || retryAfterHeader === null || retryAfterHeader === "") return null;
    const asSeconds = Number(retryAfterHeader);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
        return asSeconds * 1000;
    }
    const asDateMs = Date.parse(String(retryAfterHeader));
    if (!Number.isFinite(asDateMs)) return null;
    const delta = asDateMs - Date.now();
    return delta > 0 ? delta : null;
}

function logWarningThrottled(message, throttleMs = 60 * 1000) {
    const nowMs = Date.now();
    if (nowMs - lastWarningAtMs < throttleMs) return;
    lastWarningAtMs = nowMs;
    console.warn(message);
}

function parseEventDateTimeUTC(dateText, timeText) {
    const cleanDate = normalizeText(dateText);
    const cleanTime = normalizeText(timeText);

    if (!cleanDate || !cleanTime) return null;
    if (/all\s*day/i.test(cleanTime)) return null;
    if (/tentative/i.test(cleanTime)) return null;

    const dateMatch = cleanDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const timeMatch = cleanTime.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
    if (!dateMatch || !timeMatch) return null;

    const [, mm, dd, yyyy] = dateMatch;
    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3].toLowerCase();

    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;

    const utc = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hour, minute, 0));

    if (!Number.isFinite(NEWS_SOURCE_TZ_OFFSET_MINUTES) || NEWS_SOURCE_TZ_OFFSET_MINUTES === 0) {
        return utc;
    }

    // Convert from source tz to UTC
    return new Date(utc.getTime() - NEWS_SOURCE_TZ_OFFSET_MINUTES * 60 * 1000);
}

function eventTouchesSymbolCurrencies(eventCountry, symbol) {
    const country = normalizeText(eventCountry);
    if (!country) return false;

    const currencies = String(symbol || "").toUpperCase().match(/[A-Z]{3}/g) || [];
    if (country === "All") return true;
    return currencies.some((cur) => cur === country);
}

function coerceImpact(impactText, titleText) {
    const impact = normalizeText(impactText);
    const title = normalizeText(titleText);

    let result = impact || "Low";

    const titleLower = title.toLowerCase();
    const isHighRiskTitle = HIGH_RISK_TITLE_KEYWORDS.some((kw) => titleLower.includes(kw.toLowerCase()));
    if (isHighRiskTitle) result = "High";

    if (result !== "High" && result !== "Medium" && result !== "Low") {
        result = "High";
    }

    return result;
}

async function fetchCalendarEvents() {
    const nowMs = Date.now();
    if (cachedEvents && nowMs - cachedAtMs <= CACHE_TTL_MS) {
        return { events: cachedEvents, stale: false, degradedReason: null };
    }

    if (fetchCooldownUntilMs > nowMs) {
        if (cachedEvents && nowMs - cachedAtMs <= STALE_CACHE_MAX_AGE_MS) {
            return { events: cachedEvents, stale: true, degradedReason: "cooldown_stale_cache" };
        }
        return { events: [], stale: true, degradedReason: "cooldown_no_cache" };
    }

    try {
        const { data: xml } = await axios.get(CALENDAR_URL, { timeout: 15_000 });
        const result = await xml2js.parseStringPromise(xml, { explicitArray: false });

        const eventsRaw = result?.weeklyevents?.event;
        const events = toArray(eventsRaw);

        cachedEvents = events;
        cachedAtMs = nowMs;
        fetchCooldownUntilMs = 0;
        return { events, stale: false, degradedReason: null };
    } catch (error) {
        const status = Number(error?.response?.status);
        const isRateLimited = status === 429;
        const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.["retry-after"]);
        const backoffMs = isRateLimited ? retryAfterMs ?? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS;
        fetchCooldownUntilMs = Math.max(fetchCooldownUntilMs, nowMs + backoffMs);

        if (isRateLimited) {
            logWarningThrottled(`[NewsChecker] Calendar feed rate-limited (429). Backoff ${Math.ceil(backoffMs / 1000)}s.`);
        } else {
            logWarningThrottled(`[NewsChecker] Calendar feed request failed (${error?.message || "unknown_error"}).`);
        }

        if (cachedEvents && nowMs - cachedAtMs <= STALE_CACHE_MAX_AGE_MS) {
            return {
                events: cachedEvents,
                stale: true,
                degradedReason: isRateLimited ? "rate_limited_stale_cache" : "request_failed_stale_cache",
            };
        }

        return {
            events: [],
            stale: true,
            degradedReason: isRateLimited ? "rate_limited_no_cache" : "request_failed_no_cache",
        };
    }
}

function buildEventModel(event) {
    const impact = coerceImpact(event?.impact, event?.title);
    const dt = parseEventDateTimeUTC(event?.date, event?.time);

    return {
        title: normalizeText(event?.title),
        country: normalizeText(event?.country),
        impact,
        date: normalizeText(event?.date),
        time: normalizeText(event?.time),
        datetimeUtc: dt,
    };
}

function getWindowsForImpact(impact, windowsByImpact) {
    const base = DEFAULT_WINDOWS_BY_IMPACT[impact] ?? DEFAULT_WINDOWS_BY_IMPACT.High;
    const override = windowsByImpact?.[impact];

    const preMinutes = Number.isFinite(override?.preMinutes) ? override.preMinutes : base.preMinutes;
    const postMinutes = Number.isFinite(override?.postMinutes) ? override.postMinutes : base.postMinutes;

    return { preMinutes, postMinutes };
}

export async function getNewsStatus(symbol, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const includeImpacts = Array.isArray(options.includeImpacts) ? options.includeImpacts : ["High", "Medium"];
    const windowsByImpact = options.windowsByImpact || {};

    const { events, stale, degradedReason } = await fetchCalendarEvents();

    const relevant = events
        .map(buildEventModel)
        .filter((e) => e.datetimeUtc && Number.isFinite(e.datetimeUtc.getTime()))
        .filter((e) => includeImpacts.includes(e.impact))
        .filter((e) => eventTouchesSymbolCurrencies(e.country, symbol));

    const blockingEvents = [];
    let blockUntil = null;

    for (const e of relevant) {
        const { preMinutes, postMinutes } = getWindowsForImpact(e.impact, windowsByImpact);

        const start = new Date(e.datetimeUtc.getTime() - preMinutes * 60 * 1000);
        const end = new Date(e.datetimeUtc.getTime() + postMinutes * 60 * 1000);

        if (now >= start && now <= end) {
            blockingEvents.push({ ...e, blockStartUtc: start, blockEndUtc: end });
            if (!blockUntil || end > blockUntil) blockUntil = end;
        }
    }

    const upcomingHorizonMs = 12 * 60 * 60 * 1000;
    const upcoming = relevant
        .filter((e) => e.datetimeUtc > now && e.datetimeUtc.getTime() - now.getTime() <= upcomingHorizonMs)
        .sort((a, b) => a.datetimeUtc - b.datetimeUtc)
        .slice(0, 5);

    return {
        blocked: blockingEvents.length > 0,
        blockUntilUtc: blockUntil,
        blockingEvents,
        upcoming,
        staleCalendar: stale,
        degradedReason: degradedReason || null,
        cacheAgeMs: cachedAtMs > 0 ? Math.max(0, Date.now() - cachedAtMs) : null,
        nextCalendarFetchUtc: fetchCooldownUntilMs > Date.now() ? new Date(fetchCooldownUntilMs) : null,
        sourceTzOffsetMinutes: NEWS_SOURCE_TZ_OFFSET_MINUTES,
        calendarUrl: CALENDAR_URL,
    };
}

// Backwards-compatible API (your old boolean call)
export async function isNewsTime(symbol, windowMinutes = 15) {
    try {
        const now = new Date();
        const status = await getNewsStatus(symbol, {
            now,
            includeImpacts: ["High"],
            windowsByImpact: {
                High: { preMinutes: windowMinutes, postMinutes: windowMinutes },
            },
        });

        return status.blocked;
    } catch (error) {
        console.error("[NewsChecker] Failed to check news:", error?.message || error);
        return false;
    }
}
