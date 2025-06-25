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
    console.log(`[INFO] ${timestamp} - ${message}`);
  },
  
  error: (message, error) => {
    const timestamp = new Date().toISOString();
    console.error(`[ERROR] ${timestamp} - ${message}`, error || '');
  },
  
  price: (symbol, bid, ask) => {
    const timestamp = new Date().toISOString();
    console.log(`[PRICE] ${timestamp} - ${symbol}: Bid: ${bid} | Ask: ${ask}`);
    priceLogStream.write(`${timestamp},${symbol},${bid},${ask}\n`);
  },
  
  trade: (action, symbol, details) => {
    const timestamp = new Date().toISOString();
    console.log(`[TRADE] ${timestamp} - ${action} ${symbol}: ${JSON.stringify(details)}`);
  }
};

export default logger;