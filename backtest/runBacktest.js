import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import Strategy from "../strategies/strategies.js";
import logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ANALYSIS_DIR = path.join(__dirname, "analysis");
const RESULTS_DIR = path.join(__dirname, "results");
const M5_BUFFER_SIZE = 10;

const FEATURE_SELECTORS = {
    m5RSI: (snap) => snap.m5?.rsi,
    m5BBpb: (snap) => snap.m5?.bbpb,
    m5ADX: (snap) => snap.m5?.adx,
    m15ADX: (snap) => snap.m15?.adx,
    h1ADX: (snap) => snap.h1?.adx,
    h1RSI: (snap) => snap.h1?.rsi,
};

const createFeatureStats = () =>
    Object.fromEntries(
        Object.keys(FEATURE_SELECTORS).map((key) => [
            key,
            { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, sum: 0, count: 0 },
        ])
    );

function recordFeature(featureStats, key, value) {
    if (value == null || Number.isNaN(value)) return;
    const bucket = featureStats[key];
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    bucket.sum += value;
    bucket.count += 1;
}

function finalizeFeatureStats(featureStats) {
    return Object.fromEntries(
        Object.entries(featureStats).map(([key, bucket]) => {
            if (!bucket.count) {
                return [key, { min: null, max: null, avg: null }];
            }
            return [key, { min: bucket.min, max: bucket.max, avg: bucket.sum / bucket.count }];
        })
    );
}

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const detectPairs = () => {
    const cliPairs = process.argv.slice(2).map((p) => p.trim().toUpperCase()).filter(Boolean);
    if (cliPairs.length) return cliPairs;
    if (!fs.existsSync(ANALYSIS_DIR)) return [];
    const files = fs.readdirSync(ANALYSIS_DIR).filter((name) => name.endsWith("_combined.jsonl"));
    return files.map((file) => file.replace("_combined.jsonl", ""));
};

const getTimestamp = (data) => data.time || data.M1?.timestamp || data.M5?.timestamp || data.M15?.timestamp || data.H1?.timestamp;

const pickFrame = (frame) => {
    if (!frame) return null;
    return {
        ema20: frame.ema20 ?? null,
        ema50: frame.ema50 ?? null,
        rsi: frame.rsi ?? null,
        adx: frame.adx?.adx ?? null,
        bbpb: frame.bb?.pb ?? null,
        atr: frame.atr ?? null,
    };
};

const buildIndicatorSnapshot = (indicators) => ({
    m1: pickFrame(indicators.m1),
    m5: pickFrame(indicators.m5),
    m15: pickFrame(indicators.m15),
    h1: pickFrame(indicators.h1),
    h4: pickFrame(indicators.h4),
});

const closeStream = (stream) =>
    new Promise((resolve, reject) => {
        stream.end(() => resolve());
        stream.on("error", reject);
    });

async function runBacktestForPair(pair) {
    const inputFile = path.join(ANALYSIS_DIR, `${pair}_combined.jsonl`);
    if (!fs.existsSync(inputFile)) {
        logger.warn(`[Backtest] No merged dataset for ${pair} (${inputFile}), skipping.`);
        return null;
    }

    ensureDir(RESULTS_DIR);

    const signalsFile = path.join(RESULTS_DIR, `${pair}_backtest_results.jsonl`);
    const decisionsFile = path.join(RESULTS_DIR, `${pair}_decision_log.jsonl`);
    const summaryFile = path.join(RESULTS_DIR, `${pair}_backtest_summary.json`);

    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const signalStream = fs.createWriteStream(signalsFile, { flags: "w" });
    const decisionStream = fs.createWriteStream(decisionsFile, { flags: "w" });

    const stats = {
        pair,
        processed: 0,
        signals: 0,
        signalBreakdown: { BUY: 0, SELL: 0 },
        rejectionReasons: {},
        featureStats: createFeatureStats(),
    };

    const m5Buffer = [];

    for await (const line of rl) {
        if (!line.trim()) continue;
        let data;
        try {
            data = JSON.parse(line);
        } catch (err) {
            logger.error(`[Backtest] Failed to parse line for ${pair}: ${err.message}`);
            continue;
        }

        if (data.M5) {
            m5Buffer.push(data.M5);
            if (m5Buffer.length > M5_BUFFER_SIZE) {
                m5Buffer.shift();
            }
        }

        const indicators = { m1: data.M1, m5: data.M5, m15: data.M15, h1: data.H1, h4: data.H4 };
        const candles = {
            m5Candles: m5Buffer.slice(),
            m15Candles: [data.M15].filter(Boolean),
            h1Candles: [data.H1].filter(Boolean),
            m1Candles: [data.M1].filter(Boolean),
        };

        const decision = Strategy.getSignal({ symbol: pair, indicators, candles }) || { signal: null, reason: "no_decision" };
        const indicatorSnapshot = buildIndicatorSnapshot(indicators);
        const timestamp = getTimestamp(data);
        const tookTrade = Boolean(decision.signal);
        const context = decision.context && !decision.context.trend ? decision.context : undefined;
        const trendContext = decision.context?.trend;

        const decisionRecord = {
            time: timestamp,
            tookTrade,
            signal: decision.signal,
            reason: decision.reason,
            trend: trendContext,
            indicators: indicatorSnapshot,
            ...(context ? { context } : {}),
        };

        decisionStream.write(JSON.stringify(decisionRecord) + "\n");

        stats.processed += 1;

        if (tookTrade) {
            stats.signals += 1;
            if (stats.signalBreakdown[decision.signal] != null) {
                stats.signalBreakdown[decision.signal] += 1;
            }

            Object.entries(FEATURE_SELECTORS).forEach(([key, selector]) => {
                const value = selector(indicatorSnapshot);
                recordFeature(stats.featureStats, key, value);
            });

            signalStream.write(
                JSON.stringify({
                    time: timestamp,
                    signal: decision.signal,
                    reason: decision.reason,
                    indicators: indicatorSnapshot,
                    ...(context ? { context } : {}),
                }) + "\n"
            );
        } else {
            const reasonKey = decision.reason || "unknown";
            stats.rejectionReasons[reasonKey] = (stats.rejectionReasons[reasonKey] || 0) + 1;
        }
    }

    await closeStream(signalStream);
    await closeStream(decisionStream);

    const summaryPayload = {
        pair,
        processed: stats.processed,
        signals: stats.signals,
        conversionRate: stats.processed ? +(stats.signals / stats.processed).toFixed(4) : 0,
        signalBreakdown: stats.signalBreakdown,
        rejectionReasons: stats.rejectionReasons,
        featureStats: finalizeFeatureStats(stats.featureStats),
        files: {
            signalsFile: path.relative(process.cwd(), signalsFile),
            decisionsFile: path.relative(process.cwd(), decisionsFile),
        },
    };

    fs.writeFileSync(summaryFile, JSON.stringify(summaryPayload, null, 2));
    logger.info(
        `[Backtest] ${pair}: processed ${stats.processed} candles, ${stats.signals} signals → ${path.relative(process.cwd(), signalsFile)}`
    );

    return summaryPayload;
}

async function runBacktests() {
    ensureDir(RESULTS_DIR);
    const pairs = detectPairs();
    if (!pairs.length) {
        logger.error("[Backtest] No pairs found. Provide symbols via CLI args or generate merged datasets in backtest/analysis.");
        return;
    }

    const summaries = [];
    for (const pair of pairs) {
        const summary = await runBacktestForPair(pair);
        if (summary) summaries.push(summary);
    }

    if (summaries.length) {
        logger.info(
            `[Backtest] Completed ${summaries.length} pair(s). Latest summary: ${path.relative(process.cwd(), summaries.at(-1).files.signalsFile)}`
        );
    }
}

runBacktests().catch((err) => {
    logger.error(`[Backtest] Failed: ${err.stack || err.message}`);
    process.exitCode = 1;
});
