import axios from "axios";
import xml2js from "xml2js";
import logger from "./logger.js";

export async function isNewsTime(symbol, windowMinutes = 30) {
    try {
        const now = new Date();
        const start = new Date(now.getTime() - windowMinutes * 60 * 1000);
        const end = new Date(now.getTime() + windowMinutes * 60 * 1000);

        // Forex Factory calendar XML
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
        const { data: xml } = await axios.get(url);
        const result = await xml2js.parseStringPromise(xml, { explicitArray: false });

        // Parse events
        const events = result?.week?.event || [];
        const currencies = symbol.match(/[A-Z]{3}/g);

        // Filter for high-impact news for the symbol's currencies and time window
        const highImpactNews = events.filter((event) => {
            if (!event.impact || !event.currency || !event.date || !event.time) return false;
            if (event.impact !== "High") return false;
            if (!currencies.some((cur) => event.currency === cur)) return false;

            // Parse event time (Forex Factory times are in GMT)
            const eventDateTime = new Date(`${event.date} ${event.time} GMT`);
            return eventDateTime >= start && eventDateTime <= end;
        });

        if (highImpactNews.length > 0) {
            logger.info(
                `[NewsChecker] High-impact news detected for ${symbol}:`,
                highImpactNews.map((e) => e.title)
            );
            return true;
        }
        return false;
    } catch (error) {
        logger.error("[NewsChecker] Failed to check news:", error.message);
        return false; // Fail-safe: allow trading if news check fails
    }
}
