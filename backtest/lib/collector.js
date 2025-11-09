import fs from "fs";
import path from "path";
import readline from "readline";
import Strategy from "../../strategies/strategies.js";
import { calcIndicators } from "../../indicators.js";
import tradingService from "../../services/trading.js";
import logger from "../../utils/logger.js";
import { extractFrameContext, getPipSize, pushUnique, MIN_BARS } from "./helpers.js";

export async function collectPairData(pair, { analysisDir = path.join("backtest", "analysis"), startingBalance = 10000 } = {}) {
    const inputPath = path.join(analysisDir, `${pair}_combined.jsonl`);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Missing input file for ${pair}: ${inputPath}`);
    }

    tradingService.setAccountBalance(startingBalance);

    const fileStream = fs.createReadStream(inputPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const m5Buffer = [];
    const m15Buffer = [];
    const h1Buffer = [];
    const h4Buffer = [];

    const indicatorCache = { m5: null, m15: null, h1: null, h4: null };
    const rejectionReasons = {};
    const directionCounts = { BUY: 0, SELL: 0 };

    const m5Records = [];
    const trades = [];
    let processedCandles = 0;
    let tradeIdx = 0;

    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let data;
        try {
            data = JSON.parse(line);
        } catch (error) {
            logger.warn(`[Collector] Failed to parse line for ${pair}: ${error.message}`);
            continue;
        }

        const m5Updated = pushUnique(m5Buffer, data.M5);
        const m15Updated = pushUnique(m15Buffer, data.M15);
        const h1Updated = pushUnique(h1Buffer, data.H1);
        const h4Updated = pushUnique(h4Buffer, data.H4);

        if (!m5Updated) {
            continue;
        }

        processedCandles++;

        if (
            m5Buffer.length < MIN_BARS ||
            m15Buffer.length < MIN_BARS ||
            h1Buffer.length < MIN_BARS ||
            h4Buffer.length < MIN_BARS
        ) {
            continue;
        }

        try {
            if (m5Updated) indicatorCache.m5 = await calcIndicators(m5Buffer);
            if (m15Updated || !indicatorCache.m15) indicatorCache.m15 = await calcIndicators(m15Buffer);
            if (h1Updated || !indicatorCache.h1) indicatorCache.h1 = await calcIndicators(h1Buffer);
            if (h4Updated || !indicatorCache.h4) indicatorCache.h4 = await calcIndicators(h4Buffer);
        } catch (error) {
            logger.warn(`[Collector] Indicator calc failed for ${pair}: ${error.message}`);
            continue;
        }

        if (!indicatorCache.m5 || !indicatorCache.m15 || !indicatorCache.h1 || !indicatorCache.h4) {
            continue;
        }

        const m5Context = extractFrameContext(indicatorCache.m5);
        const m15Context = extractFrameContext(indicatorCache.m15);
        const h1Context = extractFrameContext(indicatorCache.h1);

        const record = {
            timestamp: data.M5.timestamp,
            candle: data.M5,
            m5: m5Context,
            m15: m15Context,
            h1: h1Context,
        };
        const entryIdx = m5Records.push(record) - 1;

        const indicators = {
            m5: indicatorCache.m5,
            m15: indicatorCache.m15,
            h1: indicatorCache.h1,
            h4: indicatorCache.h4,
        };

        const candles = {
            m5Candles: m5Buffer.slice(),
            m15Candles: m15Buffer.slice(),
            h1Candles: h1Buffer.slice(),
            h4Candles: h4Buffer.slice(),
            m1Candles: data.M1 ? [data.M1] : [],
        };

        const { signal, reason, context } = Strategy.getSignal({ symbol: pair, indicators, candles });
        if (!signal) {
            const rejKey = reason || "no_signal";
            rejectionReasons[rejKey] = (rejectionReasons[rejKey] || 0) + 1;
            continue;
        }

        const entryCandle = candles.m5Candles[candles.m5Candles.length - 1];
        if (!entryCandle?.timestamp) {
            rejectionReasons.missing_entry_timestamp = (rejectionReasons.missing_entry_timestamp || 0) + 1;
            continue;
        }

        const prevCandle = candles.m5Candles[candles.m5Candles.length - 2] ?? null;
        directionCounts[signal] = (directionCounts[signal] || 0) + 1;

        const price = entryCandle.close;
        const pipSize = getPipSize(pair);
        const bid = price;
        const ask = price;

        let params;
        try {
            params = await tradingService.calculateTradeParameters(signal, pair, bid, ask, candles, context);
        } catch (error) {
            logger.warn(`[Collector] Param calc failed for ${pair}: ${error.message}`);
            rejectionReasons.param_calc_failed = (rejectionReasons.param_calc_failed || 0) + 1;
            continue;
        }

        const slDistance = Math.abs(params.price - params.stopLossPrice);
        if (!slDistance || !Number.isFinite(slDistance)) {
            rejectionReasons.bad_sl_distance = (rejectionReasons.bad_sl_distance || 0) + 1;
            continue;
        }

        const tpDistance = Math.abs(params.takeProfitPrice - params.price);
        const rr = slDistance ? tpDistance / slDistance : 0;

        const trade = {
            id: `${pair}-${entryCandle.timestamp}-${tradeIdx}`,
            pair,
            direction: signal,
            entryIdx,
            entryTime: entryCandle.timestamp,
            entryPrice: params.price,
            stopLoss: params.stopLossPrice,
            takeProfit: params.takeProfitPrice,
            slDistance,
            baseRR: Number(rr.toFixed(2)),
            context,
            indicatorsAtEntry: {
                m5: m5Context,
                m15: m15Context,
                h1: h1Context,
            },
            m5Prev: prevCandle,
            m5Last: entryCandle,
            reason,
            pipSize,
            riskReward: Number(rr.toFixed(2)),
        };

        trades.push(trade);
        tradeIdx++;
    }

    return {
        pair,
        trades,
        m5Records,
        stats: {
            processedCandles,
            trades: trades.length,
            rejectionReasons,
            directionCounts,
        },
    };
}
