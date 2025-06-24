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
        headers: getHeaders(true), // Include headers for the reques
      }
    );

    const now = new Date();
    const date = now.toLocaleDateString();
    const time = now.toLocaleTimeString();
    logger.info(`<========= Session started at ${date} ${time} =========>`);
    logger.info(response.data);
    logger.info(""); // Blank line for spacing

    // Store the session tokens
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];

    if (!cst || !xsecurity) {
      logger.warn("Session tokens not received in response headers");
      logger.info("Response headers:", response.headers);
    }

    logger.info(`cst: ${cst} \nxsecurity: ${xsecurity} \n`);

    return response.data;
  } catch (error) {
    logger.error("Failed to start session:", error.response ? error.response.data : error.message);
    logger.error("Request config:", error.config);
    if (error.response) {
      logger.error("Response status:", error.response.status);
      logger.error("Response headers:", error.response.headers);
    }
    throw error;
  }
};

// ping
export const pingSession = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/ping`, { headers: getHeaders() });
    logger.info(`Ping response: ${JSON.stringify(response.data)}`);
    logger.info(`securityToken: ${xsecurity}`);
    logger.info(`CST: ${cst}`);
  } catch (error) {
    logger.error(`Error pinging session: ${error.message}`);
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
    logger.info("Session tokens refreshed");
  } catch (error) {
    logger.error(`Error refreshing session: ${error.message}`);
    throw error;
  }
};

// Get session details
export const getSeesionDetails = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/session`, { headers: getHeaders() });
    logger.info(`session details: ${JSON.stringify(response.data)}`);
  } catch (error) {
    logger.error("session details:", error.response?.data || error.message);
  }
};

// Get account information
export const getAccountInfo = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/accounts`, { headers: getHeaders() });
    // logger.info("<========= Account info received =========>\n" + JSON.stringify(response.data) + "\n\n");
    return response.data;
  } catch (error) {
    logger.error("Error getting account info:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get activity history
export const getActivityHistory = async (from, to) => {
  try {
    logger.info(`<========= Getting activity history from ${from} to ${to} =========>`);
    const response = await axios.get(`${API.BASE_URL}/history/transactions`, {
      headers: getHeaders(),
      params: {
        from,
        to,
        detailed: true,
        lastPeriod: 600,
      },
    });
    // logger.info(JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    logger.error("Error getting activity history:", error.response ? error.response.data : error.message);
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
    logger.info("<========= Markets received =========>\n" + JSON.stringify(response.data) + "\n\n");
    // Ensure we return an array of markets
    return Array.isArray(response.data.markets) ? response.data.markets : [];
  } catch (error) {
    logger.error("Error getting markets:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get market details for a symbol
export async function getMarketDetails(symbol) {
  try {
    const response = await axios.get(`${API.BASE_URL}/markets/${symbol}`, { headers: getHeaders() });
    logger.info(`Market details for ${symbol}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    logger.error(`Error getting market details for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Get open positions
export const getOpenPositions = async () => {
  try {
    const response = await axios.get(`${API.BASE_URL}/positions`, { headers: getHeaders() });
    // logger.info("<========= Open positions received =========>\n" + JSON.stringify(response.data) + "\n\n");
    logger.info("<========= Open positions received =========>\n" + response.data.length + "\n\n");
    return response.data;
  } catch (error) {
    logger.error("Error getting open positions:", error.response ? error.response.data : error.message);
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

    logger.info(`from=${from} to=${to} in resolution=${resolution}`);

    const response = await axios.get(`${API.BASE_URL}/prices/${symbol}?resolution=${resolution}&max=${count}&from=${from}&to=${to}`, {
      headers: getHeaders(true),
    });

    // Log prices for each candle
    // if (response.data.prices && response.data.prices.length > 0) {
    //   logger.info("\nCandle Prices:");
    //   response.data.prices.forEach((candle, index) => {
    //     logger.info(`\nCandle ${index + 1} at ${candle.snapshotTime}:");
    //     logger.info("Open Price - Bid:", candle.openPrice.bid);
    //     logger.info("Open Price - Ask:", candle.openPrice.ask);
    //     logger.info("Close Price - Bid:", candle.closePrice.bid);
    //     logger.info("Close Price - Ask:", candle.closePrice.ask);
    //     logger.info("High Price - Bid:", candle.highPrice.bid);
    //     logger.info("High Price - Ask:", candle.highPrice.ask);
    //     logger.info("Low Price - Bid:", candle.lowPrice.bid);
    //     logger.info("Low Price - Ask:", candle.lowPrice.ask);
    //     logger.info("Volume:", candle.lastTradedVolume);
    //   });
    // }
    // return response.data;
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
    logger.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Place an order
export async function placeOrder(symbol, direction, size, level, orderType = "LIMIT") {
  try {
    logger.info(`Placing ${direction} order for ${symbol} at ${level}, size: ${size}`);

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

    logger.info("Order response:", response.data);
    return response.data;
  } catch (error) {
    if (error.response?.data) {
      logger.error("Order placement error:", error.response.data);
      throw new Error(error.response.data.errorCode || "Order placement failed");
    }
    throw error;
  }
}

// Update trailing stop
export async function updateTrailingStop(positionId, stopLevel) {
  try {
    logger.info(`Updating trailing stop for position ${positionId} to ${stopLevel}`);

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

    logger.info("Trailing stop updated successfully:", response.data);
    return response.data;
  } catch (error) {
    logger.error(`Error updating trailing stop for position ${positionId}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Place an immediate position for scalping
export async function placePosition(symbol, direction, size, level, stopLevel, profitLevel) {
  try {
    logger.info(`Placing ${direction} position for ${symbol} at market price...`);
    logger.info(`Original size: ${size}, Using size: ${size}`);
    logger.info(`Stop Loss: ${stopLevel}, Take Profit: ${profitLevel}`);

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

    logger.info("Sending position request:", position);

    const response = await axios.post(`${API.BASE_URL}/positions`, position, { headers: getHeaders(true) });

    logger.info("Position created successfully:", response.data);
    return response.data;
  } catch (error) {
    logger.error("Position creation error:", error.response?.data || error.message);
    throw error;
  }
}

// Get deal confirmation
export async function getDealConfirmation(dealReference) {
  try {
    logger.info(`Getting confirmation for deal: ${dealReference}`);
    const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });
    logger.info("[DealConfirmation]", response.data);
    return response.data;
  } catch (error) {
    logger.error(`[DealConfirmation] Error for ${dealReference}:`, error.response?.data || error.message);
    throw error;
  }
}

// Export session tokens for WebSocket connection
export function getSessionTokens() {
  return { cst, xsecurity };
}

// Get allowed TP/SL range for a symbol
export async function getAllowedTPRange(symbol) {
  try {
    const details = await getMarketDetails(symbol);
    // Capital.com returns min/max distances in marketDetails.instrument
    const instr = details.instrument;
    // For forex, these are usually in points (e.g. 10 = 0.0010 for EURUSD)
    return {
      minTPDistance: instr.limits?.limitDistance?.min || instr.limits?.limitLevel?.min || 0,
      maxTPDistance: instr.limits?.limitDistance?.max || instr.limits?.limitLevel?.max || Number.POSITIVE_INFINITY,
      minSLDistance: instr.limits?.stopDistance?.min || instr.limits?.stopLevel?.min || 0,
      maxSLDistance: instr.limits?.stopDistance?.max || instr.limits?.stopLevel?.max || Number.POSITIVE_INFINITY,
      // For reference, also return the instrument decimals
      decimals: instr.lotSizeScale || instr.scalingFactor || 5,
      // And the current market price (for level calculations)
      market: details.snapshot,
    };
  } catch (error) {
    logger.error(`[getAllowedTPRange] Error for ${symbol}:`, error.message);
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
