// generateDataset.js
import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { calcIndicators } from "../indicators/indicators.js";
import logger from "../utils/logger.js";
dotenv.config();

// === CONFIG ===
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const BASE_URL = "https://api.twelvedata.com/time_series";

// === SYMBOLS ===
// Format: "EUR/USD"
const symbols = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CAD", "AUD/USD", "NZD/USD", "EUR/JPY", "GBP/JPY"];

// === TIMEFRAMES ===
const timeframes = {
    M1: "1min",
    M5: "5min",
    M15: "15min",
    H1: "1h",
    H4: "4h",
};

// Maximum candles per request as per Twelve Data limitations
const MAX_CANDLES_PER_REQUEST = 5000;

// Helper to convert timeframe to minutes
const timeframeToMinutes = {
    "1min": 1,
    "5min": 5,
    "15min": 15,
    "1h": 60,
    "4h": 240,
};

function mergeCandles(existing, incoming) {
    const map = new Map();

    for (const c of existing) {
        map.set(new Date(c.timestamp).getTime(), c);
    }

    for (const c of incoming) {
        const ts = new Date(c.timestamp).getTime();
        if (!map.has(ts)) {
            map.set(ts, c);
        }
    }

    // Convert back to array sorted ASC
    return Array.from(map.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Helper function to wait for given milliseconds
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// === UTILITY: fetch candles from Twelve Data ===
async function fetchTwelveDataCandles(symbol, interval, startDate, endDate) {
    // Twelve Data API expects symbol like "EUR/USD"
    // startDate and endDate in ISO format (YYYY-MM-DD HH:mm:ss)
    // We'll fetch in chunks if needed to stay under MAX_CANDLES_PER_REQUEST

    const allCandles = [];

    // Calculate total minutes between startDate and endDate
    const start = new Date(startDate);
    const end = new Date(endDate);
    const totalMinutes = (end - start) / (1000 * 60);
    const intervalMinutes = timeframeToMinutes[interval];

    // Calculate max duration per request in minutes
    const maxDurationMinutes = MAX_CANDLES_PER_REQUEST * intervalMinutes;

    let chunkStart = new Date(start);
    while (chunkStart < end) {
        const chunkEnd = new Date(Math.min(chunkStart.getTime() + maxDurationMinutes * 60 * 1000, end.getTime()));

        const from = chunkStart.toISOString().slice(0, 19);
        const to = chunkEnd.toISOString().slice(0, 19);

        const url = new URL(BASE_URL);
        url.searchParams.append("symbol", symbol);
        url.searchParams.append("interval", interval);
        url.searchParams.append("apikey", TWELVEDATA_API_KEY);
        url.searchParams.append("start_date", from);
        url.searchParams.append("end_date", to);
        url.searchParams.append("format", "JSON");
        url.searchParams.append("order", "asc");
        url.searchParams.append("timezone", "UTC");

        logger.info(`📡 Fetching ${symbol} ${interval} candles from ${from} to ${to}...`);

        const response = await fetch(url.toString());
        const data = await response.json();

        await wait(8000);

        if (data.status === "error") {
            throw new Error(data.message || "Error fetching data from Twelve Data");
        }

        if (!data.values || data.values.length === 0) {
            logger.info(`⚠️ No data returned for ${symbol} ${interval} between ${from} and ${to}`);
            break;
        }

        // data.values is array of candles ordered descending by datetime, we want ascending
        const candles = data.values
            .map((c) => ({
                timestamp: new Date(c.datetime + "Z"),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
            }))
            .reverse();

        allCandles.push(...candles);

        // Move chunkStart forward
        chunkStart = new Date(chunkEnd.getTime() + 60 * 1000 * intervalMinutes);
    }

    return allCandles;
}

// === UTILITY: aggregate H4 from H1 ===
function aggregateH4FromH1(h1Candles) {
    // Assumes h1Candles sorted ascending by timestamp
    const h4Candles = [];
    for (let i = 0; i < h1Candles.length; i += 4) {
        const chunk = h1Candles.slice(i, i + 4);
        if (chunk.length < 4) break;

        const open = chunk[0].open;
        const close = chunk[3].close;
        const high = Math.max(...chunk.map((c) => c.high));
        const low = Math.min(...chunk.map((c) => c.low));
        const timestamp = chunk[0].timestamp;

        h4Candles.push({ timestamp, open, high, low, close });
    }
    return h4Candles;
}

// === MAIN ===
async function generateDataset() {
    if (!fs.existsSync("./data")) fs.mkdirSync("./data");

    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    for (const symbol of symbols) {
        // We will fetch H1 data once to use for H4 aggregation if needed
        let h1Candles = null;

        for (const [tfName, interval] of Object.entries(timeframes)) {
            try {
                let candles;

                let startDate;
                if (tfName === "M1") {
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                } else if (tfName === "M5") {
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                } else if (tfName === "M15") {
                    startDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
                } else {
                    startDate = oneYearAgo;
                }

                if (tfName === "H4") {
                    // Fetch H1 data once if not already fetched
                    if (!h1Candles) {
                        h1Candles = await fetchTwelveDataCandles(symbol, timeframes.H1, startDate.toISOString().slice(0, 19), now.toISOString().slice(0, 19));
                        logger.info(`✅ ${h1Candles.length} H1 candles fetched for ${symbol}`);
                    }
                    // Aggregate H4 from H1
                    candles = aggregateH4FromH1(h1Candles);
                    logger.info(`✅ Aggregated ${candles.length} H4 candles for ${symbol}`);
                } else {
                    candles = await fetchTwelveDataCandles(symbol, interval, startDate.toISOString().slice(0, 19), now.toISOString().slice(0, 19));
                    logger.info(`✅ ${candles.length} candles fetched for ${symbol} ${tfName}`);
                }

                const indicatorResults = [];
                for (let i = 50; i < candles.length; i++) {
                    const slice = candles.slice(i - 50, i + 1);
                    const indicators = await calcIndicators(slice);
                    indicatorResults.push({
                        timestamp: candles[i].timestamp,
                        open: candles[i].open,
                        high: candles[i].high,
                        low: candles[i].low,
                        close: candles[i].close,
                        ...indicators,
                    });
                }

                const filePath = `./data/${symbol.replace("/", "")}_${tfName}.json`;

                // Load existing file if exists
                let existing = [];
                if (fs.existsSync(filePath)) {
                    try {
                        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
                    } catch (e) {
                        logger.error(`⚠️ Failed to parse existing file: ${filePath}`);
                    }
                }

                // Remove indicators, keep only raw candles for merging
                const existingRaw = existing.map((c) => ({
                    timestamp: c.timestamp,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                }));

                // Raw candles before indicator calculation
                const newRaw = candles.map((c) => ({
                    timestamp: c.timestamp,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                }));

                // Merge raw
                const mergedRaw = mergeCandles(existingRaw, newRaw);

                // Recalculate indicators for merged
                const newIndicatorResults = [];
                for (let i = 50; i < mergedRaw.length; i++) {
                    const slice = mergedRaw.slice(i - 50, i + 1);
                    const indicators = await calcIndicators(slice);
                    newIndicatorResults.push({
                        timestamp: mergedRaw[i].timestamp,
                        open: mergedRaw[i].open,
                        high: mergedRaw[i].high,
                        low: mergedRaw[i].low,
                        close: mergedRaw[i].close,
                        ...indicators,
                    });
                }

                // Save final file
                fs.writeFileSync(filePath, JSON.stringify(newIndicatorResults, null, 2));
                logger.info(`💾 Updated dataset → ${filePath} (${newIndicatorResults.length} candles)`);
            } catch (err) {
                logger.error(`❌ Error processing ${symbol} ${tfName}: ${err.message}`);
            }
        }
    }

    logger.info("📊 Twelve Data dataset generation completed!");
}

generateDataset();
