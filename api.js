import { BASE_URL, API_PATH, API_KEY, API_IDENTIFIER, API_PASSWORD, BACKTEST_MODE, SYMBOLS, TIMEFRAMES } from "./config.js";
import axios from "axios";

let cst, xsecurity;
let sessionStartTime = Date.now();

// Base headers for API requests
export const getHeaders = (includeContentType = false) => {
  const baseHeaders = {
    "X-SECURITY-TOKEN": xsecurity,
    "X-CAP-API-KEY": API_KEY,
    CST: cst,
  };

  return includeContentType ? { ...baseHeaders, "Content-Type": "application/json" } : baseHeaders;
};

// Start a new session with the API
export const startSession = async () => {
  try {
    const response = await axios.post(
      `${BASE_URL}${API_PATH}/session`,
      {
        identifier: API_IDENTIFIER,
        password: API_PASSWORD,
        encryptedPassword: false,
      },
      {
        headers: getHeaders(true), // Include headers for the reques
      }
    );

    console.log("<========= Session started successfully =========>\n", response.data, "\n\n");

    // Store the session tokens
    cst = response.headers["cst"];
    xsecurity = response.headers["x-security-token"];

    if (!cst || !xsecurity) {
      console.error("Warning: Session tokens not received in response headers");
      console.log("Response headers:", response.headers);
    }

    console.log("cst:", cst, "\nxsecurity:", xsecurity, "\n");

    return response.data;
  } catch (error) {
    console.error("Failed to start session:", error.response ? error.response.data : error.message);
    console.log("Request config:", error.config);
    if (error.response) {
      console.log("Response status:", error.response.status);
      console.log("Response headers:", error.response.headers);
    }
    throw error;
  }
};

// Refresh session tokens
export const refreshSession = async () => {
  if (Date.now() - sessionStartTime < 8.5 * 60 * 1000) return;
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/session`, { headers: getHeaders() });
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
    const response = await axios.get(`${BASE_URL}${API_PATH}/session`, { headers: getHeaders() });
    console.log("session details:", response.data);
  } catch (error) {
    console.error("session details:", error.response?.data || error.message);
  }
};

// Get account information
export const getAccountInfo = async () => {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/accounts`, { headers: getHeaders() });
    // console.log("<========= Account info received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting account info:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get open positions
export const getOpenPositions = async () => {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/positions`, { headers: getHeaders() });
    console.log("<========= Open positions received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting open positions:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Get activity history
export const getActivityHistory = async (from, to) => {
  try {
    // fetch("/history/activity?from=2022-01-17T15:09:47&to=2022-01-17T15:10:05&lastPeriod=600&detailed=true&dealId={{dealId}}&filter=source!=DEALER;type!=POSITION;status==REJECTED;epic==OIL_CRUDE,GOLD")
    console.log(`<========= Getting activity history from ${from} to ${to} =========>\n`);
    const response = await axios.get(`${BASE_URL}${API_PATH}/history/transactions`, {
      headers: getHeaders(),
      params: {
        from,
        to,
        detailed: true,
        lastPeriod: 600,
      },
    });
    console.log(response.data);
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

// Beispiel in getHistorical:
export async function getHistorical(symbol, resolution, count, from, to) {
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

    console.log(`from=${from} to=${to} in resolution=${resolution}`);

    const response = await axios.get(
      `${BASE_URL}${API_PATH}/prices/${symbol}?resolution=${resolution}&max=${count}&from=${from}&to=${to}`,
      {
        headers: getHeaders(true),
      }
    );

    // Log prices for each candle
    // if (response.data.prices && response.data.prices.length > 0) {
    //   console.log("\nCandle Prices:");
    //   response.data.prices.forEach((candle, index) => {
    //     console.log(`\nCandle ${index + 1} at ${candle.snapshotTime}:`);
    //     console.log("Open Price - Bid:", candle.openPrice.bid);
    //     console.log("Open Price - Ask:", candle.openPrice.ask);
    //     console.log("Close Price - Bid:", candle.closePrice.bid);
    //     console.log("Close Price - Ask:", candle.closePrice.ask);
    //     console.log("High Price - Bid:", candle.highPrice.bid);
    //     console.log("High Price - Ask:", candle.highPrice.ask);
    //     console.log("Low Price - Bid:", candle.lowPrice.bid);
    //     console.log("Low Price - Ask:", candle.lowPrice.ask);
    //     console.log("Volume:", candle.lastTradedVolume);
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
    console.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

export const getMarkets = async () => {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/markets?searchTerm=EUR`, { headers: getHeaders() });
    console.log("<========= Markets received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting markets:", error.response ? error.response.data : error.message);
    throw error;
  }
};

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

    const response = await axios.post(`${BASE_URL}${API_PATH}/workingorders`, order, {
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
export async function updateTrailingStop(positionId, stopLevel) {
  try {
    console.log(`Updating trailing stop for position ${positionId} to ${stopLevel}`);

    const response = await axios.put(
      `${BASE_URL}${API_PATH}/positions/${positionId}`,
      {
        trailingStop: true,
        stopLevel,
      },
      {
        headers: getHeaders(true),
      }
    );

    console.log("Trailing stop updated successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error(`Error updating trailing stop for position ${positionId}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Place an immediate position for scalping
export async function placePosition(symbol, direction, size, level, stopLevel, profitLevel) {
  try {
    console.log(`Placing ${direction} position for ${symbol} at market price, size: ${size}`);
    console.log(`Stop Loss: ${stopLevel}, Take Profit: ${profitLevel}`);

    // Validate inputs
    if (!symbol || !direction || !size || !stopLevel || !profitLevel) {
      throw new Error('Missing required parameters for position placement');
    }

    // Format the position request
    const position = {
      epic: symbol,
      direction: direction.toUpperCase(),
      size: size.toString(),
      orderType: "MARKET",
      guaranteedStop: false,
      stopLevel: parseFloat(stopLevel).toFixed(5),
      profitLevel: parseFloat(profitLevel).toFixed(5),
      limitDistance: null,
      stopDistance: null,
      trailingStop: false,
      forceOpen: true
    };

    console.log('Sending position request:', position);

    const response = await axios.post(
      `${BASE_URL}${API_PATH}/positions`,
      position,
      { headers: getHeaders(true) }
    );

    console.log('Position created successfully:', response.data);
    return response.data;

  } catch (error) {
    console.error('Position creation error:', error.response?.data || error.message);
    throw error;
  }
}

// Get deal confirmation
export async function getDealConfirmation(dealReference) {
  try {
    console.log(`Getting confirmation for deal: ${dealReference}`);
    const response = await axios.get(`${BASE_URL}${API_PATH}/confirms/${dealReference}`, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error("Error getting deal confirmation:", error.response?.data || error.message);
    throw error;
  }
}

// Export session tokens for WebSocket connection
export function getSessionTokens() {
  return { cst, xsecurity };
}
