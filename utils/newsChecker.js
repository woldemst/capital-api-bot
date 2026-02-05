import axios from "axios";
import xml2js from "xml2js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedEvents = null;
let cachedAtMs = 0;

export async function isNewsTime(symbol, windowMinutes = 15) {
    try {
        const now = new Date();
        const start = new Date(now.getTime() - windowMinutes * 60 * 1000);
        const end = new Date(now.getTime() + windowMinutes * 60 * 1000);

        // Forex Factory calendar XML
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
        let events = cachedEvents;
        const nowMs = Date.now();
        if (!events || nowMs - cachedAtMs > CACHE_TTL_MS) {
            const { data: xml } = await axios.get(url);
            const result = await xml2js.parseStringPromise(xml, { explicitArray: false });
            const eventsRaw = result?.weeklyevents?.event || [];
            events = Array.isArray(eventsRaw) ? eventsRaw : [eventsRaw];
            cachedEvents = events;
            cachedAtMs = nowMs;
        }

        const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");
        const parseEventDateTime = (dateText, timeText) => {
            // Forex Factory dates are MM-DD-YYYY and times like 1:30pm in GMT.
            const cleanDate = normalizeText(dateText);
            const cleanTime = normalizeText(timeText);
            if (!cleanDate || !cleanTime) return null;
            if (/all day/i.test(cleanTime)) return null;
            const dateMatch = cleanDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            const timeMatch = cleanTime.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
            if (!dateMatch || !timeMatch) return null;
            const [, mm, dd, yyyy] = dateMatch;
            let hour = parseInt(timeMatch[1], 10);
            const minute = parseInt(timeMatch[2], 10);
            const meridiem = timeMatch[3].toLowerCase();
            if (hour === 12) hour = 0;
            if (meridiem === "pm") hour += 12;
            return new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), hour, minute, 0));
        };

        const currencies = symbol.match(/[A-Z]{3}/g) || [];

        // Filter for high-impact news for the symbol's currencies and time window
        const highImpactNews = events.filter((event) => {
            const impact = normalizeText(event.impact);
            const country = normalizeText(event.country);
            const date = normalizeText(event.date);
            const time = normalizeText(event.time);
            if (!impact || !country || !date || !time) return false;
            if (impact !== "High") return false;
            if (country !== "All" && !currencies.some((cur) => country === cur)) return false;

            const eventDateTime = parseEventDateTime(date, time);
            if (!eventDateTime || Number.isNaN(eventDateTime.getTime())) return false;
            return eventDateTime >= start && eventDateTime <= end;
        });

        if (highImpactNews.length > 0) {
            console.log(
                `[NewsChecker] High-impact news detected for ${symbol}:`,
                highImpactNews.map((e) => e.title),
            );
            return true;
        }
        return false;
    } catch (error) {
        console.error("[NewsChecker] Failed to check news:", error.message);
        return false; // Fail-safe: allow trading if news check fails
    }
}
