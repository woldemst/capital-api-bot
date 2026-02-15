import { API } from "./config.js";
import axios from "axios";
import logger from "./utils/logger.js";

let cst, xsecurity;
let sessionStartTime = Date.now();

export const getHeaders = (includeContentType = false) => {
    const baseHeaders = {
        "X-SECURITY-TOKEN": xsecurity,
        "X-CAP-API-KEY": API.KEY,
        CST: cst,
    };
    return includeContentType ? { ...baseHeaders, "Content-Type": "application/json" } : baseHeaders;
};

export const startSession = async () => {
    try {
        const response = await axios.post(
            `${API.BASE_URL}/session`,
            {
                identifier: API.IDENTIFIER,
                password: API.PASSWORD,
                encryptedPassword: false,
            },
            {
                headers: getHeaders(true),
            }
        );

        logger.info("Session started");
        cst = response.headers["cst"];
        xsecurity = response.headers["x-security-token"];

        if (!cst || !xsecurity) {
            logger.warn("Session tokens not received in response headers");
            logger.info("Response headers:", response.headers);
        }

        return response.data;
    } catch (error) {
        logger.error("[api.js] Failed to start session:", error.response ? error.response.data : error.message);
        if (error.response) {
            logger.error("[api.js] Response status:", error.response.status);
            logger.error("[api.js] Response headers:", error.response.headers);
        }
        throw error;
    }
};

export const pingSession = async () => {
    try {
        const response = await axios.get(`${API.BASE_URL}/ping`, { headers: getHeaders() });
        const status = response?.data?.status || "OK";
        logger.info(`[API] Ping OK (${status})`);
    } catch (error) {
        logger.error(`[api.js][API] Error pinging session: ${error.message}`);
        throw error;
    }
};

export const refreshSession = async () => {
    if (Date.now() - sessionStartTime < 8.5 * 60 * 1000) return;
    try {
        const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
        cst = response.headers["cst"];
        xsecurity = response.headers["x-security-token"];
        sessionStartTime = Date.now();
        logger.info("[API] Session tokens refreshed");
    } catch (error) {
        logger.error(`[api.js][API] Error refreshing session: ${error.message}`);
        throw error;
    }
};

export const getSessionDetails = async () => {
    try {
        const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
        logger.info(`[API] Session details: ${JSON.stringify(response.data)}`);
    } catch (error) {
        logger.error("[api.js][API] Session details error:", error.response?.data || error.message);
    }
};

async function withSessionRetry(fn, ...args) {
    try {
        return await fn(...args);
    } catch (error) {
        const status = error.response?.status;
        const errorCode = error.response?.data?.errorCode || "";
        if (
            status === 401 ||
            status === 403 ||
            errorCode === "error.invalid.session.token" ||
            (typeof errorCode === "string" && errorCode.toLowerCase().includes("session"))
        ) {
            logger.warn("[API] Session error detected. Refreshing session and retrying...");
            await refreshSession();
            return await fn(...args); // Retry once
        }
        throw error;
    }
}

export const getAccountInfo = async () =>
    withSessionRetry(async () => {
        const response = await axios.get(`${API.BASE_URL}/accounts`, { headers: getHeaders() });
        return response.data;
    });

export const getMarkets = async () =>
    withSessionRetry(async () => {
        const response = await axios.get(`${API.BASE_URL}/markets?searchTerm=EURUSD`, { headers: getHeaders() });
        return Array.isArray(response.data.markets) ? response.data.markets : [];
    });

export async function getMarketDetails(symbol) {
    return await withSessionRetry(async () => {
        const response = await axios.get(`${API.BASE_URL}/markets/${symbol}`, { headers: getHeaders() });
        // logger.info(`Market details for ${symbol}: ${JSON.stringify(response.data)}`);
        return response.data;
    });
}

export const getOpenPositions = async () =>
    withSessionRetry(async () => {
        const response = await axios.get(`${API.BASE_URL}/positions`, { headers: getHeaders() });
        // logger.info("<========= open positions =========>\n" + JSON.stringify(response.data, null, 2) + "\n\n");
        return response.data;
    });

export async function getHistorical(symbol, resolution, count) {
    // logger.info(`[API] Fetching historical: ${symbol} resolution=${resolution}`);
    const response = await axios.get(`${API.BASE_URL}/prices/${symbol}?resolution=${resolution}&max=${count}`, { headers: getHeaders(true) });
    return {
        prices: response.data.prices.map((p) => ({
            close: p.closePrice?.bid,
            high: p.highPrice?.bid,
            low: p.lowPrice?.bid,
            open: p.openPrice?.bid,
            timestamp: new Date(p.snapshotTime).toLocaleString(), // Human readable timestamp
        })),
    };
}

export async function placeOrder(symbol, direction, size, level, orderType = "LIMIT") {
    return await withSessionRetry(async () => {
        logger.info(`[API] Placing ${direction} order for ${symbol} at ${level}, size: ${size}`);
        const order = {
            epic: symbol,
            direction: direction.toUpperCase(),
            size: size,
            level: level,
            type: orderType,
        };
        const response = await axios.post(`${API.BASE_URL}/workingorders`, order, {
            headers: getHeaders(true),
        });
        logger.info("[API] Order response:", response.data);
        return response.data;
    });
}

export async function updateTrailingStop(positionId, currentPrice, entryPrice, takeProfit, direction, symbol) {
    const entry = Number(entryPrice);
    const tp = Number(takeProfit);
    const price = Number(currentPrice);
    if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(price)) return;

    const tpDistance = Math.abs(tp - entry);
    if (tpDistance <= 0) return;

    const dir = String(direction || "").toUpperCase();
    const thresholdPrice = dir === "BUY" ? entry + 0.7 * tpDistance : entry - 0.7 * tpDistance;

    const thresholdMet = dir === "BUY" ? price >= thresholdPrice : price <= thresholdPrice;

    if (!thresholdMet) {
        return; // keep the original SL until the threshold is hit
    }

    // --- Calculate trailing distance ---
    let trailingDistance = Math.abs(price - entry) * 0.1 || 0.001; // fallback if calculation fails

    // --- Get symbol-specific minimum stop distance ---
    let minStopDistance = 0.0003; // default fallback
    try {
        const market = await getMarketDetails(symbol);
        if (market?.dealingRules?.minStopDistance) {
            minStopDistance = market.dealingRules.minStopDistance;
        }
    } catch (err) {
        logger.warn(`[API] Could not fetch minStopDistance for ${symbol}, using fallback ${minStopDistance}`);
    }

    // --- Ensure distance is not too small ---
    if (trailingDistance < minStopDistance) {
        logger.warn(`[API] Trailing distance (${trailingDistance}) too small for ${symbol}. Using min allowed: ${minStopDistance}`);
        trailingDistance = minStopDistance;
    }

    try {
        const response = await axios.put(
            `${API.BASE_URL}/positions/${positionId}`,
            {
                trailingStop: true,
                stopDistance: Number(trailingDistance.toFixed(6)), // round safely
            },
            { headers: getHeaders(true) }
        );
        logger.info(`[API] Trailing stop for ${positionId} set to distance ${trailingDistance}`);
        return response.data;
    } catch (err) {
        logger.error(`[API] updateTrailingStop error for ${positionId}:`, err.response?.data || err.message);
        throw err;
    }
}

function inferPriceDecimals(value, fallback = 5) {
    const str = String(value ?? "");
    if (!str.includes(".")) return fallback;
    const part = str.split(".")[1] || "";
    const cleaned = part.replace(/0+$/, "");
    if (!cleaned.length) return fallback;
    return Math.min(Math.max(cleaned.length, 0), 10);
}

function toRoundedNumber(value, decimals = 5) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Number(num.toFixed(decimals));
}

export async function placePosition(symbol, direction, size, price, SL, TP) {
    return await withSessionRetry(async () => {
        try {
            const range = await getAllowedTPRange(symbol);
            const decimals = Number.isInteger(range.decimals) ? range.decimals : symbol.includes("JPY") ? 3 : 5;
            const stopLevel = toRoundedNumber(SL, decimals);
            const profitLevel = toRoundedNumber(TP, decimals);

            if (!Number.isFinite(stopLevel) || !Number.isFinite(profitLevel)) {
                throw new Error(`Invalid stop/profit levels for ${symbol}. stop=${SL} profit=${TP}`);
            }

            logger.info(`[API] Placing ${direction} position for ${symbol} at market price. Size: ${size}, SL: ${stopLevel}, TP: ${profitLevel}`);
            const position = {
                epic: symbol,
                direction: direction.toUpperCase(),
                size: Number(size),
                orderType: "MARKET",
                guaranteedStop: false,
                stopLevel,
                profitLevel,
            };
            logger.info(`[API] Sending position request: ${JSON.stringify(position)}`);

            const response = await axios.post(`${API.BASE_URL}/positions`, position, { headers: getHeaders(true) });

            logger.info(`[API] Position created successfully: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error) {
            logger.error(`[API] Error placing position for ${symbol}:`, error.response ? JSON.stringify(error.response.data) : error.message);
            if (error.response) {
                logger.error(`[API] Response status:`, error.response.status);
                logger.error(`[API] Response headers:`, JSON.stringify(error.response.headers));
            }
            throw error;
        }
    });
}

export async function updatePositionProtection(dealId, stopLevelInput, profitLevelInput, symbol = "") {
    return await withSessionRetry(async () => {
        const range = symbol ? await getAllowedTPRange(symbol) : { decimals: 5 };
        const decimals = Number.isInteger(range.decimals) ? range.decimals : 5;
        const stopLevel = toRoundedNumber(stopLevelInput, decimals);
        const profitLevel = toRoundedNumber(profitLevelInput, decimals);
        const payload = {};

        if (Number.isFinite(stopLevel)) payload.stopLevel = stopLevel;
        if (Number.isFinite(profitLevel)) payload.profitLevel = profitLevel;

        if (!Object.keys(payload).length) {
            throw new Error(`No valid SL/TP values provided for ${dealId}`);
        }

        logger.info(`[API] Updating position protection for ${dealId}: ${JSON.stringify(payload)}`);
        const response = await axios.put(`${API.BASE_URL}/positions/${dealId}`, payload, {
            headers: getHeaders(true),
        });
        logger.info(`[API] Position protection updated for ${dealId}: ${JSON.stringify(response.data)}`);
        return response.data;
    });
}

export async function gevtDealConfirmation(dealReference) {
    return await withSessionRetry(async () => {
        logger.info(`[API] Getting confirmation for deal: ${dealReference}`);
        const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });
        logger.info("[API] DealConfirmation", response.data);
        return response.data;
    });
}

// In api.js, update getDealConfirmation method
export async function getDealConfirmation(dealReference) {
    return await withSessionRetry(async () => {
        logger.info(`[API] Getting confirmation for deal: ${dealReference}`);
        const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });

        if (!response.data || !response.data.status) {
            throw new Error("Invalid deal confirmation data received");
        }

        logger.info("[API] DealConfirmation", response.data);
        return response.data;
    });
}

export async function closePosition(dealId) {
    try {
        const response = await axios.delete(`${API.BASE_URL}/positions/${dealId}`, {
            headers: getHeaders(true),
        });
        logger.info(`[API] Position closed:`, response.data);
        return response.data;
    } catch (error) {
        logger.error(`[api.js][API] Failed to close position for dealId: ${dealId}`, error.response?.data || error.message);
        throw error;
    }
}

export function getSessionTokens() {
    return { cst, xsecurity };
}

export async function getAllowedTPRange(symbol) {
    try {
        const details = await getMarketDetails(symbol);
        const instr = details?.instrument || {};
        const snapshot = details?.snapshot || {};
        const defaultDecimals = symbol.includes("JPY") ? 3 : 5;
        const decimalsCandidate = Math.max(
            inferPriceDecimals(snapshot?.bid, defaultDecimals),
            inferPriceDecimals(snapshot?.offer, defaultDecimals),
            inferPriceDecimals(snapshot?.high, defaultDecimals),
            inferPriceDecimals(snapshot?.low, defaultDecimals),
        );
        const decimals = Number.isInteger(instr.decimalPlacesFactor)
            ? instr.decimalPlacesFactor
            : Number.isInteger(instr?.lotSizeScale)
              ? instr.lotSizeScale
              : decimalsCandidate;
        const minSLDistance = instr.limits?.stopDistance?.min || instr.limits?.stopLevel?.min || 0;
        const minTPDistance = instr.limits?.limitDistance?.min || instr.limits?.limitLevel?.min || 0;

        // Umrechnung in Preisabstand
        const minSLDistancePrice = minSLDistance * Math.pow(10, -decimals);
        const minTPDistancePrice = minTPDistance * Math.pow(10, -decimals);

        return {
            minTPDistance,
            maxTPDistance: instr.limits?.limitDistance?.max || instr.limits?.limitLevel?.max || Number.POSITIVE_INFINITY,
            minSLDistance,
            maxSLDistance: instr.limits?.stopDistance?.max || instr.limits?.stopLevel?.max || Number.POSITIVE_INFINITY,
            decimals,
            minSLDistancePrice,
            minTPDistancePrice,
            market: details.snapshot,
        };
    } catch (error) {
        logger.error(`[api.js][API] getAllowedTPRange error for ${symbol}:`, error.message);
        return {
            minTPDistance: 0,
            maxTPDistance: Number.POSITIVE_INFINITY,
            minSLDistance: 0,
            maxSLDistance: Number.POSITIVE_INFINITY,
            decimals: 5,
            minSLDistancePrice: 0,
            minTPDistancePrice: 0,
            market: {},
        };
    }
}
