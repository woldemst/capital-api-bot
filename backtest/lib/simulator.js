import { LOOKAHEAD_CANDLES, getSessionInfo, trendOpposite } from "./helpers.js";

function isTrendAligned(trade) {
    const dir = trade.direction;
    const m15Trend = trade.indicatorsAtEntry?.m15?.trend;
    const h1Trend = trade.indicatorsAtEntry?.h1?.trend;
    if (!m15Trend || !h1Trend) return false;
    const bullish = dir === "BUY";
    return (
        (bullish && m15Trend === "bullish" && h1Trend === "bullish") ||
        (!bullish && m15Trend === "bearish" && h1Trend === "bearish")
    );
}

function passesFilters(trade, config) {
    if (config.trendAlignment && !isTrendAligned(trade)) {
        return { pass: false, reason: "trend_alignment" };
    }

    if (config.atrGate?.mode && config.atrGate.mode !== "off") {
        const scope = config.atrGate.scope?.toLowerCase() || "h1";
        const ctx = trade.indicatorsAtEntry?.[scope];
        const atr = ctx?.atr;
        if (typeof atr !== "number") {
            return { pass: false, reason: "atr_missing" };
        }
        const atrPips = atr / trade.pipSize;
        if (config.atrGate.mode === "min" && atrPips < (config.atrGate.minPips || 0)) {
            return { pass: false, reason: "atr_min" };
        }
        if (config.atrGate.mode === "band") {
            const min = config.atrGate.minPips || 0;
            const max = config.atrGate.maxPips || Infinity;
            if (atrPips < min || atrPips > max) {
                return { pass: false, reason: "atr_band" };
            }
        }
    }

    if (config.rsiGate?.mode && config.rsiGate.mode !== "off") {
        const scope = config.rsiGate.scope?.toLowerCase() || "h1";
        const ctx = trade.indicatorsAtEntry?.[scope];
        const rsi = ctx?.rsi;
        if (typeof rsi !== "number") {
            return { pass: false, reason: "rsi_missing" };
        }
        const longRange = config.rsiGate.longRange || [0, 100];
        const shortRange = config.rsiGate.shortRange || [0, 100];
        if (trade.direction === "BUY") {
            if (rsi < longRange[0] || rsi > longRange[1]) {
                return { pass: false, reason: "rsi_long" };
            }
        } else {
            if (rsi < shortRange[0] || rsi > shortRange[1]) {
                return { pass: false, reason: "rsi_short" };
            }
        }
    }

    return { pass: true };
}

function shouldSoftExit(trade, config, frame, offset) {
    if (!config.softExit || config.softExit === "off") return false;
    if (offset < (config.softExitWarmup ?? 0)) return false;
    if (!frame) return false;

    const oppM15 = trendOpposite(trade.direction, frame.m15?.trend);
    const oppH1 = trendOpposite(trade.direction, frame.h1?.trend);
    const macdFlipM15 = frame.m15?.macdHist != null ? (trade.direction === "BUY" ? frame.m15.macdHist < 0 : frame.m15.macdHist > 0) : false;
    const macdFlipH1 = frame.h1?.macdHist != null ? (trade.direction === "BUY" ? frame.h1.macdHist < 0 : frame.h1.macdHist > 0) : false;
    const rsiFlipM15 = frame.m15?.rsi != null ? (trade.direction === "BUY" ? frame.m15.rsi < 45 : frame.m15.rsi > 55) : false;
    const rsiFlipH1 = frame.h1?.rsi != null ? (trade.direction === "BUY" ? frame.h1.rsi < 45 : frame.h1.rsi > 55) : false;

    switch (config.softExit) {
        case "conservative":
            return oppM15 && oppH1;
        case "standard":
            return oppM15 || oppH1;
        case "aggressive":
            return oppM15 || oppH1 || macdFlipM15 || macdFlipH1 || rsiFlipM15 || rsiFlipH1;
        default:
            return false;
    }
}

function evaluatePostExit(trade, config, m5Records, startIdx, limitIdx) {
    for (let idx = startIdx; idx <= limitIdx && idx < m5Records.length; idx++) {
        const candle = m5Records[idx]?.candle;
        if (!candle) continue;
        if (trade.direction === "BUY") {
            if (candle.low <= trade.stopLoss) return "SL";
            const target = trade.entryPrice + trade.slDistance * config.riskReward;
            if (candle.high >= target) return "TP";
        } else {
            if (candle.high >= trade.stopLoss) return "SL";
            const target = trade.entryPrice - trade.slDistance * config.riskReward;
            if (candle.low <= target) return "TP";
        }
    }
    return null;
}

function calcDurationMinutes(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
    return Number(((endDate - startDate) / 60000).toFixed(2));
}

function simulateTrade(trade, config, m5Records) {
    const entryFrame = m5Records[trade.entryIdx];
    if (!entryFrame) return null;
    const directionFactor = trade.direction === "BUY" ? 1 : -1;
    const target = trade.entryPrice + directionFactor * (trade.slDistance * config.riskReward);

    let maxAdverse = 0;
    let maxFavorable = 0;
    let exitReason = null;
    let exitPrice = null;
    let exitIdx = null;

    const maxCandles = config.maxCandles || LOOKAHEAD_CANDLES;
    const lastIdxAllowed = Math.min(m5Records.length - 1, trade.entryIdx + maxCandles);

    for (let offset = 1; trade.entryIdx + offset <= lastIdxAllowed; offset++) {
        const idx = trade.entryIdx + offset;
        const frame = m5Records[idx];
        if (!frame?.candle) continue;
        const candle = frame.candle;

        if (trade.direction === "BUY") {
            const adverse = trade.entryPrice - candle.low;
            if (adverse > maxAdverse) maxAdverse = adverse;
            const favorable = candle.high - trade.entryPrice;
            if (favorable > maxFavorable) maxFavorable = favorable;
            if (candle.low <= trade.stopLoss) {
                exitReason = "hard_sl";
                exitPrice = trade.stopLoss;
                exitIdx = idx;
                break;
            }
            if (candle.high >= target) {
                exitReason = "hard_tp";
                exitPrice = target;
                exitIdx = idx;
                break;
            }
        } else {
            const adverse = candle.high - trade.entryPrice;
            if (adverse > maxAdverse) maxAdverse = adverse;
            const favorable = trade.entryPrice - candle.low;
            if (favorable > maxFavorable) maxFavorable = favorable;
            if (candle.high >= trade.stopLoss) {
                exitReason = "hard_sl";
                exitPrice = trade.stopLoss;
                exitIdx = idx;
                break;
            }
            if (candle.low <= target) {
                exitReason = "hard_tp";
                exitPrice = target;
                exitIdx = idx;
                break;
            }
        }

        if (shouldSoftExit(trade, config, frame, offset)) {
            exitReason = "soft_exit";
            exitPrice = candle.close;
            exitIdx = idx;
            break;
        }
    }

    if (!exitReason) {
        exitIdx = lastIdxAllowed;
        const fallbackFrame = m5Records[exitIdx];
        exitReason = "close_fn";
        exitPrice = fallbackFrame?.candle?.close ?? trade.entryPrice;
    }

    const exitFrame = m5Records[exitIdx];
    const exitTime = exitFrame?.timestamp || trade.entryTime;

    const profit = directionFactor * (exitPrice - trade.entryPrice);
    const rMultiple = trade.slDistance ? profit / trade.slDistance : 0;
    const profitPips = trade.pipSize ? profit / trade.pipSize : 0;
    const mae = trade.pipSize ? maxAdverse / trade.pipSize : null;
    const mfe = trade.pipSize ? maxFavorable / trade.pipSize : null;

    let softExitSaved = false;
    let postExitOutcome = null;
    if (exitReason === "soft_exit") {
        postExitOutcome = evaluatePostExit(trade, config, m5Records, exitIdx + 1, lastIdxAllowed);
        softExitSaved = postExitOutcome === "SL";
    }

    return {
        tradeId: trade.id,
        symbol: trade.pair,
        direction: trade.direction,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: target,
        pipSize: trade.pipSize,
        exitPrice,
        exitTime,
        exitReason,
        rMultiple,
        profitPips,
        mae,
        mfe,
        heat: mae,
        durationMinutes: calcDurationMinutes(trade.entryTime, exitTime),
        m5Prev: trade.m5Prev,
        m5Last: trade.m5Last,
        entryM15: trade.indicatorsAtEntry?.m15 || null,
        entryH1: trade.indicatorsAtEntry?.h1 || null,
        closeM5: exitFrame?.candle || null,
        closeM15: exitFrame?.m15 || null,
        closeH1: exitFrame?.h1 || null,
        riskRewardAtOpen: config.riskReward,
        softExitSaved,
        softExitOutcome: postExitOutcome,
    };
}

export class MetricsAccumulator {
    constructor() {
        this.count = 0;
        this.wins = 0;
        this.losses = 0;
        this.grossProfit = 0;
        this.grossLoss = 0;
        this.sumR = 0;
        this.rValues = [];
        this.maeValues = [];
        this.mfeValues = [];
        this.equity = [0];
        this.softExitCount = 0;
        this.softExitSaved = 0;
        this.sessionCounts = {};
        this.hourCounts = {};
        this.weekdayCounts = {};
    }

    add(trade) {
        this.count++;
        const r = trade.rMultiple ?? 0;
        this.sumR += r;
        this.rValues.push(r);
        const prevEquity = this.equity[this.equity.length - 1];
        this.equity.push(prevEquity + r);
        if (r > 0) {
            this.wins++;
            this.grossProfit += r;
        } else if (r < 0) {
            this.losses++;
            this.grossLoss += r;
        }
        if (typeof trade.mae === "number") this.maeValues.push(trade.mae);
        if (typeof trade.mfe === "number") this.mfeValues.push(trade.mfe);
        if (trade.exitReason === "soft_exit") {
            this.softExitCount++;
            if (trade.softExitSaved) this.softExitSaved++;
        }
        const sessionInfo = getSessionInfo(trade.entryTime);
        const session = sessionInfo.session;
        const hour = sessionInfo.hour;
        const weekday = sessionInfo.weekday;
        if (session) this.sessionCounts[session] = (this.sessionCounts[session] || 0) + 1;
        if (hour != null) this.hourCounts[hour] = (this.hourCounts[hour] || 0) + 1;
        if (weekday != null) this.weekdayCounts[weekday] = (this.weekdayCounts[weekday] || 0) + 1;
    }

    median(values) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
        }
        return Number(sorted[mid].toFixed(2));
    }

    calcDrawdown() {
        let peak = this.equity[0];
        let maxDrop = 0;
        let maxDropPct = 0;
        for (const value of this.equity) {
            if (value > peak) {
                peak = value;
                continue;
            }
            const drop = peak - value;
            if (drop > maxDrop) {
                maxDrop = drop;
                maxDropPct = peak !== 0 ? (drop / Math.max(Math.abs(peak), 1)) * 100 : 0;
            }
        }
        return { absolute: Number(maxDrop.toFixed(2)), percent: Number(maxDropPct.toFixed(2)) };
    }

    stdDev(values) {
        if (values.length < 2) return null;
        const mean = this.sumR / this.count;
        const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (values.length - 1);
        return Math.sqrt(variance);
    }

    finalize() {
        const winRate = this.count ? (this.wins / this.count) * 100 : 0;
        const profitFactor = this.grossLoss < 0 ? this.grossProfit / Math.abs(this.grossLoss) : null;
        const expectancy = this.count ? this.sumR / this.count : 0;
        const avgR = expectancy;
        const drawdown = this.calcDrawdown();
        const std = this.stdDev(this.rValues);
        const sharpe = std ? (expectancy / std) * Math.sqrt(this.count) : null;
        return {
            trades: this.count,
            wins: this.wins,
            losses: this.losses,
            winRate: Number(winRate.toFixed(2)),
            profitFactor: profitFactor != null ? Number(profitFactor.toFixed(2)) : null,
            expectancy: Number(expectancy.toFixed(2)),
            avgR: Number(avgR.toFixed(2)),
            maxDrawdown: drawdown,
            sharpe: sharpe != null ? Number(sharpe.toFixed(2)) : null,
            medianMAE: this.median(this.maeValues),
            medianMFE: this.median(this.mfeValues),
            softExitSaveRate: this.softExitCount ? Number(((this.softExitSaved / this.softExitCount) * 100).toFixed(2)) : null,
            sessionDistribution: this.sessionCounts,
            hourDistribution: this.hourCounts,
            weekdayDistribution: this.weekdayCounts,
            netR: Number(this.sumR.toFixed(2)),
            grossProfit: Number(this.grossProfit.toFixed(2)),
            grossLoss: Number(this.grossLoss.toFixed(2)),
        };
    }
}

export function runSimulationForPair(pairData, config, { collectTrades = false } = {}) {
    const rejections = {};
    const takenTrades = [];
    const metrics = new MetricsAccumulator();

    for (const trade of pairData.trades) {
        const filter = passesFilters(trade, config);
        if (!filter.pass) {
            const key = filter.reason || "filtered";
            rejections[key] = (rejections[key] || 0) + 1;
            continue;
        }
        const result = simulateTrade(trade, config, pairData.m5Records);
        if (!result) continue;
        metrics.add(result);
        if (collectTrades) {
            takenTrades.push(result);
        }
    }

    return {
        pair: pairData.pair,
        configId: config.id,
        metrics: metrics.finalize(),
        rejections,
        trades: collectTrades ? takenTrades : null,
    };
}
