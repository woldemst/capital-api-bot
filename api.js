import axios from "axios";
import { BASE_URL, API_PATH, API_KEY, API_IDENTIFIER, API_PASSWORD } from "./config.js";

let cst, xsecurity;

// Start a new session with the API
export async function startSession() {
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
}

// Get account information
export async function getAccountInfo() {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/accounts`, {
      headers: {
        "X-SECURITY-TOKEN": xsecurity,
        CST: cst,
        "X-CAP-API-KEY": API_KEY,
      },
    });

    console.log("<========= Account info received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting account info:", error.response ? error.response.data : error.message);
    throw error;
  }
}

// Get historical price data
export async function getHistorical(symbol, resolution, count) {
  try {
    console.log(`<========= Fetching historical data for ${symbol} with resolution ${resolution}, count: ${count} =========>\n`);

    // Map resolution string to API format
    const resolutionMap = {
      m1: "MINUTE",
      m5: "MINUTE_5",
      m15: "MINUTE_15",
      m30: "MINUTE_30",
      h1: "HOUR",
      h4: "HOUR_4",
      d1: "DAY",
    };

    const apiResolution = resolutionMap[resolution] || "MINUTE";

    // Format the symbol for the API (replace / with _)
    const formattedSymbol = symbol.replace("/", "_");

    // Use the correct endpoint format for Capital.com API
    // const response = await axios.get(`${BASE_URL}${API_PATH}/prices/CFD/${formattedSymbol}`, {
    const response = await axios.get(`${BASE_URL}${API_PATH}/prices/EUR_USD`, {
      params: {
        resolution: apiResolution,
        max: count,
      },
      headers: {
        "X-SECURITY-TOKEN": xsecurity,
        CST: cst,
        "X-CAP-API-KEY": API_KEY,
      },
    });

    return response.data;
  } catch (error) {
    console.error(`Error fetching historical data for ${symbol}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Get open positions
export async function getOpenPositions() {
  try {
    const response = await axios.get(`${BASE_URL}${API_PATH}/positions`, {
      headers: {
        "X-SECURITY-TOKEN": xsecurity,
        CST: cst,
        "X-CAP-API-KEY": API_KEY,
      },
    });

    console.log("<========= Open positions received =========>\n", response.data, "\n\n");
    return response.data;
  } catch (error) {
    console.error("Error getting open positions:", error.response ? error.response.data : error.message);
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