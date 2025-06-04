import axios from "axios";
import { BASE_URL, API_PATH, API_KEY, API_IDENTIFIER, API_PASSWORD } from "./config.js";

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
    // Log environment variables (without exposing sensitive data)
    // console.log("API_KEY exists:", !!API_KEY);
    // console.log("API_IDENTIFIER exists:", !!API_IDENTIFIER);
    // console.log("API_PASSWORD exists:", !!API_PASSWORD);
    // console.log("BASE_URL:", BASE_URL);

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
    console.log("<========= Account info received =========>\n", response.data, "\n\n");
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
    console.log(`<========= Fetching activity history from ${from} to ${to} =========>\n`);
    const response = await axios.get(`${BASE_URL}${API_PATH}/history/activity`, {
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
  // erzeugt “2025-06-04T18:43:50.506Z”
  const iso = date.toISOString();
  // split bei Punkt und nimm den Teil vor “.”
  return iso.split(".")[0]; // ergibt “2025-06-04T18:43:50”
}

// Beispiel in getHistorical:
export async function getHistorical(symbol, resolution, count, from, to) {
  try {
    const nowMs = Date.now();

    // Wenn kein “to” gegeben, nimm jetzt ohne ms & Z
    if (!to) {
      to = formatIsoNoMs(new Date(nowMs));
      // “2025-06-04T18:43:50”
    }

    // Wenn kein “from” gegeben, rechne zurück je nach Timeframe
    if (!from) {
      const resolutionToMs = {
        MINUTE: 1 * 60 * 1000,
        MINUTE_15: 5 * 60 * 1000,
        MINUTE_15: 15 * 60 * 1000,
        HOUR: 1 * 60 * 60  * 1000,
        HOUR_4: 4 * 60 * 60 * 1000,
        DAY: 24 * 60 * 60 * 1000,
      };
      const stepMs = resolutionToMs[resolution] || resolutionToMs.m1;
      const fromMs = nowMs - count * stepMs;

      // Datum ohne ms & Z: “2025-04-24T00:00:00”
      from = formatIsoNoMs(new Date(fromMs));
    }

    console.log(`Fetching ${symbol} candles from=${from} to=${to}`);

    const response = await axios.get(`${BASE_URL}${API_PATH}/prices/${symbol}?resolution=${resolution}&max=100&from=${from}&to=${to}`, {
      headers: getHeaders(true),
    });

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
    if (response.data.prices?.length) {
      console.log("Received candles:", response.data.prices.length);
    }
    return response.data;
  } catch (error) {
    console.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

export const getMarkets = async () => {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/markets?searchTerm=CAD`, { headers: getHeaders() });
    console.log("<========= Markets received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting markets:", error.response ? error.response.data : error.message);
    throw error;
  }
};

// Place an order
export async function placeOrder(symbol, direction, price, size, stopLoss, takeProfit) {
  try {
    console.log(`Placing ${direction} order for ${symbol} at ${price}, size: ${size}`);
    console.log(`Stop Loss: ${stopLoss}, Take Profit: ${takeProfit}`);

    const order = {
      epic: symbol.replace("/", "_"),
      direction: direction.toUpperCase(),
      size,
      orderType: "MARKET",
      guaranteedStop: false,
      trailingStop: false,
    };

    // Add stop loss and take profit if provided
    if (stopLoss) {
      order.stopLevel = direction.toUpperCase() === "BUY" ? price - stopLoss : price + stopLoss;
    }

    if (takeProfit) {
      order.profitLevel = direction.toUpperCase() === "BUY" ? price + takeProfit : price - takeProfit;
    }

    const response = await axios.post(`${BASE_URL}${API_PATH}/positions`, order, { headers: getHeaders(true) });

    console.log("Order placed successfully:", response.data);
    return response.data;
  } catch (error) {
    console.error(`Error placing order for ${symbol}:`, error.response ? error.response.data : error.message);
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

// Export session tokens for WebSocket connection
export function getSessionTokens() {
  return { cst, xsecurity };
}
