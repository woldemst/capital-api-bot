import axios from "axios";
import xml2js from "xml2js";

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedEvents = null;
let cachedAtMs = 0;

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

    const currencies = symbol.match(/[A-Z]{3}/g) || [];
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
    if (cachedEvents && nowMs - cachedAtMs <= CACHE_TTL_MS) return cachedEvents;

    const { data: xml } = await axios.get(CALENDAR_URL, { timeout: 15_000 });
    const result = await xml2js.parseStringPromise(xml, { explicitArray: false });

    const eventsRaw = result?.weeklyevents?.event;
    const events = toArray(eventsRaw);

    cachedEvents = events;
    cachedAtMs = nowMs;
    return events;
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

    const events = await fetchCalendarEvents();

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
