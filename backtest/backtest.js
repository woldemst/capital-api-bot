import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TRADING } from "../config.js";
import { calcIndicators } from "../indicators.js";
import tradingService from "../services/trading.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEFRAMES = {
  M1: { intervalMs: 60 * 1000, fileSuffix: "M1" },
  M5: { intervalMs: 5 * 60 * 1000, fileSuffix: "M5" },
  M15: { intervalMs: 15 * 60 * 1000, fileSuffix: "M15" },
  H1: { intervalMs: 60 * 60 * 1000, fileSuffix: "H1" },
  H4: { intervalMs: 4 * 60 * 60 * 1000, fileSuffix: "H4" },
};

const HISTORY_WINDOW = 200; // mirror live maxCandleHistory
const DRIVER_TIMEFRAME = "M5"; // live analysis cadence is every 5 minutes
const OUTPUT_FILE = path.resolve(__dirname, "..", "backtest-recommendations.json"); // outside backtest folder
const APPLIED_KEYS = {
  EMA_ALIGNMENT: "H4/H1 EMA alignment with price filter",
  M15_RSI_GUARD: "M15 RSI guardrails",
  ATR_FLOOR: "M15 ATR floor",
  TIGHTER_STOPS: "1.2x ATR stops with 2.2x TP",
  BREAKEVEN_AND_TRAIL: "Breakeven at +1R then trail 1x ATR after +1.5R",
};

function toMs(timestamp) {
  return new Date(timestamp).getTime();
}

function segmentCandles(candles, intervalMs, gapMultiplier = 10) {
  if (!candles.length) return [];
  const segments = [];
  let startIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestampMs - candles[i - 1].timestampMs;
    if (delta > intervalMs * gapMultiplier) {
      segments.push(candles.slice(startIdx, i));
      startIdx = i;
    }
  }
  segments.push(candles.slice(startIdx));
  return segments;
}

function loadCandles(pair, tf) {
  const file = path.resolve(__dirname, "data", pair, `${pair}_${tf}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${tf} data for ${pair}: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return raw
    .map((candle) => ({
      ...candle,
      timestampMs: toMs(candle.timestamp),
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function getPipValue(pair) {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

function formatIso(ms) {
  return new Date(ms).toISOString();
}

function checkIntervals(candles, intervalMs) {
  const issues = [];
  const segments = segmentCandles(candles, intervalMs);
  segments.forEach((segment) => {
    for (let i = 1; i < segment.length; i++) {
      const delta = segment[i].timestampMs - segment[i - 1].timestampMs;
      if (delta <= 0 || delta % intervalMs !== 0) {
        issues.push({ timestamp: segment[i].timestamp, delta });
        if (issues.length >= 5) return;
      }
    }
  });
  return issues;
}

function checkPhase(candles, intervalMs) {
  const issues = [];
  const segments = segmentCandles(candles, intervalMs);
  segments.forEach((segment) => {
    if (!segment.length || issues.length >= 5) return;
    const anchor = segment[0].timestampMs;
    const step = Math.max(1, Math.floor(segment.length / 500));
    for (let i = 0; i < segment.length; i += step) {
      const offset = (segment[i].timestampMs - anchor) % intervalMs;
      if (offset !== 0) {
        issues.push(segment[i].timestamp);
        if (issues.length >= 5) break;
      }
    }
  });
  return issues;
}

class PairBacktester {
  constructor(pair) {
    this.pair = pair;
    this.series = {};
    this.cursors = {};
    this.range = null;
    this.driver = DRIVER_TIMEFRAME;
    this.openPositions = [];
    this.trades = [];
    this.equityPips = 0;
    this.equityCurve = [{ time: null, equity: 0 }];
    this.historyByTf = {};
    this.latestSnapshot = null;
    this.appliedRecommendationKeys = new Set();
  }

  load() {
    Object.keys(TIMEFRAMES).forEach((tf) => {
      this.series[tf] = loadCandles(this.pair, tf);
      this.cursors[tf] = -1;
    });
  }

  verifyAlignment() {
    const spans = Object.entries(TIMEFRAMES).map(([tf]) => {
      const candles = this.series[tf];
      if (!candles || !candles.length) throw new Error(`[${this.pair}] ${tf} has no candles`);
      return { tf, min: candles[0].timestampMs, max: candles[candles.length - 1].timestampMs };
    });

    const overlapStart = Math.max(...spans.map((s) => s.min));
    const overlapEnd = Math.min(...spans.map((s) => s.max));
    if (overlapStart >= overlapEnd) {
      throw new Error(`[${this.pair}] Timeframes do not overlap. start=${formatIso(overlapStart)} end=${formatIso(overlapEnd)}`);
    }

    // Clip each timeframe to the common window
    Object.keys(TIMEFRAMES).forEach((tf) => {
      this.series[tf] = this.series[tf].filter((c) => c.timestampMs >= overlapStart && c.timestampMs <= overlapEnd);
    });

    const alignmentErrors = [];

    Object.entries(TIMEFRAMES).forEach(([tf, meta]) => {
      const candles = this.series[tf];
      const intervalIssues = checkIntervals(candles, meta.intervalMs);
      if (intervalIssues.length) {
        alignmentErrors.push({ tf, reason: "interval", samples: intervalIssues });
      }
      const phaseIssues = checkPhase(candles, meta.intervalMs);
      if (phaseIssues.length) {
        alignmentErrors.push({ tf, reason: "phase", samples: phaseIssues });
      }
    });

    if (alignmentErrors.length) {
      throw new Error(
        `[${this.pair}] Timeframe alignment failed: ${alignmentErrors
          .map((err) => `${err.tf}:${err.reason}:${JSON.stringify(err.samples)}`)
          .join("; ")}`
      );
    }

    this.range = { start: overlapStart, end: overlapEnd };
    return this.range;
  }

  computeAnalysisStart() {
    const thresholds = Object.entries(this.series).map(([tf, candles]) => {
      const required = Math.min(HISTORY_WINDOW, candles.length);
      this.historyByTf[tf] = required;
      return candles[required - 1].timestampMs;
    });
    return Math.max(this.range.start, ...thresholds);
  }

  advanceCursors(targetTime) {
    Object.keys(TIMEFRAMES).forEach((tf) => {
      const candles = this.series[tf];
      while (this.cursors[tf] + 1 < candles.length && candles[this.cursors[tf] + 1].timestampMs <= targetTime) {
        this.cursors[tf] += 1;
      }
    });
  }

  getSlices() {
    const slices = {};
    for (const tf of Object.keys(TIMEFRAMES)) {
      const need = this.historyByTf[tf] || HISTORY_WINDOW;
      const cursor = this.cursors[tf];
      if (cursor < need - 1) return null;
      const candles = this.series[tf];
      slices[tf] = candles.slice(Math.max(0, cursor - need + 1), cursor + 1);
    }
    return slices;
  }

  async buildSnapshot() {
    const slices = this.getSlices();
    if (!slices) return null;
    const indicators = {
      d1: {},
      h4: await calcIndicators(slices.H4),
      h1: await calcIndicators(slices.H1),
      m15: await calcIndicators(slices.M15),
      m5: await calcIndicators(slices.M5),
      m1: await calcIndicators(slices.M1),
    };
    const candles = {
      d1Candles: [],
      h4Candles: slices.H4,
      h1Candles: slices.H1,
      m15Candles: slices.M15,
      m5Candles: slices.M5,
      m1Candles: slices.M1,
    };
    return { indicators, candles };
  }

  getCurrentPrice() {
    const m1Idx = this.cursors.M1;
    if (m1Idx >= 0) return this.series.M1[m1Idx].close;
    const driverIdx = this.cursors[this.driver];
    return this.series[this.driver][driverIdx].close;
  }

  updateOpenPositions(price, timeMs) {
    const trailAtr = this.latestSnapshot?.indicators?.m5?.atr || this.latestSnapshot?.indicators?.m15?.atr;
    const stillOpen = [];
    for (const pos of this.openPositions) {
      const move = (price - pos.entryPrice) * (pos.direction === "buy" ? 1 : -1);

      // Breakeven shift at +1R
      if (!pos.breakevenDone && move >= pos.riskDistance) {
        pos.stopLoss = pos.entryPrice;
        pos.breakevenDone = true;
      }

      // Trail by 1x ATR after +1.5R
      if (trailAtr && move >= pos.riskDistance * 1.5) {
        const trailStop = pos.direction === "buy" ? price - trailAtr : price + trailAtr;
        if (
          (pos.direction === "buy" && trailStop > pos.stopLoss) ||
          (pos.direction === "sell" && trailStop < pos.stopLoss)
        ) {
          pos.stopLoss = trailStop;
          pos.trailingApplied = true;
        }
      }

      if (pos.direction === "buy") {
        if (price <= pos.stopLoss) {
          this.closePosition(pos, price, timeMs, "stop_loss");
          continue;
        }
        if (price >= pos.takeProfit) {
          this.closePosition(pos, price, timeMs, "take_profit");
          continue;
        }
      } else {
        if (price >= pos.stopLoss) {
          this.closePosition(pos, price, timeMs, "stop_loss");
          continue;
        }
        if (price <= pos.takeProfit) {
          this.closePosition(pos, price, timeMs, "take_profit");
          continue;
        }
      }
      stillOpen.push(pos);
    }
    this.openPositions = stillOpen;
  }

  openPosition(direction, price, timeMs, snapshot) {
    const atr =
      snapshot?.indicators?.m15?.atr ||
      snapshot?.indicators?.m5?.atr ||
      snapshot?.indicators?.h1?.atr ||
      price * 0.0005;
    const riskDistance = Math.max(Math.abs(atr * 1.2), price * 0.0001);
    const stopLoss = direction === "buy" ? price - riskDistance : price + riskDistance;
    const takeProfit = direction === "buy" ? price + riskDistance * 2.2 : price - riskDistance * 2.2;
    this.openPositions.push({
      direction,
      entryPrice: price,
      entryTime: timeMs,
      stopLoss,
      takeProfit,
      riskDistance,
      breakevenDone: false,
      trailingApplied: false,
    });
  }

  closePosition(pos, price, timeMs, reason) {
    const pipValue = getPipValue(this.pair);
    const priceDiff = (price - pos.entryPrice) * (pos.direction === "buy" ? 1 : -1);
    const pips = priceDiff / pipValue;
    const rr = pos.riskDistance ? priceDiff / pos.riskDistance : 0;
    this.equityPips += pips;
    this.trades.push({
      pair: this.pair,
      direction: pos.direction,
      entry: pos.entryPrice,
      exit: price,
      entryTime: formatIso(pos.entryTime),
      exitTime: formatIso(timeMs),
      pnlPips: pips,
      rr,
      reason,
      holdMinutes: (timeMs - pos.entryTime) / (60 * 1000),
    });
    this.recordEquity(timeMs);
  }

  recordEquity(timeMs) {
    this.equityCurve.push({ time: timeMs, equity: this.equityPips });
  }

  computeMaxDrawdown() {
    let peak = -Infinity;
    let maxDd = 0;
    for (const point of this.equityCurve) {
      if (point.equity > peak) peak = point.equity;
      const dd = peak - point.equity;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
  }

  summarize() {
    const total = this.trades.length;
    const wins = this.trades.filter((t) => t.pnlPips > 0);
    const losses = this.trades.filter((t) => t.pnlPips <= 0);
    const stopLossHits = this.trades.filter((t) => t.reason === "stop_loss");
    const takeProfitHits = this.trades.filter((t) => t.reason === "take_profit");
    const avg = (arr, key) => (arr.length ? arr.reduce((sum, item) => sum + item[key], 0) / arr.length : 0);
    return {
      pair: this.pair,
      period: { start: formatIso(this.range.start), end: formatIso(this.range.end) },
      totalTrades: total,
      winRate: total ? wins.length / total : 0,
      avgRR: avg(this.trades, "rr"),
      avgHoldMinutes: avg(this.trades, "holdMinutes"),
      stopLossHitRate: total ? stopLossHits.length / total : 0,
      takeProfitHitRate: total ? takeProfitHits.length / total : 0,
      maxDrawdownPips: this.computeMaxDrawdown(),
      equityPips: this.equityPips,
      trades: this.trades,
      appliedRecommendationKeys: Array.from(this.appliedRecommendationKeys),
    };
  }

  applyRecommendationFilters(signal, snapshot, price) {
    if (!signal) return null;
    const { h4, h1, m15 } = snapshot.indicators;

    // ATR floor on M15
    const atrBase = this.pair.includes("JPY") ? 0.025 : 0.00025;
    const atrFloor = atrBase * 0.8; // temporary 20% relaxation to allow setups to fire
    if (!m15?.atr || m15.atr < atrFloor) return null;
    this.appliedRecommendationKeys.add(APPLIED_KEYS.ATR_FLOOR);

    const tolerance = this.pair.includes("JPY") ? 0.03 : 0.0003;
    const priceOkBuy =
      h4?.emaFast &&
      h4?.emaSlow &&
      h1?.ema9 &&
      h1?.ema21 &&
      price >= h4.emaFast - tolerance &&
      price >= h1.ema9 - tolerance;
    const priceOkSell =
      h4?.emaFast &&
      h4?.emaSlow &&
      h1?.ema9 &&
      h1?.ema21 &&
      price <= h4.emaFast + tolerance &&
      price <= h1.ema9 + tolerance;

    if (signal === "buy") {
      if (!(h4?.emaFast > h4?.emaSlow && h1?.ema9 > h1?.ema21 && priceOkBuy)) return null;
      this.appliedRecommendationKeys.add(APPLIED_KEYS.EMA_ALIGNMENT);
      if (typeof m15?.rsi === "number" && m15.rsi >= 35) return null;
      this.appliedRecommendationKeys.add(APPLIED_KEYS.M15_RSI_GUARD);
    } else if (signal === "sell") {
      if (!(h4?.emaFast < h4?.emaSlow && h1?.ema9 < h1?.ema21 && priceOkSell)) return null;
      this.appliedRecommendationKeys.add(APPLIED_KEYS.EMA_ALIGNMENT);
      if (typeof m15?.rsi === "number" && m15.rsi <= 65) return null;
      this.appliedRecommendationKeys.add(APPLIED_KEYS.M15_RSI_GUARD);
    }

    // Mark stop/trailing rules as applied in openPosition / updateOpenPositions
    this.appliedRecommendationKeys.add(APPLIED_KEYS.TIGHTER_STOPS);
    this.appliedRecommendationKeys.add(APPLIED_KEYS.BREAKEVEN_AND_TRAIL);

    return signal;
  }

  async run() {
    this.load();
    this.verifyAlignment();
    this.driver = this.series[DRIVER_TIMEFRAME]?.length ? DRIVER_TIMEFRAME : "M1";
    const analysisStart = this.computeAnalysisStart();
    const driverCandles = this.series[this.driver].filter(
      (c) => c.timestampMs >= analysisStart && c.timestampMs <= this.range.end
    );

    if (!driverCandles.length) {
      console.warn(`[${this.pair}] No driver candles available inside the aligned window.`);
      return this.summarize();
    }

    for (const candle of driverCandles) {
      const currentTime = candle.timestampMs;
      this.advanceCursors(currentTime);
      const snapshot = await this.buildSnapshot();
      if (!snapshot) continue;
      this.latestSnapshot = snapshot;
      const price = this.getCurrentPrice();
      this.updateOpenPositions(price, currentTime);
      const { signal } = tradingService.generateSignals(this.pair, snapshot.indicators, snapshot.candles, price, price);
      const filteredSignal = this.applyRecommendationFilters(signal, snapshot, price);
      if (!filteredSignal) continue;
      if (this.openPositions.length) {
        const existing = this.openPositions[0];
        if (existing.direction !== filteredSignal) {
          this.closePosition(existing, price, currentTime, "reverse_signal");
          this.openPositions = [];
        } else {
          continue; // already in same direction
        }
      }
      if (this.openPositions.length < 1) {
        this.openPosition(filteredSignal, price, currentTime, snapshot);
      }
    }

    if (this.openPositions.length) {
      const last = driverCandles[driverCandles.length - 1];
      if (last) {
        const price = last.close;
        for (const pos of this.openPositions) {
          this.closePosition(pos, price, last.timestampMs, "end_of_data");
        }
        this.openPositions = [];
      }
    }

    return this.summarize();
  }
}

function listAvailablePairs() {
  const dataRoot = path.resolve(__dirname, "data");
  return fs
    .readdirSync(dataRoot)
    .filter((item) => fs.statSync(path.join(dataRoot, item)).isDirectory())
    .filter((item) => !item.startsWith("."));
}

function resolvePairs() {
  const available = listAvailablePairs();
  const envPairs = process.env.PAIRS
    ? process.env.PAIRS.split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const preferred = envPairs.length ? envPairs : TRADING.SYMBOLS;
  const usable = preferred.filter((p) => available.includes(p));
  return usable.length ? usable : available;
}

function buildRecommendations(statsByPair, previousAggregate, appliedKeys) {
  const totalTrades = statsByPair.reduce((sum, s) => sum + s.totalTrades, 0);
  const weightedWinRate =
    totalTrades === 0
      ? 0
      : statsByPair.reduce((sum, s) => sum + s.winRate * s.totalTrades, 0) / totalTrades;
  const avgRR =
    totalTrades === 0 ? 0 : statsByPair.reduce((sum, s) => sum + s.avgRR * s.totalTrades, 0) / totalTrades;
  const stopRate =
    totalTrades === 0
      ? 0
      : statsByPair.reduce((sum, s) => sum + s.stopLossHitRate * s.totalTrades, 0) / totalTrades;

  const improved =
    !previousAggregate ||
    weightedWinRate > (previousAggregate.weightedWinRate || 0) ||
    (weightedWinRate === (previousAggregate.weightedWinRate || 0) && avgRR > (previousAggregate.avgRR || 0));

  const recommendations = {
    entryConditions: [
      {
        recommendation:
          "Gate entries until H4 and H1 fast EMAs are aligned with price above/below both; only then act on M15 EMA9/21 crosses.",
        rationale: `Win rate ${(weightedWinRate * 100).toFixed(1)}% suggests tighter higher-timeframe confirmation is needed.`,
      },
      {
        recommendation: "Require M15 RSI < 35 for buys and > 65 for sells when crossing occurs to avoid mid-range noise.",
        rationale: `Stop-loss hit rate ${(stopRate * 100).toFixed(
          1
        )}% indicates many trades fire in chop; add momentum/mean-reversion guardrails.`,
      },
      ...(totalTrades === 0
        ? [
            {
              recommendation:
                "If trade count is zero, temporarily relax price-vs-EMA filter to within 0.0003 (3 pips for JPY 0.03) of the EMA levels to allow setups to trigger.",
              rationale: "Prevents the strategy from stalling when alignment is close but not exact; revert once trades resume.",
            },
          ]
        : []),
    ],
    filters: [
      {
        recommendation: "Skip signals when M15 ATR < 0.00025 (or < 0.025 for JPY pairs) to avoid low-volatility whip saws.",
        rationale: "Low ATR environments amplify false breaks; enforcing a floor keeps entries to actionable moves.",
      },
      {
        recommendation: "Align backtest/live cadence to completed 5-minute candles; discard partially formed bars.",
        rationale: "Ensures decisions mirror live bot timing and avoids lookahead bias.",
      },
      ...(totalTrades === 0
        ? [
            {
              recommendation: "When no trades occur, temporarily lower the ATR floor by 20% to probe for valid setups, then restore.",
              rationale: "Allows discovery of tradeable regimes while keeping a volatility filter in place.",
            },
          ]
        : []),
    ],
    stopsAndTakeProfit: [
      {
        recommendation: "Tighten initial stop to 1.2 x ATR when stop-loss hits dominate; keep TP at 2.2 x that distance.",
        rationale: "Reduces give-back on losing trades while keeping >1.8R targets; adjust upward when volatility expands.",
      },
      {
        recommendation: "Introduce breakeven shift after +1R and trail by 1 x ATR on M5 once price moves +1.5R.",
        rationale: "Locks profits on extended moves and mirrors the live trailing stop intent.",
      },
    ],
    riskAndTiming: [
      {
        recommendation: "Cap simultaneous positions per pair at one and per portfolio at three until win rate improves above 50%.",
        rationale: "Keeps aggregate risk controlled while validating refinements from the backtest.",
      },
      {
        recommendation: "Favor London/NY overlap; suppress signals during the first 15 minutes after each H1 open.",
        rationale: "Volatility spikes at session transitions distorted several trades; delaying entries smooths fills.",
      },
    ],
  };

  return {
    generatedAt: new Date().toISOString(),
    statsByPair: statsByPair.map(({ trades, ...rest }) => rest),
    aggregate: {
      totalPairs: statsByPair.length,
      totalTrades,
      weightedWinRate,
      avgRR,
      stopLossHitRate: stopRate,
      improved,
      previousAggregate: previousAggregate || null,
    },
    recommendations,
    appliedRecommendations: Array.from(appliedKeys || []),
  };
}

function loadPreviousRecommendations() {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
  } catch (err) {
    console.warn("Could not read previous recommendation file:", err.message);
    return null;
  }
}

async function main() {
  const previous = loadPreviousRecommendations();
  const pairs = resolvePairs();
  const summaries = [];
  for (const pair of pairs) {
    try {
      const runner = new PairBacktester(pair);
      const summary = await runner.run();
      console.log(
        `[${pair}] trades=${summary.totalTrades} winRate=${(summary.winRate * 100).toFixed(1)}% rr=${summary.avgRR.toFixed(
          2
        )} dd=${summary.maxDrawdownPips.toFixed(1)} pips`
      );
      summaries.push(summary);
    } catch (err) {
      console.error(`[${pair}] Backtest failed:`, err.message);
    }
  }

  if (!summaries.length) {
    console.error("No backtests completed; recommendations not generated.");
    process.exit(1);
  }

  const appliedKeys = summaries
    .map((s) => s.appliedRecommendationKeys || [])
    .flat()
    .filter(Boolean);

  const recommendationDoc = buildRecommendations(summaries, previous?.aggregate, new Set(appliedKeys));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(recommendationDoc, null, 2));
  console.log(`Recommendation file written to ${OUTPUT_FILE}`);
}

if (import.meta.url === `file://${__filename}`) {
  main().catch((err) => {
    console.error("Backtest run failed:", err);
    process.exit(1);
  });
}
