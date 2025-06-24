import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
if (!fs.existsSync("./logs")) {
  fs.mkdirSync("./logs");
}

// Create a write stream for price logs
const priceLogStream = fs.createWriteStream(
  path.join("./logs", `prices_${new Date().toISOString().split("T")[0]}.log`),
  { flags: "a" }
);

const logger = {
  info: (message) => {
    const timestamp = new Date().toISOString();
    if (typeof message === 'object') {
      console.log(`[INFO] ${timestamp} -\n${JSON.stringify(message, null, 2)}\n`);
    } else {
      console.log(`[INFO] ${timestamp} - ${message}`);
    }
  },
  
  error: (message, error) => {
    const timestamp = new Date().toISOString();
    if (typeof message === 'object') {
      console.error(`[ERROR] ${timestamp} -\n${JSON.stringify(message, null, 2)}\n`, error || '');
    } else {
      console.error(`[ERROR] ${timestamp} - ${message}`, error || '');
    }
  },
  
  price: (symbol, bid, ask) => {
    const timestamp = new Date().toISOString();
    console.log(`[PRICE] ${timestamp} - ${symbol}: Bid: ${bid} | Ask: ${ask}`);
    priceLogStream.write(`${timestamp},${symbol},${bid},${ask}\n`);
  },
  
  trade: (action, symbol, details) => {
    const timestamp = new Date().toISOString();
    if (typeof details === 'object') {
      console.log(`[TRADE] ${timestamp} - ${action} ${symbol}:\n${JSON.stringify(details, null, 2)}\n`);
    } else {
      console.log(`[TRADE] ${timestamp} - ${action} ${symbol}: ${details}`);
    }
  },
  
  indicator: (symbol, timeframe, data) => {
    const timestamp = new Date().toISOString();
    const fileName = `indicators_${new Date().toISOString().split("T")[0]}.log`;
    const filePath = path.join("./logs", fileName);
    // Pretty-print JSON for readability
    const logLine = `${timestamp},${symbol},${timeframe},\n${JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(filePath, logLine);
    // console.log(`[INDICATOR] ${timestamp} - ${symbol} ${timeframe}:\n${JSON.stringify(data, null, 2)}`);
  }
};

export default logger;