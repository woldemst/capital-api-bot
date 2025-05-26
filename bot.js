import WebSocket from "ws";
import {
  SYMBOLS, WS_BASE_URL, TAKE_PROFIT_FACTOR, TRAILING_STOP_PIPS, PROFIT_THRESHOLD, MAX_OPEN_TRADES
} from "./config.js";
import {
  startSession, getHistorical, getAccountInfo, getOpenPositions, 
  placeOrder, updateTrailingStop, getSessionTokens
} from "./api.js";
import { calcIndicators, analyzeTrend } from "./indicators.js";
import { positionSize, generateSignals } from "./trading.js";
import fs from 'fs';
import path from 'path';

// Global state
let openTrades = [];
let accountBalance = 0;
let profitThresholdReached = false;

// Main bot function
async function run() {
  try {
    // Start session and get account info
    await startSession();
    const accountData = await getAccountInfo();
    accountBalance = accountData.accounts[0].balance;
    console.log('<========= Initial account balance =========>\n', accountBalance, "\n\n");
    
    // // Store initial balance for profit tracking if not already set
    // if (!process.env.INITIAL_BALANCE) {
    //   process.env.INITIAL_BALANCE = accountBalance.toString();
    //   console.log('Setting initial balance for profit tracking:', process.env.INITIAL_BALANCE);
    // }
    
    // Get open positions
    const positions = await getOpenPositions();
    openTrades = positions.positions.map(pos => pos.market.epic.replace('_', '/'));
    console.log('<========= Current open trades =========>\n', openTrades, "\n\n");
    
    // Get session tokens for WebSocket
    const { cst, xsecurity } = getSessionTokens();
    
    // Fix: Correct WebSocket URL format
    // Connect to WebSocket for real-time price updates
    const wsUrl = `${WS_BASE_URL}/connect`;
    
    console.log(
      '<========= Connecting to WebSocket =========>\n', 
      wsUrl, "\n\n"
    );
    const ws = new WebSocket(wsUrl, {
      headers: { 'X-SECURITY-TOKEN': xsecurity, 'CST': cst }
    });
    
    ws.on('open', () => {
      console.log('WebSocket connected');
      
      // Subscribe to price updates for each symbol
      const formattedSymbols = SYMBOLS.map(s => s.replace('/', '_'));
      
      // Send subscription message with authentication tokens
      const subscriptionMessage = {
        destination: "marketData.subscribe",
        correlationId: "1",
        payload: {
          epics: formattedSymbols,
          cst: cst,
          securityToken: xsecurity
        }
      };
      
      ws.send(JSON.stringify(subscriptionMessage));
      console.log('Subscribed to symbols:', formattedSymbols);
    });
    
    ws.on('error', (error) => console.error('WebSocket error:', error));
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync('./logs')) {
      fs.mkdirSync('./logs');
    }
    
    // Create a write stream for price logs
    const priceLogStream = fs.createWriteStream(
      path.join('./logs', `prices_${new Date().toISOString().split('T')[0]}.log`),
      { flags: 'a' }
    );
    
    ws.on('message', async (data) => {
      try {
        console.log('Raw WebSocket message received:');
        console.log(data.toString());
        
        const msg = JSON.parse(data.toString());
        console.log('Parsed message:', msg);
        
        // Check if it's a price update message
        if (msg.epic) {
          const symbol = msg.epic.replace('_', '/');
          const bid = msg.bid;
          const ask = msg.offer;
          const timestamp = new Date().toISOString();
          
          // Log to console
          console.log(`\n📊 PRICE UPDATE [${timestamp}] - ${symbol}: Bid: ${bid} | Ask: ${ask}\n`);
          
          // Also log to file
          priceLogStream.write(`${timestamp},${symbol},${bid},${ask}\n`);
          
          // Skip if we already have max open trades or this symbol is already traded
          if (openTrades.length >= MAX_OPEN_TRADES || openTrades.includes(symbol)) {
            return;
          }
          
          // Analyze trend on higher timeframes
          const trendAnalysis = await analyzeTrend(symbol, getHistorical);
          
          // Only proceed if overall trend is clear (not mixed)
          if (trendAnalysis.overallTrend === 'mixed') {
            console.log(`<========= Skipping ${symbol} due to mixed trend on higher timeframes =======>\n`);
            return;
          }
          
          // Get M1 data for entry signals
          const m1Data = await getHistorical(symbol, 'm1', 100);
          const m15Data = await getHistorical(symbol, 'm15', 50);
          
          // Calculate indicators
          const m1Indicators = await calcIndicators(m1Data);
          const m15Indicators = await calcIndicators(m15Data);
          
          console.log(`<========= ${symbol} Indicators ========>\n`, {
            m1: {
              maFast: m1Indicators.maFast,
              maSlow: m1Indicators.maSlow,
              rsi: m1Indicators.rsi,
              bbUpper: m1Indicators.bb.upper,
              bbLower: m1Indicators.bb.lower,
              macd: m1Indicators.macd.MACD,
              signal: m1Indicators.macd.signal,
              histogram: m1Indicators.macd.histogram
            },
            m15: {
              maFast: m15Indicators.maFast,
              maSlow: m15Indicators.maSlow,
              rsi: m15Indicators.rsi
            },
            h4Trend: trendAnalysis.h4Trend,
            d1Trend: trendAnalysis.d1Trend
          });
          
          // Generate trading signals
          const { signal } = generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask);
          
          if (signal) {
            console.log(`<========= ${symbol} ${signal.toUpperCase()} signal generated! =======>\n`);
            
            // Calculate stop loss and take profit levels
            const stopLossPips = 40; // Default 40 pips stop loss
            const takeProfitPips = stopLossPips * TAKE_PROFIT_FACTOR;
            
            // Calculate position size based on risk management
            const size = positionSize(accountBalance, bid, stopLossPips, profitThresholdReached);
            
            // Place the order
            const orderResult = await placeOrder(
              symbol, 
              signal, 
              signal === 'buy' ? ask : bid, 
              size, 
              stopLossPips * 0.0001, // Convert pips to price
              takeProfitPips * 0.0001  // Convert pips to price
            );
            
            // Add to open trades
            openTrades.push(symbol);
            
            // Set up trailing stop once position is in profit
            setTimeout(async () => {
              try {
                // Get current position details
                const positions = await getOpenPositions();
                const position = positions.positions.find(p => p.market.epic.replace('_', '/') === symbol);
                
                if (position && position.profit > 0) {
                  // Calculate trailing stop level
                  const trailingStopLevel = signal === 'buy' ? 
                    position.level - (TRAILING_STOP_PIPS * 0.0001) : 
                    position.level + (TRAILING_STOP_PIPS * 0.0001);
                  
                  // Update trailing stop
                  await updateTrailingStop(position.position.dealId, trailingStopLevel);
                }
              } catch (error) {
                console.error('Error setting trailing stop:', error.message);
              }
            }, 5 * 60 * 1000); // Check after 5 minutes
          }
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error.message);
      }
    });
    
    // Keep connection alive with ping every 9 minutes
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('Ping sent to keep WebSocket connection alive');
      }
    }, 9 * 60 * 1000);
    
    // Periodically update account info and check profit threshold
    setInterval(async () => {
      try {
        const accountData = await getAccountInfo();
        accountBalance = accountData.accounts[0].balance;
        
        // Check if profit threshold has been reached
        const initialBalance = parseFloat(process.env.INITIAL_BALANCE || accountBalance);
        const profitPercentage = (accountBalance - initialBalance) / initialBalance;
        
        if (profitPercentage >= PROFIT_THRESHOLD) {
          console.log(`<========= Profit threshold of ${PROFIT_THRESHOLD * 100}% reached! Increasing position size =======>\n`);
          profitThresholdReached = true;
        }
      } catch (error) {
        console.error('Error updating account info:', error.message);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    
  } catch (error) {
    console.error('Error in main bot execution:', error.message);
    throw error;
  }
}

run().catch(console.error);