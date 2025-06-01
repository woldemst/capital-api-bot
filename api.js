import axios from "axios";
import { BASE_URL, API_PATH, API_KEY, API_IDENTIFIER, API_PASSWORD } from "./config.js";

let cst, xsecurity;
let sessionStartTime = Date.now();

// Base headers for API requests
const getHeaders = (includeContentType = false) => {
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

    // Prepare request with proper format and correct endpoint
    const response = await axios.post(
      `${BASE_URL}${API_PATH}/session`,
      {
        identifier: API_IDENTIFIER,
        password: API_PASSWORD,
        encryptedPassword: false,
      },
      {
        headers: {
          "X-CAP-API-KEY": API_KEY,
          "Content-Type": "application/json",
        },
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
    // const response = await axios.get(`${BASE_URL}${API_PATH}/history/activity?from=${from}&to=${to}`, {
    // const response = await axios.get(`${BASE_URL}${API_PATH}/history/activity`, {
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

// Get historical price data
export async function getHistorical(symbol, resolution, count, from, to) {
  try {
    const resolutionMap = {
      m1: "MINUTE",
      m5: "MINUTE_5",
      m15: "MINUTE_15",
      m30: "MINUTE_30",
      h1: "HOUR",
      h4: "HOUR_4",
      d1: "DAY",
    };

    // Format the symbol correctly for the API (e.g., CS.D.EURUSD.CFD.IP)
    const formattedSymbol = `CS.D.${symbol.replace('_', '')}.CFD.IP`;

    console.log(`<========= Fetching historical data for ${symbol} with resolution ${resolution}, count: ${count} =========>\n`);
    const response = await axios.get(
      `${BASE_URL}${API_PATH}/prices/${symbol}?resolution=MINUTE&max=10&from=2025-04-24T00:00:00&to=2025-04-24T01:00:00`,
      {
        headers: getHeaders(true),
        // params: { resolution, max: count, from, to },
      }
    );

    // const response = await axios.get(
    //   `${BASE_URL}${API_PATH}/prices/${formattedSymbol}`,
    //   {
    //     headers: getHeaders(true),
    //     params: {
    //       resolution: resolutionMap[resolution] || resolution,
    //       max: count
    //     },
    //   }
    // );
console.log(response.data);

    return response.data;
  } catch (error) {
    console.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

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

    const response = await axios.post(`${BASE_URL}${API_PATH}/positions`, order, {
      headers: {
        "X-SECURITY-TOKEN": xsecurity,
        CST: cst,
        "X-CAP-API-KEY": API_KEY,
        "Content-Type": "application/json",
      },
    });

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
        headers: {
          "X-SECURITY-TOKEN": xsecurity,
          CST: cst,
          "X-CAP-API-KEY": API_KEY,
          "Content-Type": "application/json",
        },
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
