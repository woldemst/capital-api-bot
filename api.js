import { API } from "./config.js";
import axios from "axios";
import logger from "./utils/logger.js";

let cst, xsecurity;
let sessionStartTime = Date.now();

// Base headers for API requests
export const getHeaders = (includeContentType = false) => {
  const baseHeaders = {
    "X-SECURITY-TOKEN": xsecurity,
    "X-CAP-API-KEY": API.KEY,
    CST: cst,
  };

  return includeContentType ? { ...baseHeaders, "Content-Type": "application/json" } : baseHeaders;
};

// Start a new session with the API
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

    console.log("");
    logger.info("Session started");
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];

    if (!cst || !xsecurity) {
      logger.warn("Session tokens not received in response headers");
      logger.info("Response headers:", response.headers);
    }

    // console.log(`\n\ncst: ${cst} \nxsecurity: ${xsecurity} \n`);

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

// ping
export const pingSession = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/ping`, { headers: getHeaders() });
    console.log("Ping response:", response.data);
    console.log(`securityToken: ${xsecurity}`);
    console.log(`CST: ${cst}`);
  } catch (error) {
    console.error(`Error pinging session: ${error.message}`);
    throw error;
  }
};

// Refresh session tokens
export const refreshSession = async () => {
  if (Date.now() - sessionStartTime < 8.5 * 60 * 1000) return;
  try {
    const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];
    sessionStartTime = Date.now();
    console.log("Session tokens refreshed");
  } catch (error) {
    console.error(`Error refreshing session: ${error.message}`);
    throw error;
  }
};

// Get session details
export const getSeesionDetails = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
    console.log("session details:", response.data);
  } catch (error) {
    console.error("session details:", error.response?.data || error.message);
  }
};

// Get account information
export const getAccountInfo = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/accounts`, { headers: getHeaders() });
    // console.log("<========= Account info received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting account info:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get activity history
export const getActivityHistory = async (from, to) => {
  try {
    // fetch("/history/activity?from=2022-01-17T15:09:47&to=2022-01-17T15:10:05&lastPeriod=600&detailed=true&dealId={{dealId}}&filter=source!=DEALER;type!=POSITION;status==REJECTED;epic==OIL_CRUDE,GOLD")
    console.log(`<========= Getting activity history from ${from} to ${to} =========>\n`);
    const response = await axios.get(`${API.BASE_URL}/history/transactions`, {
      headers: getHeaders(),
      params: {
        from,
        to,
        detailed: true,
        lastPeriod: 600,
      },
    });
    // console.log(response.data);
    return response.data;
  } catch (error) {
    console.error("Error getting activity history:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Helper: format Date in “YYYY-MM-DDTHH:mm:ss” (no ms, no Z)
function formatIsoNoMs(date) {
  if (!(date instanceof Date) || isNaN(date)) {
    throw new Error("Invalid date object passed to formatIsoNoMs");
  }
  const iso = date.toISOString();
  return iso.split(".")[0];
}

// Get available markets
export const getMarkets = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/markets?searchTerm=EURUSD`, { headers: getHeaders() });
    console.log("<========= Markets received =========>\n", response.data, "\n\n");
    // Ensure we return an array of markets
    return Array.isArray(response.data.markets) ? response.data.markets : [];
  } catch (error) {
    console.error("Error getting markets:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get market details for a symbol
export async function getMarketDetails(symbol) {
  try {
    const response = await axios.get(`${API.BASE_URL}/markets/${symbol}`, { headers: getHeaders() });
    // console.log(`Market details for ${symbol}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Error getting market details for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Get open positions
export const getOpenPositions = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/positions`, { headers: getHeaders() });
    console.log("<========= Open positions received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting open positions:", error.response ? error.response.data : error.message);
    throw error;
  }
};

export async function getHistorical(symbol, resolution, count, from = null, to = null) {
  try {
    const nowMs = Date.now();
    if (!to) {
      to = formatIsoNoMs(new Date(nowMs));
      // “2025-06-04T18:43:50”
    }
    if (!from) {
      const resolutionToMs = {
        MINUTE: 1 * 60 * 1000,
        MINUTE_5: 5 * 60 * 1000,
        MINUTE_15: 15 * 60 * 1000,
        HOUR: 1 * 60 * 60 * 1000,
        HOUR_4: 4 * 60 * 60 * 1000,
        DAY: 24 * 60 * 60 * 1000,
      };
      const stepMs = resolutionToMs[resolution] || resolutionToMs.m1;
      const fromMs = nowMs - count * stepMs;

      // “2025-04-24T00:00:00”
      from = formatIsoNoMs(new Date(fromMs));
    }

    // console.log(`from=${from} to=${to} in resolution=${resolution}`);

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
  } catch (error) {
    console.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Place an order
export async function placeOrder(symbol, direction, size, level, orderType = "LIMIT") {
  try {
    console.log(`Placing ${direction} order for ${symbol} at ${level}, size: ${size}`);

    const order = {
      epic: symbol,
      direction: direction.toUpperCase(),
      size: size,
      level: level,
      type: orderType,
      // Optional parameters that can be added based on requirements:
      // "timeInForce": "GOOD_TILL_CANCELLED",
      // "guaranteedStop": false,
      // "stopLevel": null,
      // "stopDistance": null,
      // "limitLevel": null,
      // "limitDistance": null,
      // "quoteId": null
    };

    const response = await axios.post(`${API.BASE_URL}/workingorders`, order, {
      headers: getHeaders(true),
    });

    console.log("Order response:", response.data);
    return response.data;
  } catch (error) {
    if (error.response?.data) {
      console.error("Order placement error:", error.response.data);
      throw new Error(error.response.data.errorCode || "Order placement failed");
    }
    throw error;
  }
}

// Update trailing stop

export async function updateTrailingStop(positionId, currentPrice, entryPrice, takeProfit, direction, symbol, isTrailingEnabled) {
  const tpDistance = Math.abs(takeProfit - entryPrice);
  const thresholdPrice = direction.toUpperCase() === "BUY" ? entryPrice + 0.7 * tpDistance : entryPrice - 0.7 * tpDistance;

  const thresholdMet = direction.toUpperCase() === "BUY" ? currentPrice >= thresholdPrice : currentPrice <= thresholdPrice;

  if (!thresholdMet && !isTrailingEnabled) {
    return; // keep the original SL until the threshold is hit
  }

  // --- Calculate trailing distance ---
  let trailingDistance = Math.abs(currentPrice - entryPrice) * 0.4 || 0.001; // fallback if calculation fails

  // --- Get symbol-specific minimum stop distance ---
  let minStopDistance = 0.0003; // default fallback
  try {
    const market = await getMarketDetails(symbol);
    if (market?.dealingRules?.minStopDistance) {
      minStopDistance = market.dealingRules.minStopDistance;
    }
  } catch (err) {
    console.warn(`[API] Could not fetch minStopDistance for ${symbol}, using fallback ${minStopDistance}`);
  }

  // --- Ensure distance is not too small ---
  if (trailingDistance < minStopDistance) {
    console.warn(`[API] Trailing distance (${trailingDistance}) too small for ${symbol}. Using min allowed: ${minStopDistance}`);
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
    console.info(`[API] Trailing stop for ${positionId} set to distance ${trailingDistance}`);
    return response.data;
  } catch (err) {
    console.error(`[API] updateTrailingStop error for ${positionId}:`, err.response?.data || err.message);
    throw err;
  }
}

// Place an immediate position for scalping
export async function placePosition(symbol, direction, size, level, stopLevel, profitLevel) {
  try {
    console.log(`Placing ${direction} position for ${symbol} at market price...`);
    console.log(`Original size: ${size}, Using size: ${size}`);
    console.log(`Stop Loss: ${stopLevel}, Take Profit: ${profitLevel}`);

    // Format the position request
    const position = {
      epic: symbol,
      direction: direction.toUpperCase(),
      size: size.toFixed(5),
      orderType: "MARKET",
      guaranteedStop: false,
      stopLevel: stopLevel ? parseFloat(stopLevel).toFixed(5) : undefined,
      profitLevel: profitLevel ? parseFloat(profitLevel).toFixed(5) : undefined,
      forceOpen: true,
    };

    console.log("Sending position request:", position);

    const response = await axios.post(`${API.BASE_URL}/positions`, position, { headers: getHeaders(true) });

    console.log("Position created successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error("Position creation error:", error.response?.data || error.message);
    throw error;
  }
}

// Get deal confirmation
export async function getDealConfirmation(dealReference) {
  try {
    console.log(`Getting confirmation for deal: ${dealReference}`);
    const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });
    console.log("[DealConfirmation]", response.data);
    return response.data;
  } catch (error) {
    console.error(`[DealConfirmation] Error for ${dealReference}:`, error.response?.data || error.message);
    throw error;
  }
}

// Export session tokens for WebSocket connection
export function getSessionTokens() {
  return { cst, xsecurity };
}
