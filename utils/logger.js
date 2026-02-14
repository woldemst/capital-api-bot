import fs from "fs";
import path from "path";

// Ensure logs directory exists
const LOG_DIR = path.join(process.cwd(), "backtest", "logs");
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    trade: 2,
    debug: 3,
};

const activeLogLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevelValue = LOG_LEVELS[activeLogLevel] ?? LOG_LEVELS.info;
const shouldLog = (level) => LOG_LEVELS[level] <= activeLevelValue;

const logger = {
    info: (message) => {
        if (!shouldLog("info")) return;
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.log(`[INFO] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`);
        } else {
            console.log(`[INFO] ${timestamp} | ${message}`);
        }
    },

    error: (message, error) => {
        if (!shouldLog("error")) return;
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.error(`[ERROR] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || "");
        } else {
            console.error(`[ERROR] ${timestamp} | ${message}`, error || "");
        }
    },

    warn: (message, error) => {
        if (!shouldLog("warn")) return;
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.warn(`[WARN] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || "");
        } else {
            console.warn(`[WARN] ${timestamp} | ${message}`, error || "");
        }
    },

    trade: (action, symbol, details) => {
        if (!shouldLog("trade")) return;
        const timestamp = new Date().toISOString();
        if (typeof details === "object") {
            console.log(`[TRADE] ${timestamp} | ${action} ${symbol}:\n${JSON.stringify(details, null, 2)}\n`);
        } else {
            console.log(`[TRADE] ${timestamp} | ${action} ${symbol}: ${details}`);
        }
    },

    debug: (message) => {
        if (!shouldLog("debug")) return;
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.debug(`[DEBUG] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`);
        } else {
            console.debug(`[DEBUG] ${timestamp} | ${message}`);
        }
    },
};

export default logger;
