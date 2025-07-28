// --- API Utility: Handles all Capital.com REST API calls and session management ---
// Human-readable, robust, and well-commented for maintainability.

import { API } from "./config.js";
import axios from "axios";
import logger from "./utils/logger.js";



let cst, xsecurity; 
let sessionStartTime = Date.now();

/**
 * Returns the headers required for API requests.
 * Optionally includes Content-Type for POST/PUT requests.
 */
export const getHeaders = (includeContentType = false) => {
  const baseHeaders = {
    "X-SECURITY-TOKEN": xsecurity,
    "X-CAP-API-KEY": API.KEY,
    CST: cst,
  };
  return includeContentType ? { ...baseHeaders, "Content-Type": "application/json" } : baseHeaders;
};

/**
 * Formats a Date object as ISO string without milliseconds or timezone.
 * Example: 2025-06-30T19:16:33
 */
function formatIsoNoMs(date) {
  if (!(date instanceof Date) || isNaN(date)) {
    throw new Error("Invalid date object passed to formatIsoNoMs");
  }
  return date.toISOString().split(".")[0];
}

// Start a new session with the API
export const startSession = async () => {
  /**
   * Starts a new session with the Capital.com API.
   * Stores session tokens for future requests.
   */
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
    
    console.log(""); 
    logger.info("Session started");
    // logger.info(response.data);

    // Store the session tokens
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];
    if (!cst || !xsecurity) {
      logger.warn("Session tokens not received in response headers");
      logger.info("Response headers:", response.headers);
    }

    console.log(`\n\ncst: ${cst} \nxsecurity: ${xsecurity} \n`);

    return response.data;
  } catch (error) {
    logger.error("Failed to start session:", error.response ? error.response.data : error.message);
    if (error.response) {
      logger.error("Response status:", error.response.status);
      logger.error("Response headers:", error.response.headers);
    }
    throw error;
  }
};

/**
 * Pings the API to keep the session alive.
 * Logs the current session tokens for diagnostics.
 */
export const pingSession = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/ping`, { headers: getHeaders() });
    logger.info(`[API] Ping response: ${JSON.stringify(response.data)}`);
    logger.info(`[API] securityToken: ${xsecurity}`);
    logger.info(`[API] CST: ${cst}`);
  } catch (error) {
    logger.error(`[API] Error pinging session: ${error.message}`);
    throw error;
  }
};

/**
 * Refreshes session tokens if more than 8.5 minutes have passed.
 * Ensures all API calls remain authenticated.
 */
export const refreshSession = async () => {
  if (Date.now() - sessionStartTime < 8.5 * 60 * 1000) return;
  try {
    const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];
    sessionStartTime = Date.now();
    logger.info("[API] Session tokens refreshed");
  } catch (error) {
    logger.error(`[API] Error refreshing session: ${error.message}`);
    throw error;
  }
};

// Get session details
export const getSessionDetails = async () => {
  /**
   * Gets session details for diagnostics.
   */
  try {
    const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
    logger.info(`[API] Session details: ${JSON.stringify(response.data)}`);
  } catch (error) {
    logger.error("[API] Session details error:", error.response?.data || error.message);
  }
};

/**
 * Helper: Retry an API call after refreshing the session if a session error is detected.
 * Ensures robust error handling for all API requests.
 */
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

// Wrap main API calls with withSessionRetry
/**
 * Fetches account information (balance, margin, etc.).
 */
export const getAccountInfo = async () =>
  withSessionRetry(async () => {
    const response = await axios.get(`${API.BASE_URL}/accounts`, { headers: getHeaders() });
    return response.data;
  });

/**
 * Fetches a list of available markets (default: EURUSD).
 */
export const getMarkets = async () =>
  withSessionRetry(async () => {
    const response = await axios.get(`${API.BASE_URL}/markets?searchTerm=EURUSD`, { headers: getHeaders() });
    return Array.isArray(response.data.markets) ? response.data.markets : [];
  });

/**
 * Fetches detailed information for a specific market symbol.x  
 */
export async function getMarketDetails(symbol) {
  return await withSessionRetry(async () => {
    const response = await axios.get(`${API.BASE_URL}/markets/${symbol}`, { headers: getHeaders() });
    // logger.info(`Market details for ${symbol}: ${JSON.stringify(response.data)}`);
    return response.data;
  });
}

/**
 * Fetches open positions for the account.
 */
export const getOpenPositions = async () =>
  withSessionRetry(async () => {
    const response = await axios.get(`${API.BASE_URL}/positions`, { headers: getHeaders() });
    // logger.info("<========= open positions =========>\n" + JSON.stringify(response.data, null, 2) + "\n\n");
    return response.data;
  });

/**
 * Fetches historical price data for a symbol and timeframe.
 * Returns an array of candle objects.
 */
export async function getHistorical(symbol, resolution, count, from = null, to = null) {
  // Map Capital.com timeframes to ms
  const tfToMs = {
    "HOUR": 1 * 60 * 60 * 1000,
    "HOUR_4": 4 * 60 * 60 * 1000,
    "DAY": 24 * 60 * 60 * 1000
  };
  const stepMs = tfToMs[resolution];
  const nowMs = Date.now();
  if (!to) to = formatIsoNoMs(new Date(nowMs));
  if (!from) {
    if (!stepMs) throw new Error(`Unknown resolution: ${resolution}`);
    // Request a larger time window to ensure we get enough bars
    const fromMs = nowMs - (count * 2) * stepMs; // Double the time range to ensure we get enough bars
    from = formatIsoNoMs(new Date(fromMs));
  }
  logger.info(`[API] Fetching historical: ${symbol} from=${from} to=${to} resolution=${resolution}`);
  const response = await axios.get(`${API.BASE_URL}/prices/${symbol}?resolution=${resolution}&max=${count}&from=${from}&to=${to}`, {
    headers: getHeaders(true),
  });
  return {
    prices: response.data.prices.map((p) => ({
      close: p.closePrice?.bid,
      high: p.highPrice?.bid,
      low: p.lowPrice?.bid,
      open: p.openPrice?.bid,
      timestamp: p.snapshotTime,
    })),
  };
}

/**
 * Places a limit order for a symbol.
 */
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

/**
 * Updates the trailing stop for an open position.
 * Ensures stopLevel is at least minSLDistance away from current price.
 */
export async function updateTrailingStop(positionId, stopLevel, symbol, direction, price) {
  // Fetch allowed stop range and enforce min distance
  if (symbol && direction && typeof price === 'number') {
    const range = await getAllowedTPRange(symbol);
    const decimals = range.decimals || 5;
    const minStopDistance = range.minSLDistance * Math.pow(10, -decimals);
    if (direction === "buy") {
      if ((price - stopLevel) < minStopDistance) {
        stopLevel = price - minStopDistance;
      }
    } else {
      if ((stopLevel - price) < minStopDistance) {
        stopLevel = price + minStopDistance;
      }
    }
  }
  
  return await withSessionRetry(async () => {
    logger.info(`[API] Updating trailing stop for position ${positionId} to ${stopLevel}`);
    const response = await axios.put(
      `${API.BASE_URL}/positions/${positionId}`,
      {
        trailingStop: true,
        stopLevel,
      },
      {
        headers: getHeaders(true),
      }
    );
    logger.info("[API] Trailing stop updated successfully:", response.data);
    return response.data;
  });
}

/**
 * Places a market position for a symbol with optional stop loss and take profit.
 * Ensures stopLevel is at least minSLDistance away from price.
 */
export async function placePosition(symbol, direction, size, level, stopLevel, profitLevel, price) {
  // Fetch allowed stop range and enforce min distance
  if (symbol && direction && typeof price === 'number' && stopLevel) {
    const range = await getAllowedTPRange(symbol);
    const decimals = range.decimals || 5;
    const minStopDistance = range.minSLDistance * Math.pow(10, -decimals);
    if (direction === "buy") {
      if ((price - stopLevel) < minStopDistance) {
        stopLevel = price - minStopDistance;
      }
    } else {
      if ((stopLevel - price) < minStopDistance) {
        stopLevel = price + minStopDistance;
      }
    }
  }
  return await withSessionRetry(async () => {
    logger.info(`[API] Placing ${direction} position for ${symbol} at market price. Size: ${size}, SL: ${stopLevel}, TP: ${profitLevel}`);
    const position = {
      epic: symbol,
      direction: direction.toUpperCase(),
      size: size.toFixed(5),
      orderType: "MARKET",
      guaranteedStop: false,
      stopLevel: stopLevel ? parseFloat(stopLevel).toFixed(5) : undefined,
      profitLevel: profitLevel ? parseFloat(profitLevel).toFixed(5) : undefined,
      // forceOpen: true, // Removed as it's deprecated in newer API versions
    };
    logger.info("[API] Sending position request:", position);
    const response = await axios.post(`${API.BASE_URL}/positions`, position, { headers: getHeaders(true) });
    logger.info("[API] Position created successfully:", response.data);
    return response.data;
  });
}

/**
 * Gets deal confirmation for a given deal reference.
 */
export async function getDealConfirmation(dealReference) {
  return await withSessionRetry(async () => {
    logger.info(`[API] Getting confirmation for deal: ${dealReference}`);
    const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });
    logger.info("[API] DealConfirmation", response.data);
    return response.data;
  });
}

/**
 * Closes an open position by dealId.
 */
export async function closePosition(dealId) {
  try {
    const response = await axios.delete(`${API.BASE_URL}/positions/${dealId}`, {
      headers: getHeaders(true),
    });
    logger.info(`[API] Position closed:`, response.data);
    return response.data;
  } catch (error) {
    logger.error(`[API] Failed to close position for dealId: ${dealId}`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Returns the current session tokens (CST and X-SECURITY-TOKEN).
 */
export function getSessionTokens() {
  return { cst, xsecurity };
}

/**
 * Gets allowed take profit and stop loss ranges for a symbol.
 * Returns min/max distances and decimals for price calculations.
 */
export async function getAllowedTPRange(symbol) {
  try {
    const details = await getMarketDetails(symbol);
    const instr = details.instrument;
    return {
      minTPDistance: instr.limits?.limitDistance?.min || instr.limits?.limitLevel?.min || 0,
      maxTPDistance: instr.limits?.limitDistance?.max || instr.limits?.limitLevel?.max || Number.POSITIVE_INFINITY,
      minSLDistance: instr.limits?.stopDistance?.min || instr.limits?.stopLevel?.min || 0,
      maxSLDistance: instr.limits?.stopDistance?.max || instr.limits?.stopLevel?.max || Number.POSITIVE_INFINITY,
      decimals: instr.lotSizeScale || instr.scalingFactor || 5,
      market: details.snapshot,
    };
  } catch (error) {
    logger.error(`[API] getAllowedTPRange error for ${symbol}:`, error.message);
    return {
      minTPDistance: 0,
      maxTPDistance: Number.POSITIVE_INFINITY,
      minSLDistance: 0,
      maxSLDistance: Number.POSITIVE_INFINITY,
      decimals: 5,
      market: {},
    };
  }
}
