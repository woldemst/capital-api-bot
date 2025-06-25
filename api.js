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

// Helper: Retry API call after session refresh if session error
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
      // Try again once
      return await fn(...args);
    }
    throw error;
  }
}

// Wrap main API calls with withSessionRetry
export const getAccountInfo = async () => withSessionRetry(async () => {
  const response = await axios.get(`${API.BASE_URL}/accounts`, { headers: getHeaders() });
  return response.data;
});

export const getMarkets = async () => withSessionRetry(async () => {
  const response = await axios.get(`${API.BASE_URL}/markets?searchTerm=EURUSD`, { headers: getHeaders() });
  return Array.isArray(response.data.markets) ? response.data.markets : [];
});

export async function getMarketDetails(symbol) {
  return await withSessionRetry(async () => {
    const response = await axios.get(`${API.BASE_URL}/markets/${symbol}`, { headers: getHeaders() });
    logger.info(`Market details for ${symbol}: ${JSON.stringify(response.data)}`);
    return response.data;
  });
}

export const getOpenPositions = async () => withSessionRetry(async () => {
  const response = await axios.get(`${API.BASE_URL}/positions`, { headers: getHeaders() });
  logger.info("<========= Open positions received =========>\n" + response.data.length + "\n\n");
  return response.data;
});

export async function getHistorical(symbol, resolution, count, from = null, to = null) {
  return await withSessionRetry(async () => {
    const nowMs = Date.now();
    if (!to) {
      to = formatIsoNoMs(new Date(nowMs));
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
      from = formatIsoNoMs(new Date(fromMs));
    }
    logger.info(`from=${from} to=${to} in resolution=${resolution}`);
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
  });
}

export async function placeOrder(symbol, direction, size, level, orderType = "LIMIT") {
  return await withSessionRetry(async () => {
    logger.info(`Placing ${direction} order for ${symbol} at ${level}, size: ${size}`);
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
    logger.info("Order response:", response.data);
    return response.data;
  });
}

export async function updateTrailingStop(positionId, stopLevel) {
  return await withSessionRetry(async () => {
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
  });
}

export async function placePosition(symbol, direction, size, level, stopLevel, profitLevel) {
  return await withSessionRetry(async () => {
    logger.info(`Placing ${direction} position for ${symbol} at market price...`);
    logger.info(`Original size: ${size}, Using size: ${size}`);
    logger.info(`Stop Loss: ${stopLevel}, Take Profit: ${profitLevel}`);
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
  });
}

export async function getDealConfirmation(dealReference) {
  return await withSessionRetry(async () => {
    logger.info(`Getting confirmation for deal: ${dealReference}`);
    const response = await axios.get(`${API.BASE_URL}/confirms/${dealReference}`, { headers: getHeaders() });
    logger.info("[DealConfirmation]", response.data);
    return response.data;
  });
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
