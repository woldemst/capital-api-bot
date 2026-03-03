import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { calcIndicators } from "../indicators/indicators.js";
import logger from "../utils/logger.js";

dotenv.config();

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const BASE_URL = "https://api.twelvedata.com/time_series";

const OUTPUT_DIR = process.env.DATASET_OUTPUT_DIR || "./backtest/generated-dataset";
const DRY_RUN = String(process.env.DATASET_DRY_RUN || "").toLowerCase() === "true";
const INCLUDE_INDICATORS = String(process.env.DATASET_INCLUDE_INDICATORS || "true").toLowerCase() !== "false";
const BACKFILL_EXISTING = String(process.env.DATASET_BACKFILL_EXISTING || "").toLowerCase() === "true";
const CONVERT_ONLY = String(process.env.DATASET_CONVERT_ONLY || "").toLowerCase() === "true";
const REQUEST_DELAY_MS = Number.isFinite(Number(process.env.TWELVE_REQUEST_DELAY_MS)) ? Number(process.env.TWELVE_REQUEST_DELAY_MS) : 8500;
const MAX_RETRIES = Number.isFinite(Number(process.env.TWELVE_MAX_RETRIES)) ? Number(process.env.TWELVE_MAX_RETRIES) : 4;
const MAX_CANDLES_PER_REQUEST =
    Number.isFinite(Number(process.env.TWELVE_MAX_CANDLES_PER_REQUEST)) && Number(process.env.TWELVE_MAX_CANDLES_PER_REQUEST) > 0
        ? Number(process.env.TWELVE_MAX_CANDLES_PER_REQUEST)
        : 5000;
const MAX_BACKFILL_CHUNKS_PER_SERIES =
    Number.isFinite(Number(process.env.TWELVE_MAX_BACKFILL_CHUNKS_PER_SERIES)) && Number(process.env.TWELVE_MAX_BACKFILL_CHUNKS_PER_SERIES) > 0
        ? Number(process.env.TWELVE_MAX_BACKFILL_CHUNKS_PER_SERIES)
        : 120;
const MAX_FORWARD_CHUNKS_PER_SERIES =
    Number.isFinite(Number(process.env.TWELVE_MAX_FORWARD_CHUNKS_PER_SERIES)) && Number(process.env.TWELVE_MAX_FORWARD_CHUNKS_PER_SERIES) > 0
        ? Number(process.env.TWELVE_MAX_FORWARD_CHUNKS_PER_SERIES)
        : 40;
const INDICATOR_WARMUP_BARS = Number.isFinite(Number(process.env.DATASET_INDICATOR_WARMUP_BARS)) ? Number(process.env.DATASET_INDICATOR_WARMUP_BARS) : 60;
const INDICATOR_LOOKBACK = Number.isFinite(Number(process.env.DATASET_INDICATOR_LOOKBACK)) ? Number(process.env.DATASET_INDICATOR_LOOKBACK) : 260;
const FILE_FORMAT = String(process.env.DATASET_FILE_FORMAT || "jsonl").toLowerCase() === "json" ? "json" : "jsonl";

const DEFAULT_FX_SYMBOLS = [
    "EUR/USD",
    "GBP/USD",
    "USD/JPY",
    "USD/CHF",
    "USD/CAD",
    "AUD/USD",
    "NZD/USD",
    "EUR/GBP",
    "EUR/JPY",
    "GBP/JPY",
    "AUD/JPY",
    "NZD/JPY",
    "EUR/CHF",
    "GBP/CHF",
    "CAD/JPY",
    "CHF/JPY",
    "EUR/CAD",
    "GBP/CAD",
    "EUR/AUD",
    "EUR/NZD",
    "GBP/AUD",
    "AUD/CAD",
    "AUD/NZD",
    "NZD/CAD",
    "NZD/CHF",
    "AUD/CHF",
];

const DEFAULT_CRYPTO_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "LTC/USD", "BCH/USD", "DOT/USD", "LINK/USD"];

const ALL_TIMEFRAMES = {
    M1: "1min",
    M5: "5min",
    M15: "15min",
    H1: "1h",
    H4: "4h",
    D1: "1day",
};
const DEFAULT_TIMEFRAME_KEYS = ["M1", "M5", "M15", "H1"];

const TIMEFRAME_TO_MINUTES = {
    "1min": 1,
    "5min": 5,
    "15min": 15,
    "1h": 60,
    "4h": 240,
    "1day": 1440,
};

function normalizeSymbol(raw) {
    const value = String(raw || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
    if (!value) return "";
    if (value.includes("/")) return value;
    if (/^[A-Z0-9]{6,8}$/.test(value)) {
        return `${value.slice(0, value.length / 2)}/${value.slice(value.length / 2)}`;
    }
    return value;
}

function parseSymbols() {
    const envSymbols = String(process.env.DATASET_SYMBOLS || "")
        .split(",")
        .map((s) => normalizeSymbol(s))
        .filter(Boolean);
    if (envSymbols.length) return [...new Set(envSymbols)];
    return [...new Set([...DEFAULT_FX_SYMBOLS, ...DEFAULT_CRYPTO_SYMBOLS])];
}

function parseTimeframes() {
    const envFrames = String(process.env.DATASET_TIMEFRAMES || "")
        .split(",")
        .map((f) => String(f || "").trim().toUpperCase())
        .filter(Boolean);
    if (!envFrames.length) {
        const defaults = {};
        for (const key of DEFAULT_TIMEFRAME_KEYS) {
            if (ALL_TIMEFRAMES[key]) defaults[key] = ALL_TIMEFRAMES[key];
        }
        return defaults;
    }
    const selected = {};
    for (const key of envFrames) {
        if (ALL_TIMEFRAMES[key]) selected[key] = ALL_TIMEFRAMES[key];
    }
    if (Object.keys(selected).length) return selected;
    const defaults = {};
    for (const key of DEFAULT_TIMEFRAME_KEYS) {
        if (ALL_TIMEFRAMES[key]) defaults[key] = ALL_TIMEFRAMES[key];
    }
    return defaults;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toApiDate(date) {
    return new Date(date).toISOString().slice(0, 19).replace("T", " ");
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function parseCandleRow(candle) {
    const ts = new Date(candle?.timestamp).toISOString();
    if (!ts) return null;
    const row = {
        timestamp: ts,
        open: toNumber(candle.open),
        high: toNumber(candle.high),
        low: toNumber(candle.low),
        close: toNumber(candle.close),
    };
    if (![row.open, row.high, row.low, row.close].every(Number.isFinite)) return null;
    return row;
}

function mergeCandles(existing, incoming) {
    const map = new Map();
    for (const candle of existing || []) {
        const row = parseCandleRow(candle);
        if (!row) continue;
        map.set(row.timestamp, row);
    }
    for (const candle of incoming || []) {
        const row = parseCandleRow(candle);
        if (!row) continue;
        map.set(row.timestamp, row);
    }
    return [...map.values()]
        .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function readJsonCandles(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return mergeCandles([], parsed);
}

function readJsonlCandles(filePath) {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            rows.push(obj);
        } catch {
            // ignore malformed line
        }
    }
    return mergeCandles([], rows);
}

function fileExt(filePath) {
    return path.extname(filePath).toLowerCase();
}

function loadCandlesFromPath(filePath) {
    const ext = fileExt(filePath);
    if (ext === ".jsonl") return readJsonlCandles(filePath);
    return readJsonCandles(filePath);
}

function buildFilePath(symbol, timeframeName, format = FILE_FORMAT) {
    const symbolKey = symbol.replace("/", "");
    const ext = format === "jsonl" ? "jsonl" : "json";
    return path.join(OUTPUT_DIR, `${symbolKey}_${timeframeName}.${ext}`);
}

function resolveDatasetPaths(symbol, timeframeName) {
    const targetPath = buildFilePath(symbol, timeframeName, FILE_FORMAT);
    const fallbackFormat = FILE_FORMAT === "jsonl" ? "json" : "jsonl";
    const fallbackPath = buildFilePath(symbol, timeframeName, fallbackFormat);
    return { targetPath, fallbackPath };
}

function loadExistingCandles(targetPath, fallbackPath) {
    try {
        if (fs.existsSync(targetPath)) {
            const candles = loadCandlesFromPath(targetPath);
            return { candles, loadedFromPath: targetPath };
        }
        if (fallbackPath && fs.existsSync(fallbackPath)) {
            const candles = loadCandlesFromPath(fallbackPath);
            return { candles, loadedFromPath: fallbackPath };
        }
        return { candles: [], loadedFromPath: null };
    } catch (error) {
        logger.warn(`⚠️ Failed to read existing dataset (${targetPath}${fallbackPath ? ` / ${fallbackPath}` : ""}): ${error.message}`);
        return { candles: [], loadedFromPath: null };
    }
}

async function fetchChunk(symbol, interval, startDate, endDate) {
    const url = new URL(BASE_URL);
    url.searchParams.append("symbol", symbol);
    url.searchParams.append("interval", interval);
    url.searchParams.append("apikey", TWELVEDATA_API_KEY || "");
    url.searchParams.append("start_date", toApiDate(startDate));
    url.searchParams.append("end_date", toApiDate(endDate));
    url.searchParams.append("outputsize", String(MAX_CANDLES_PER_REQUEST));
    url.searchParams.append("order", "asc");
    url.searchParams.append("timezone", "UTC");
    url.searchParams.append("format", "JSON");

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url.toString());
            const payload = await response.json();

            if (payload?.status === "error") {
                const message = payload?.message || "Unknown Twelve Data error";
                if (/no data is available/i.test(message)) {
                    return [];
                }
                const shouldRetry = /limit|rate|credits|thrott/i.test(message);
                if (!shouldRetry || attempt === MAX_RETRIES) {
                    throw new Error(message);
                }
                const retryMs = REQUEST_DELAY_MS * attempt;
                logger.warn(`⏳ ${symbol} ${interval} retry ${attempt}/${MAX_RETRIES} after API limit: ${message}`);
                await wait(retryMs);
                continue;
            }

            const values = Array.isArray(payload?.values) ? payload.values : [];
            const candles = values
                .map((value) => {
                    const timestamp = new Date(`${value?.datetime || ""}Z`).toISOString();
                    return {
                        timestamp,
                        open: toNumber(value?.open),
                        high: toNumber(value?.high),
                        low: toNumber(value?.low),
                        close: toNumber(value?.close),
                    };
                })
                .filter((c) => c.timestamp && [c.open, c.high, c.low, c.close].every(Number.isFinite))
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            return candles;
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            const retryMs = REQUEST_DELAY_MS * attempt;
            logger.warn(`⚠️ ${symbol} ${interval} fetch attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}. Retrying in ${retryMs}ms`);
            await wait(retryMs);
        }
    }

    return [];
}

async function fetchBackfill(symbol, interval, endAt, maxChunks) {
    const intervalMinutes = TIMEFRAME_TO_MINUTES[interval];
    const intervalMs = intervalMinutes * 60 * 1000;
    const chunkSpanMs = intervalMs * MAX_CANDLES_PER_REQUEST;
    let cursorEnd = new Date(endAt);
    let merged = [];
    let previousEarliest = null;

    for (let chunkIndex = 1; chunkIndex <= maxChunks; chunkIndex++) {
        const chunkStart = new Date(cursorEnd.getTime() - chunkSpanMs + intervalMs);
        logger.info(
            `📡 [Backfill ${chunkIndex}/${maxChunks}] ${symbol} ${interval} ${toApiDate(chunkStart)} -> ${toApiDate(cursorEnd)}`,
        );
        const candles = await fetchChunk(symbol, interval, chunkStart, cursorEnd);
        if (!candles.length) {
            logger.info(`ℹ️ [Backfill] ${symbol} ${interval}: no older candles in requested range. Stopping backfill at chunk ${chunkIndex}.`);
            break;
        }
        merged = mergeCandles(merged, candles);
        const earliest = new Date(candles[0].timestamp).getTime();
        if (!Number.isFinite(earliest) || (previousEarliest !== null && earliest >= previousEarliest)) break;
        previousEarliest = earliest;
        cursorEnd = new Date(earliest - intervalMs);
        await wait(REQUEST_DELAY_MS);
    }

    return merged;
}

async function fetchForward(symbol, interval, startAt, endAt, maxChunks) {
    const intervalMinutes = TIMEFRAME_TO_MINUTES[interval];
    const intervalMs = intervalMinutes * 60 * 1000;
    const chunkSpanMs = intervalMs * MAX_CANDLES_PER_REQUEST;
    let cursorStart = new Date(startAt);
    const limitEnd = new Date(endAt);
    let merged = [];
    let previousLatest = null;

    for (let chunkIndex = 1; chunkIndex <= maxChunks && cursorStart <= limitEnd; chunkIndex++) {
        const chunkEnd = new Date(Math.min(cursorStart.getTime() + chunkSpanMs - intervalMs, limitEnd.getTime()));
        logger.info(
            `📡 [Forward ${chunkIndex}/${maxChunks}] ${symbol} ${interval} ${toApiDate(cursorStart)} -> ${toApiDate(chunkEnd)}`,
        );
        const candles = await fetchChunk(symbol, interval, cursorStart, chunkEnd);
        if (!candles.length) {
            logger.info(`ℹ️ [Forward] ${symbol} ${interval}: no newer candles in requested range. Stopping forward sync at chunk ${chunkIndex}.`);
            break;
        }
        merged = mergeCandles(merged, candles);
        const latest = new Date(candles[candles.length - 1].timestamp).getTime();
        if (!Number.isFinite(latest) || (previousLatest !== null && latest <= previousLatest)) break;
        previousLatest = latest;
        cursorStart = new Date(latest + intervalMs);
        await wait(REQUEST_DELAY_MS);
    }

    return merged;
}

async function buildRowsWithIndicators(candles) {
    if (!INCLUDE_INDICATORS) return candles;
    const rows = [];
    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        if (i + 1 < INDICATOR_WARMUP_BARS) {
            rows.push({ ...candle });
            continue;
        }
        const startIndex = Math.max(0, i - INDICATOR_LOOKBACK + 1);
        const slice = candles.slice(startIndex, i + 1);
        const indicators = (await calcIndicators(slice)) || {};
        rows.push({ ...candle, ...indicators });
        if ((i + 1) % 5000 === 0) {
            logger.info(`🧮 Indicator progress ${i + 1}/${candles.length}`);
        }
    }
    return rows;
}

function writeDatasetRows(filePath, rows) {
    const ext = fileExt(filePath);
    if (ext === ".jsonl") {
        const payload = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        fs.writeFileSync(filePath, payload);
        return;
    }
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
}

function printConfig(symbols, timeframes) {
    logger.info("===== Twelve Data Dataset Generation =====");
    logger.info(`Output dir: ${OUTPUT_DIR}`);
    logger.info(`File format: ${FILE_FORMAT}`);
    logger.info(`Symbols: ${symbols.length}`);
    logger.info(`Timeframes: ${Object.keys(timeframes).join(", ")}`);
    logger.info(`Max candles/request: ${MAX_CANDLES_PER_REQUEST}`);
    logger.info(`Request delay: ${REQUEST_DELAY_MS} ms`);
    logger.info(`Backfill chunks/series: ${MAX_BACKFILL_CHUNKS_PER_SERIES}`);
    logger.info(`Forward chunks/series: ${MAX_FORWARD_CHUNKS_PER_SERIES}`);
    logger.info(`Backfill existing files: ${BACKFILL_EXISTING}`);
    logger.info(`Convert only mode: ${CONVERT_ONLY}`);
    logger.info(`Include indicators: ${INCLUDE_INDICATORS}`);
    logger.info(`Dry run: ${DRY_RUN}`);
    logger.info("==========================================");
}

async function generateDataset() {
    if (!DRY_RUN && !CONVERT_ONLY && !TWELVEDATA_API_KEY) {
        throw new Error("Missing TWELVEDATA_API_KEY in environment (.env)");
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const symbols = parseSymbols();
    const timeframes = parseTimeframes();
    printConfig(symbols, timeframes);

    if (DRY_RUN) {
        logger.info("DRY_RUN enabled. No API calls executed.");
        return;
    }

    const now = new Date();

    for (const symbol of symbols) {
        for (const [timeframeName, interval] of Object.entries(timeframes)) {
            try {
                const { targetPath, fallbackPath } = resolveDatasetPaths(symbol, timeframeName);
                const loaded = loadExistingCandles(targetPath, fallbackPath);
                const existing = loaded.candles;
                const loadedFromPath = loaded.loadedFromPath;
                const migratingFormat = Boolean(loadedFromPath && loadedFromPath !== targetPath);
                const intervalMinutes = TIMEFRAME_TO_MINUTES[interval];
                const intervalMs = intervalMinutes * 60 * 1000;

                let older = [];
                let newer = [];

                if (CONVERT_ONLY) {
                    if (!existing.length) {
                        logger.info(`⏭️ ${symbol} ${timeframeName}: no source file found to convert`);
                        continue;
                    }
                    if (!migratingFormat) {
                        logger.info(`⏭️ ${symbol} ${timeframeName}: already in target format (${FILE_FORMAT})`);
                        continue;
                    }
                    logger.info(`🔄 ${symbol} ${timeframeName}: converting ${path.basename(loadedFromPath)} -> ${path.basename(targetPath)}`);
                } else if (existing.length) {
                    const oldestTs = new Date(existing[0].timestamp);
                    const latestTs = new Date(existing[existing.length - 1].timestamp);
                    const olderEnd = new Date(oldestTs.getTime() - intervalMs);
                    const newerStart = new Date(latestTs.getTime() + intervalMs);

                    logger.info(
                        `🔁 ${symbol} ${timeframeName}: existing candles=${existing.length}${migratingFormat ? ` (loaded from ${path.basename(loadedFromPath)})` : ""}`,
                    );
                    if (BACKFILL_EXISTING) {
                        older = await fetchBackfill(symbol, interval, olderEnd, MAX_BACKFILL_CHUNKS_PER_SERIES);
                    } else {
                        logger.info(`⏭️ ${symbol} ${timeframeName}: skipping historical backfill for existing file`);
                    }
                    if (newerStart < now) {
                        newer = await fetchForward(symbol, interval, newerStart, now, MAX_FORWARD_CHUNKS_PER_SERIES);
                    } else {
                        logger.info(`⏭️ ${symbol} ${timeframeName}: up to date (no forward gap)`);
                    }
                } else {
                    logger.info(`🆕 ${symbol} ${timeframeName}: no existing file, starting full backfill`);
                    older = await fetchBackfill(symbol, interval, now, MAX_BACKFILL_CHUNKS_PER_SERIES);
                }

                if (existing.length && !older.length && !newer.length && !migratingFormat) {
                    logger.info(`⏭️ ${symbol} ${timeframeName}: no new candles fetched, keeping existing file unchanged`);
                    continue;
                }

                const merged = mergeCandles(mergeCandles(existing, older), newer);
                if (!merged.length) {
                    logger.warn(`⚠️ No candles for ${symbol} ${timeframeName}`);
                    continue;
                }

                const rows = await buildRowsWithIndicators(merged);
                writeDatasetRows(targetPath, rows);
                logger.info(`💾 ${symbol} ${timeframeName} -> ${targetPath} (${rows.length} rows)`);
            } catch (error) {
                logger.error(`❌ ${symbol} ${timeframeName}: ${error.message}`);
            }
        }
    }

    logger.info("✅ Twelve Data dataset generation completed.");
}

generateDataset().catch((error) => {
    logger.error(`Dataset generation failed: ${error.message}`);
    process.exitCode = 1;
});
