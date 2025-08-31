import fs from "fs";
import path from "path";

// Ensure logs directory exists
if (!fs.existsSync("./logs")) {
    fs.mkdirSync("./logs");
}

const logger = {
    info: (message) => {
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.log(`[INFO] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`);
        } else {
            console.log(`[INFO] ${timestamp} | ${message}`);
        }
    },

    error: (message, error) => {
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.error(`[ERROR] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || "");
        } else {
            console.error(`[ERROR] ${timestamp} | ${message}`, error || "");
        }
    },

    warn: (message, error) => {
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.warn(`[WARN] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`, error || "");
        } else {
            console.warn(`[WARN] ${timestamp} | ${message}`, error || "");
        }
    },

    trade: (action, symbol, details) => {
        const timestamp = new Date().toISOString();
        if (typeof details === "object") {
            console.log(`[TRADE] ${timestamp} | ${action} ${symbol}:\n${JSON.stringify(details, null, 2)}\n`);
        } else {
            console.log(`[TRADE] ${timestamp} | ${action} ${symbol}: ${details}`);
        }
    },

    debug: (message) => {
        const timestamp = new Date().toISOString();
        if (typeof message === "object") {
            console.debug(`[DEBUG] ${timestamp} |\n${JSON.stringify(message, null, 2)}\n`);
        } else {
            console.debug(`[DEBUG] ${timestamp} | ${message}`);
        }
    },
};

export default logger;
