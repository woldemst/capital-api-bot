import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
if (!fs.existsSync("./logs")) {
  fs.mkdirSync("./logs");
}

// Helper to format timestamp as 'YYYY-MM-DD HH:mm:ss'
function getLocalTimestamp() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());
  const min = pad(now.getMinutes());
  const sec = pad(now.getSeconds());
  return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
}

const logger = {
  info: (message) => {
    const timestamp = getLocalTimestamp();
    if (typeof message === 'object') {
      console.log(`[INFO] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`);
    } else {
      console.log(`[INFO] ${timestamp} | ${message}`);
    }
  },
  
  error: (message, error) => {
    const timestamp = getLocalTimestamp();
    if (typeof message === 'object') {
      console.error(`[ERROR] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || '');
    } else {
      console.error(`[ERROR] ${timestamp} | ${message}`, error || '');
    }
  },
  
  warn: (message, error) => {
    const timestamp = getLocalTimestamp();
    if (typeof message === 'object') {
      console.warn(`[WARN] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || '');
    } else {
      console.warn(`[WARN] ${timestamp} | ${message}`, error || '');
    }
  },
  
  trade: (action, symbol, details) => {
    const timestamp = getLocalTimestamp();
    if (typeof details === 'object') {
      console.log(`\n\n[TRADE] ${timestamp} | ${action} ${symbol}:\n${JSON.stringify(details, null, 2)}\n`);
    } else {
      console.log(`\n\n[TRADE] ${timestamp} | ${action} ${symbol}: ${details}`);
    }
  }
};

export default logger;