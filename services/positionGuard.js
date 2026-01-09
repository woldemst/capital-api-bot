import { getOpenPositions, getMarketDetails } from "../api.js";
import tradingService from "./trading.js";
import logger from "../utils/logger.js";

// Handles scheduled end-of-week closes and optional holiday/extended-closure detection.
class PositionGuard {
    constructor({ timeZone = "Europe/Berlin", closeTime = { hour: 20, minute: 50 }, holidayClosureThresholdHours = 30, getActiveSymbols = () => [] } = {}) {
        this.timeZone = timeZone;
        this.closeTime = closeTime;
        this.holidayClosureThresholdHours = holidayClosureThresholdHours;
        this.getActiveSymbols = getActiveSymbols;
        this.timeout = null;
    }

    start() {
        this.schedule();
    }

    stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }

    schedule() {
        if (this.timeout) clearTimeout(this.timeout);

        const nextRun = this.getNextDailyTargetMs(this.closeTime.hour, this.closeTime.minute, this.timeZone);
        const delay = Math.max(0, nextRun - Date.now());
        const prettyTime = this.prettyTimeLabel();

        logger.info(`[PositionGuard] Scheduled close check for ${new Date(nextRun).toISOString()} (${this.timeZone} ${prettyTime}).`);

        this.timeout = setTimeout(async () => {
            await this.run();
            this.schedule(); // Schedule the next day
        }, delay);
    }

    async run() {
        const parts = this.getZonedDateParts(new Date(), this.timeZone);
        const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(); // 5 => Friday

        let shouldClose = day === 5; // Always close on Friday at the scheduled time
        let reason = shouldClose ? `scheduled Friday ${this.prettyTimeLabel()} close` : "";

        const closureInfo = await this.detectExtendedClosure();
        if (closureInfo.shouldClose) {
            shouldClose = true;
            reason = closureInfo.reason || "extended market closure detected";
        }

        if (shouldClose) {
            logger.info(`[PositionGuard] Triggered: ${reason}`);
            await this.closeAllPositions();
        } else {
            logger.info("[PositionGuard] No closure condition met.");
        }
    }

    prettyTimeLabel() {
        return `${String(this.closeTime.hour).padStart(2, "0")}:${String(this.closeTime.minute).padStart(2, "0")}`;
    }

    async closeAllPositions() {
        logger.info("[PositionGuard] Closing all positions...");
        try {
            const positions = await getOpenPositions();
            if (!positions?.positions?.length) {
                logger.info("[PositionGuard] No open positions to close.");
                return;
            }

            for (const pos of positions.positions) {
                const dealId = pos?.dealId ?? pos?.position?.dealId;
                if (!dealId) {
                    logger.warn("[PositionGuard] Missing dealId in open position, skipping close.");
                    continue;
                }
                await tradingService.closePosition(dealId);
                logger.info(`[PositionGuard] Closed position: ${pos?.market?.epic || pos?.position?.epic || dealId}`);
            }
        } catch (error) {
            logger.error("[PositionGuard] Error closing all positions:", error);
        }
    }

    async detectExtendedClosure() {
        try {
            const positions = await getOpenPositions();
            const epics =
                positions?.positions
                    ?.map((p) => p?.market?.epic || p?.position?.epic)
                    .filter(Boolean) || [];
            const activeSymbols = typeof this.getActiveSymbols === "function" ? this.getActiveSymbols() : [];
            const sampleEpic = epics[0] || activeSymbols[0];

            if (!sampleEpic) {
                logger.info("[PositionGuard] No symbols available to check market hours; skipping holiday guard.");
                return { shouldClose: false };
            }

            const details = await getMarketDetails(sampleEpic);
            const marketTimes = details?.instrument?.openingHours?.marketTimes;

            if (!Array.isArray(marketTimes) || marketTimes.length === 0) {
                logger.info(`[PositionGuard] Market hours not provided for ${sampleEpic}; cannot evaluate extended closures.`);
                return { shouldClose: false };
            }

            const windows = marketTimes
                .map((entry) => {
                    const open = this.parseOpenTimeMs(entry.openTime || entry.open);
                    const close = this.parseOpenTimeMs(entry.closeTime || entry.close);
                    return Number.isFinite(open) && Number.isFinite(close) ? { open, close } : null;
                })
                .filter(Boolean)
                .sort((a, b) => a.open - b.open);

            if (!windows.length) return { shouldClose: false };

            const now = Date.now();
            const current = windows.find((w) => w.open <= now && now < w.close);
            const next = windows.find((w) => w.open > now);

            if (!current || !next) return { shouldClose: false };

            const gapMs = next.open - current.close;
            const gapHours = gapMs / (60 * 60 * 1000);

            if (gapHours >= this.holidayClosureThresholdHours) {
                return {
                    shouldClose: true,
                    reason: `detected ${gapHours.toFixed(1)}h market closure (holiday/weekend) for ${sampleEpic}`,
                };
            }

            return { shouldClose: false };
        } catch (error) {
            logger.warn(`[PositionGuard] Holiday/market-hours check failed: ${error.message}`);
            return { shouldClose: false };
        }
    }

    getNextDailyTargetMs(targetHour, targetMinute, timeZone) {
        const parts = this.getZonedDateParts(new Date(), timeZone);
        const alreadyPassed = parts.hour > targetHour || (parts.hour === targetHour && parts.minute >= targetMinute);
        const dayOffset = alreadyPassed ? 1 : 0;

        const candidate = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, targetHour, targetMinute, 0, 0);
        const offsetMs = this.getTimezoneOffsetMs(timeZone, new Date(candidate));
        return candidate - offsetMs;
    }

    getZonedDateParts(date, timeZone) {
        const formatter = new Intl.DateTimeFormat("en-GB", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });

        const parts = {};
        for (const part of formatter.formatToParts(date)) {
            if (part.type !== "literal") {
                parts[part.type] = Number(part.value);
            }
        }
        return parts;
    }

    getTimezoneOffsetMs(timeZone, date = new Date()) {
        const parts = this.getZonedDateParts(date, timeZone);
        const zonedAsUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0, 0);
        return zonedAsUTC - date.getTime();
    }

    parseOpenTimeMs(openTime) {
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
}

export default PositionGuard;
