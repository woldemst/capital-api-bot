import "dotenv/config";
import axios from "axios";
import WebSocket from "ws";
import { SMA, EMA, RSI, BollingerBands } from "technicalindicators";

// --- Configuration ---
const { API_KEY, API_IDENTIFIER, API_PASSWORD } = process.env;
const BASE_URL = process.env.BASE_URL || "https://demo-api-capital.backend-capital.com";
const API_PATH = "/api/v1";
const WS_URL = "wss://demo-stream-capital.backend-capital.com";
const SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"];
const LEVERAGE = 30;
const RISK_PER_TRADE = 0.02;
const MAX_OPEN_TRADES = 3;

let openTrades = [];
let cst, xsecurity;

// --- Utils ---
async function startSession() {
  try {
    // Log environment variables (without exposing sensitive data)
    console.log("API_KEY exists:", !!process.env.API_KEY);
    console.log("API_IDENTIFIER exists:", !!process.env.API_IDENTIFIER);
    console.log("API_PASSWORD exists:", !!process.env.API_PASSWORD);
    console.log("BASE_URL:", process.env.BASE_URL);
    
    // Prepare request with proper format and correct endpoint
    const response = await axios.post(
      `${BASE_URL}${API_PATH}/session`,
      {
        identifier: API_IDENTIFIER,
        password: API_PASSWORD,
        encryptedPassword: false
      },
      {
        headers: {
          "X-CAP-API-KEY": API_KEY,
          "Content-Type": "application/json"
        }
      }
    );
    
    console.log("Session started", response.data);
    
    // Store the session tokens
    cst = response.headers['cst'];
    xsecurity = response.headers['x-security-token'];
    
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

async function calcIndicators(bars) {
  const closes = bars.map((b) => b.close);
  return {
    maFast: SMA.calculate({ period: 5, values: closes }).pop(),
    maSlow: SMA.calculate({ period: 20, values: closes }).pop(),
    rsi: RSI.calculate({ period: 14, values: closes }).pop(),
    bb: BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }).pop(),
  };
}

function positionSize(balance, price) {
  const amount = balance * RISK_PER_TRADE;
  const pipValue = 0.0001;
  const slPips = 40;
  return Math.max(0.01, (amount * LEVERAGE) / (slPips * pipValue));
}

// --- Main Bot ---
async function run() {
  await startSession();

  //   const acc = await axios.get(`${BASE_URL}/accounts`, {
  //     headers: { 'X-CST': cst, 'X-SECURITY-TOKEN': xsecurity }
  //   });
  //   const balance = acc.data.accounts[0].balance;
  //   console.log('Balance:', balance);

  //   const ws = new WebSocket(`${WS_URL}/prices?symbols=${SYMBOLS.join(',')}`, {
  //     headers: { 'X-CST': cst, 'X-SECURITY-TOKEN': xsecurity }
  //   });

  //   ws.on('open', () => console.log('WS connected'));

  //   ws.on('message', async data => {
  //     const msg = JSON.parse(data);
  //     const { symbol, bid } = msg;
  //     console.log('Price update', symbol, bid);

  //     if (openTrades.length >= MAX_OPEN_TRADES || openTrades.includes(symbol)) return;

  //     const hist = await getHistorical(symbol, 'm1', 100);
  //     const { maFast, maSlow, rsi, bb } = calcIndicators(hist);
  //     console.log({ symbol, maFast, maSlow, rsi, bb });

  //     let signal = null;
  //     if (maFast > maSlow && rsi < 30 && bid <= bb.lower) signal = 'buy';
  //     if (maFast < maSlow && rsi > 70 && bid >= bb.upper) signal = 'sell';

  //     if (signal) {
  //       const qty = positionSize(balance, bid);
  //       console.log(`Placing ${signal} for ${symbol} qty ${qty}`);

  //       const ord = await axios.post(
  //         `${BASE_URL}/orders`,
  //         {
  //           symbol,
  //           is_buy: signal === 'buy',
  //           amount: qty,
  //           leverage: LEVERAGE,
  //           order_type: 'AtMarket'
  //         },
  //         {
  //           headers: {
  //             'X-CST': cst,
  //             'X-SECURITY-TOKEN': xsecurity,
  //             'X-CAP-API-KEY': API_KEY
  //           }
  //         }
  //       );

  //       openTrades.push(symbol);
  //       console.log('Order response', ord.data);
  //     }
  //   });
}

run().catch(console.error);
