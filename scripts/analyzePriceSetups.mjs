import fs from "node:fs";
import path from "node:path";

const PRICE_DIR = path.join(process.cwd(), "backtest", "prices");
const REPORT_DIR = path.join(process.cwd(), "backtest", "reports");
const TIMEFRAMES = ["d1", "h4", "h1", "m15", "m5", "m1"];
const EPS = 1e-12;

const CRYPTO_HINTS = ["BTC", "ETH", "DOGE", "SOL", "XRP", "LTC", "ADA"];

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function pct(values, predicate) {
  if (!values.length) return null;
  let count = 0;
  for (const v of values) {
    if (predicate(v)) count += 1;
  }
  return count / values.length;
}

function upperBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function percentileRank(sorted, x) {
  if (!sorted?.length || !Number.isFinite(x)) return null;
  return upperBound(sorted, x) / sorted.length;
}

function sign(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  return Math.min(1, Math.max(0, x));
}

function isCryptoSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  return CRYPTO_HINTS.some((hint) => s.includes(hint));
}

function normalizeTf(ind, price) {
  if (!ind || typeof ind !== "object") return {};

  const adxObj = ind.adx && typeof ind.adx === "object" ? ind.adx : {};
  const bb = ind.bb && typeof ind.bb === "object" ? ind.bb : {};
  const macd = ind.macd && typeof ind.macd === "object" ? ind.macd : {};

  const atr = toNum(ind.atr);
  const atrPct = toNum(ind.atrPct) ?? (atr !== null && price ? atr / price : null);
  const bbMiddle = toNum(bb.middle);
  const bbUpper = toNum(bb.upper);
  const bbLower = toNum(bb.lower);
  const bbWidth =
    toNum(ind.bbWidth) ??
    (bbUpper !== null && bbLower !== null && (bbMiddle !== null ? Math.abs(bbMiddle) > EPS : price)
      ? (bbUpper - bbLower) / (Math.abs(bbMiddle ?? price) || 1)
      : null);

  const macdHist = toNum(macd.histogram ?? ind.macdHistogram);
  const macdHistPrev = toNum(ind.macdHistPrev);
  const macdHistSlope = toNum(ind.macdHistSlope) ?? (macdHist !== null && macdHistPrev !== null ? macdHist - macdHistPrev : null);

  const ema20 = toNum(ind.ema20);
  const ema50 = toNum(ind.ema50);
  const ema20_50_spreadPct =
    toNum(ind.ema20_50_spreadPct) ??
    (ema20 !== null && ema50 !== null && price ? (ema20 - ema50) / price : null);

  let trendSign = 0;
  const trendRaw = typeof ind.trend === "string" ? ind.trend.toLowerCase() : null;
  if (trendRaw === "bullish") trendSign = 1;
  else if (trendRaw === "bearish") trendSign = -1;
  else if (ema20 !== null && ema50 !== null) trendSign = sign(ema20 - ema50);
  else {
    const pdi = toNum(adxObj.pdi);
    const mdi = toNum(adxObj.mdi);
    if (pdi !== null && mdi !== null) trendSign = sign(pdi - mdi);
  }

  return {
    rsi: toNum(ind.rsi),
    adx: toNum(adxObj.adx ?? ind.adx),
    pdi: toNum(adxObj.pdi),
    mdi: toNum(adxObj.mdi),
    atr,
    atrPct,
    bbPb: clamp01(toNum(bb.pb)),
    bbWidth,
    priceVsEma9: toNum(ind.price_vs_ema9),
    macdHist,
    macdHistSlope,
    ema20_50_spreadPct,
    trendSign,
  };
}

function flattenTf(prefix, tf, target) {
  const map = {
    trendSign: "trend",
    rsi: "rsi",
    adx: "adx",
    pdi: "pdi",
    mdi: "mdi",
    atrPct: "atrPct",
    bbPb: "bbPb",
    bbWidth: "bbWidth",
    priceVsEma9: "priceVsEma9",
    macdHist: "macdHist",
    macdHistSlope: "macdHistSlope",
    ema20_50_spreadPct: "ema20_50_spreadPct",
  };
  for (const [k, suffix] of Object.entries(map)) {
    const v = tf[k];
    if (v !== undefined && v !== null && Number.isFinite(v)) target[`${prefix}_${suffix}`] = v;
    else if (k === "trendSign") target[`${prefix}_${suffix}`] = tf[k] ?? 0;
    else target[`${prefix}_${suffix}`] = null;
  }
}

function parsePriceFile(filePath) {
  const symbol = path.basename(filePath, ".jsonl").toUpperCase();
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  let invalidLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      invalidLines += 1;
      continue;
    }
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    const bid = toNum(entry.bid);
    const ask = toNum(entry.ask);
    const mid = toNum(entry.mid);
    const price = toNum(entry.price) ?? mid ?? (bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask);
    if (!Number.isFinite(price)) continue;
    const spread = toNum(entry.spread) ?? (bid !== null && ask !== null ? ask - bid : null);
    const sessions = Array.isArray(entry.sessions) ? entry.sessions.map((s) => String(s).toUpperCase()) : [];
    const indicators = entry.indicators && typeof entry.indicators === "object" ? entry.indicators : {};

    const flat = {
      symbol,
      assetClass: isCryptoSymbol(symbol) ? "crypto" : "forex",
      timestamp: entry.timestamp,
      ts,
      dateKey: new Date(ts).toISOString().slice(0, 10),
      bid,
      ask,
      mid,
      price,
      spread,
      spreadPct: spread !== null && Math.abs(price) > EPS ? spread / price : null,
      newsBlocked: Boolean(entry.newsBlocked),
      sessionNY: sessions.includes("NY") ? 1 : 0,
      sessionLONDON: sessions.includes("LONDON") ? 1 : 0,
      sessionTOKYO: sessions.includes("TOKYO") ? 1 : 0,
      sessionSYDNEY: sessions.includes("SYDNEY") ? 1 : 0,
      sessionCRYPTO: sessions.includes("CRYPTO") ? 1 : 0,
      hasCandles: entry.candles && typeof entry.candles === "object" ? 1 : 0,
      formatVariant: entry.candles ? "newer" : "older",
      long_best: null,
      short_best: null,
      long_eod: null,
      short_eod: null,
      long_mae: null,
      short_mae: null,
      long_ttb_min: null,
      short_ttb_min: null,
      minutesLeftDay: null,
      m5_atrPct_pctRank: null,
      m15_atrPct_pctRank: null,
      m5_bbWidth_pctRank: null,
      m15_bbWidth_pctRank: null,
      m5_adx_pctRank: null,
      m15_adx_pctRank: null,
      h1_adx_pctRank: null,
      h4_adx_pctRank: null,
      spreadPct_pctRank: null,
    };

    for (const tfName of TIMEFRAMES) {
      const tf = normalizeTf(indicators[tfName], price);
      flattenTf(tfName, tf, flat);
    }

    rows.push(flat);
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { symbol, rows, invalidLines, lineCount: lines.length };
}

function computeSuffixExtrema(values, mode = "max") {
  const n = values.length;
  const outVal = new Array(n);
  const outIdx = new Array(n);
  let bestVal = mode === "max" ? -Infinity : Infinity;
  let bestIdx = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (Number.isFinite(v)) {
      const better = mode === "max" ? v >= bestVal : v <= bestVal;
      if (better) {
        bestVal = v;
        bestIdx = i;
      }
    }
    outVal[i] = Number.isFinite(bestVal) ? bestVal : null;
    outIdx[i] = bestIdx;
  }
  return { outVal, outIdx };
}

function summarizeSymbol(rows) {
  if (!rows.length) return null;
  const spreads = rows.map((r) => r.spreadPct).filter(Number.isFinite);
  const m5AtrPct = rows.map((r) => r.m5_atrPct).filter(Number.isFinite);
  const m15AtrPct = rows.map((r) => r.m15_atrPct).filter(Number.isFinite);
  const m5Adx = rows.map((r) => r.m5_adx).filter(Number.isFinite);
  const h1Adx = rows.map((r) => r.h1_adx).filter(Number.isFinite);
  const m5LowPower = rows.filter((r) => Number.isFinite(r.m5_adx) && Number.isFinite(r.m15_adx) && r.m5_adx < 18 && r.m15_adx < 18).length;
  const h4h1Bull = rows.filter((r) => r.h4_trend === 1 && r.h1_trend === 1).length;
  const h4h1Bear = rows.filter((r) => r.h4_trend === -1 && r.h1_trend === -1).length;
  return {
    symbol: rows[0].symbol,
    assetClass: rows[0].assetClass,
    rows: rows.length,
    from: rows[0].timestamp,
    to: rows[rows.length - 1].timestamp,
    uniqueDays: new Set(rows.map((r) => r.dateKey)).size,
    formatNewerPct: rows.filter((r) => r.formatVariant === "newer").length / rows.length,
    spreadPctMedian: median(spreads),
    spreadPctP90: quantile(spreads, 0.9),
    m5AtrPctMedian: median(m5AtrPct),
    m15AtrPctMedian: median(m15AtrPct),
    m5AdxMedian: median(m5Adx),
    h1AdxMedian: median(h1Adx),
    lowPowerPct: rows.length ? m5LowPower / rows.length : null,
    h4h1BullPct: rows.length ? h4h1Bull / rows.length : null,
    h4h1BearPct: rows.length ? h4h1Bear / rows.length : null,
  };
}

function buildObservations(symbolDatasets) {
  const observations = [];
  const symbolSummaries = [];
  const coverage = {
    parsedFiles: 0,
    totalRows: 0,
    invalidLines: 0,
    totalLines: 0,
  };

  for (const dataset of symbolDatasets) {
    const { symbol, rows, invalidLines, lineCount } = dataset;
    coverage.parsedFiles += 1;
    coverage.totalRows += rows.length;
    coverage.invalidLines += invalidLines;
    coverage.totalLines += lineCount;
    symbolSummaries.push(summarizeSymbol(rows));

    let start = 0;
    while (start < rows.length) {
      let end = start + 1;
      const dateKey = rows[start].dateKey;
      while (end < rows.length && rows[end].dateKey === dateKey) end += 1;
      const dayRows = rows.slice(start, end);
      if (dayRows.length >= 2) {
        const bids = dayRows.map((r) => r.bid ?? r.price);
        const asks = dayRows.map((r) => r.ask ?? r.price);
        const times = dayRows.map((r) => r.ts);
        const lastBid = bids[dayRows.length - 1];
        const lastAsk = asks[dayRows.length - 1];

        const maxFutureBid = computeSuffixExtrema(bids, "max");
        const minFutureAsk = computeSuffixExtrema(asks, "min");
        const minFutureBid = computeSuffixExtrema(bids, "min");
        const maxFutureAsk = computeSuffixExtrema(asks, "max");

        for (let i = 0; i < dayRows.length - 1; i += 1) {
          const row = dayRows[i];
          const entryAsk = asks[i];
          const entryBid = bids[i];
          if (!Number.isFinite(entryAsk) || !Number.isFinite(entryBid) || entryAsk <= 0 || entryBid <= 0) continue;

          const longBestBid = maxFutureBid.outVal[i + 1];
          const shortBestAsk = minFutureAsk.outVal[i + 1];
          const longWorstBid = minFutureBid.outVal[i + 1];
          const shortWorstAsk = maxFutureAsk.outVal[i + 1];
          if (!Number.isFinite(longBestBid) || !Number.isFinite(shortBestAsk)) continue;

          const longBest = (longBestBid - entryAsk) / entryAsk;
          const shortBest = (entryBid - shortBestAsk) / entryBid;
          const longEod = Number.isFinite(lastBid) ? (lastBid - entryAsk) / entryAsk : null;
          const shortEod = Number.isFinite(lastAsk) ? (entryBid - lastAsk) / entryBid : null;
          const longMae = Number.isFinite(longWorstBid) ? (longWorstBid - entryAsk) / entryAsk : null;
          const shortMae = Number.isFinite(shortWorstAsk) ? (entryBid - shortWorstAsk) / entryBid : null;
          const longBestIdx = maxFutureBid.outIdx[i + 1];
          const shortBestIdx = minFutureAsk.outIdx[i + 1];

          row.long_best = longBest;
          row.short_best = shortBest;
          row.long_eod = longEod;
          row.short_eod = shortEod;
          row.long_mae = longMae;
          row.short_mae = shortMae;
          row.long_ttb_min = Number.isInteger(longBestIdx) && longBestIdx >= 0 ? (times[longBestIdx] - times[i]) / 60000 : null;
          row.short_ttb_min = Number.isInteger(shortBestIdx) && shortBestIdx >= 0 ? (times[shortBestIdx] - times[i]) / 60000 : null;
          row.minutesLeftDay = (times[dayRows.length - 1] - times[i]) / 60000;
          observations.push(row);
        }
      }
      start = end;
    }
  }

  return { observations, symbolSummaries: symbolSummaries.filter(Boolean), coverage };
}

function addPercentileFeatures(observations) {
  const keys = [
    "m5_atrPct",
    "m15_atrPct",
    "m5_bbWidth",
    "m15_bbWidth",
    "m5_adx",
    "m15_adx",
    "h1_adx",
    "h4_adx",
    "spreadPct",
  ];
  const symbolFeatureSorted = new Map();

  for (const obs of observations) {
    let map = symbolFeatureSorted.get(obs.symbol);
    if (!map) {
      map = new Map();
      symbolFeatureSorted.set(obs.symbol, map);
    }
    for (const key of keys) {
      const v = obs[key];
      if (!Number.isFinite(v)) continue;
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(v);
    }
  }

  for (const map of symbolFeatureSorted.values()) {
    for (const [key, arr] of map) arr.sort((a, b) => a - b);
  }

  for (const obs of observations) {
    const map = symbolFeatureSorted.get(obs.symbol);
    for (const key of keys) {
      const sorted = map?.get(key);
      const v = obs[key];
      obs[`${key}_pctRank`] = Number.isFinite(v) ? percentileRank(sorted, v) : null;
    }
  }
}

function buildUniverseStats(observations) {
  const longBestBps = observations.map((o) => o.long_best * 10000).filter(Number.isFinite);
  const shortBestBps = observations.map((o) => o.short_best * 10000).filter(Number.isFinite);
  const longEodBps = observations.map((o) => o.long_eod * 10000).filter(Number.isFinite);
  const shortEodBps = observations.map((o) => o.short_eod * 10000).filter(Number.isFinite);
  return {
    observationCount: observations.length,
    longBestBpsMedian: median(longBestBps),
    shortBestBpsMedian: median(shortBestBps),
    longBestBpsP90: quantile(longBestBps, 0.9),
    shortBestBpsP90: quantile(shortBestBps, 0.9),
    longEodBpsMedian: median(longEodBps),
    shortEodBpsMedian: median(shortEodBps),
    lowPowerPct: observations.length
      ? observations.filter((o) => Number.isFinite(o.m5_adx) && Number.isFinite(o.m15_adx) && o.m5_adx < 18 && o.m15_adx < 18).length / observations.length
      : null,
  };
}

function evaluateRule(observations, rule) {
  const best = [];
  const eod = [];
  const mae = [];
  const ttb = [];
  const bySymbol = new Map();
  let count = 0;

  for (const obs of observations) {
    if (!rule.when(obs)) continue;
    const bestRet = rule.direction === "long" ? obs.long_best : obs.short_best;
    const eodRet = rule.direction === "long" ? obs.long_eod : obs.short_eod;
    const maeRet = rule.direction === "long" ? obs.long_mae : obs.short_mae;
    const ttbMin = rule.direction === "long" ? obs.long_ttb_min : obs.short_ttb_min;
    if (!Number.isFinite(bestRet)) continue;

    count += 1;
    const bestBps = bestRet * 10000;
    best.push(bestBps);
    if (Number.isFinite(eodRet)) eod.push(eodRet * 10000);
    if (Number.isFinite(maeRet)) mae.push(maeRet * 10000);
    if (Number.isFinite(ttbMin)) ttb.push(ttbMin);

    const sym = obs.symbol;
    let s = bySymbol.get(sym);
    if (!s) {
      s = { count: 0, best: [] };
      bySymbol.set(sym, s);
    }
    s.count += 1;
    s.best.push(bestBps);
  }

  if (count < (rule.minCount ?? 1)) return null;

  const bestMedian = median(best);
  const bestP25 = quantile(best, 0.25);
  const bestP75 = quantile(best, 0.75);
  const bestMean = mean(best);
  const eodMean = mean(eod);
  const maeMedian = median(mae);
  const ttbMedian = median(ttb);
  const hit20 = pct(best, (v) => v >= 20);
  const hit40 = pct(best, (v) => v >= 40);
  const hit80 = pct(best, (v) => v >= 80);
  const positiveEodPct = pct(eod, (v) => v > 0);
  const bySymbolTop = [...bySymbol.entries()]
    .map(([symbol, v]) => ({ symbol, count: v.count, bestMedianBps: median(v.best), bestMeanBps: mean(v.best) }))
    .sort((a, b) => (b.count - a.count) || (b.bestMedianBps - a.bestMedianBps))
    .slice(0, 5);

  const score =
    (Number.isFinite(bestMedian) ? bestMedian : 0) * 0.7 +
    (Number.isFinite(bestP25) ? bestP25 : 0) * 0.3 +
    (Number.isFinite(eodMean) ? Math.max(-20, eodMean) * 0.15 : 0) +
    Math.log10(count + 10) * 5;

  return {
    name: rule.name,
    family: rule.family,
    direction: rule.direction,
    count,
    score,
    bestMedianBps: bestMedian,
    bestMeanBps: bestMean,
    bestP25Bps: bestP25,
    bestP75Bps: bestP75,
    hit20Pct: hit20,
    hit40Pct: hit40,
    hit80Pct: hit80,
    eodMeanBps: eodMean,
    eodMedianBps: median(eod),
    positiveEodPct,
    maeMedianBps: maeMedian,
    ttbMedianMin: ttbMedian,
    bySymbolTop,
    conditions: rule.conditions,
  };
}

function buildRules() {
  const rules = [];

  const mk = (family, direction, name, conditions, atoms, minCount = 40) => {
    rules.push({
      family,
      direction,
      name,
      conditions,
      minCount,
      when: (o) => atoms.every((fn) => fn(o)),
    });
  };

  const base = {
    hasCore: (o) => Number.isFinite(o.m5_rsi) && Number.isFinite(o.m1_macdHistSlope) && Number.isFinite(o.h1_adx) && Number.isFinite(o.h4_adx),
    notNews: (o) => o.newsBlocked === false,
    spreadReasonable: (o) => !Number.isFinite(o.spreadPct_pctRank) || o.spreadPct_pctRank <= 0.85,
    h4Bull: (o) => o.h4_trend === 1,
    h4Bear: (o) => o.h4_trend === -1,
    h1Bull: (o) => o.h1_trend === 1,
    h1Bear: (o) => o.h1_trend === -1,
    m15BullishBias: (o) => o.m15_trend >= 0,
    m15BearishBias: (o) => o.m15_trend <= 0,
    h4Adx18: (o) => Number.isFinite(o.h4_adx) && o.h4_adx >= 18,
    h4Adx22: (o) => Number.isFinite(o.h4_adx) && o.h4_adx >= 22,
    h1Adx18: (o) => Number.isFinite(o.h1_adx) && o.h1_adx >= 18,
    h1Adx22: (o) => Number.isFinite(o.h1_adx) && o.h1_adx >= 22,
    h1AdxLow20: (o) => Number.isFinite(o.h1_adx) && o.h1_adx < 20,
    m15Adx15: (o) => Number.isFinite(o.m15_adx) && o.m15_adx >= 15,
    m15Adx18: (o) => Number.isFinite(o.m15_adx) && o.m15_adx >= 18,
    m15AdxLow18: (o) => Number.isFinite(o.m15_adx) && o.m15_adx < 18,
    m5Adx15: (o) => Number.isFinite(o.m5_adx) && o.m5_adx >= 15,
    m5Adx20: (o) => Number.isFinite(o.m5_adx) && o.m5_adx >= 20,
    m5AdxLow18: (o) => Number.isFinite(o.m5_adx) && o.m5_adx < 18,
    m5Vol60: (o) => Number.isFinite(o.m5_atrPct_pctRank) && o.m5_atrPct_pctRank >= 0.6,
    m5Vol75: (o) => Number.isFinite(o.m5_atrPct_pctRank) && o.m5_atrPct_pctRank >= 0.75,
    m15Vol60: (o) => Number.isFinite(o.m15_atrPct_pctRank) && o.m15_atrPct_pctRank >= 0.6,
    m15Vol75: (o) => Number.isFinite(o.m15_atrPct_pctRank) && o.m15_atrPct_pctRank >= 0.75,
    m5Width60: (o) => Number.isFinite(o.m5_bbWidth_pctRank) && o.m5_bbWidth_pctRank >= 0.6,
    m5Width75: (o) => Number.isFinite(o.m5_bbWidth_pctRank) && o.m5_bbWidth_pctRank >= 0.75,
    m5PbLow30: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb <= 0.3,
    m5PbLow20: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb <= 0.2,
    m5PbHigh70: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb >= 0.7,
    m5PbHigh80: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb >= 0.8,
    m5PbAbove55: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb >= 0.55,
    m5PbBelow45: (o) => Number.isFinite(o.m5_bbPb) && o.m5_bbPb <= 0.45,
    m5RsiLe45: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi <= 45,
    m5RsiLe40: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi <= 40,
    m5RsiLe35: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi <= 35,
    m5RsiGe55: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi >= 55,
    m5RsiGe60: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi >= 60,
    m5RsiGe65: (o) => Number.isFinite(o.m5_rsi) && o.m5_rsi >= 65,
    m1RsiLe45: (o) => Number.isFinite(o.m1_rsi) && o.m1_rsi <= 45,
    m1RsiLe40: (o) => Number.isFinite(o.m1_rsi) && o.m1_rsi <= 40,
    m1RsiGe55: (o) => Number.isFinite(o.m1_rsi) && o.m1_rsi >= 55,
    m1RsiGe60: (o) => Number.isFinite(o.m1_rsi) && o.m1_rsi >= 60,
    m1MacdTurnUp: (o) => Number.isFinite(o.m1_macdHistSlope) && o.m1_macdHistSlope > 0,
    m1MacdTurnDown: (o) => Number.isFinite(o.m1_macdHistSlope) && o.m1_macdHistSlope < 0,
    m5MacdUp: (o) => Number.isFinite(o.m5_macdHist) && o.m5_macdHist > 0,
    m5MacdDown: (o) => Number.isFinite(o.m5_macdHist) && o.m5_macdHist < 0,
    m5MacdSlopeUp: (o) => Number.isFinite(o.m5_macdHistSlope) && o.m5_macdHistSlope > 0,
    m5MacdSlopeDown: (o) => Number.isFinite(o.m5_macdHistSlope) && o.m5_macdHistSlope < 0,
    m15MacdUp: (o) => Number.isFinite(o.m15_macdHist) && o.m15_macdHist > 0,
    m15MacdDown: (o) => Number.isFinite(o.m15_macdHist) && o.m15_macdHist < 0,
    m15MacdSlopeUp: (o) => Number.isFinite(o.m15_macdHistSlope) && o.m15_macdHistSlope > 0,
    m15MacdSlopeDown: (o) => Number.isFinite(o.m15_macdHistSlope) && o.m15_macdHistSlope < 0,
    m5BelowEma9: (o) => Number.isFinite(o.m5_priceVsEma9) && o.m5_priceVsEma9 <= 0,
    m5AboveEma9: (o) => Number.isFinite(o.m5_priceVsEma9) && o.m5_priceVsEma9 >= 0,
    h1SpreadPos: (o) => Number.isFinite(o.h1_ema20_50_spreadPct) && o.h1_ema20_50_spreadPct > 0,
    h1SpreadNeg: (o) => Number.isFinite(o.h1_ema20_50_spreadPct) && o.h1_ema20_50_spreadPct < 0,
    minutesLeft30: (o) => Number.isFinite(o.minutesLeftDay) && o.minutesLeftDay >= 30,
    minutesLeft60: (o) => Number.isFinite(o.minutesLeftDay) && o.minutesLeftDay >= 60,
    minutesLeft120: (o) => Number.isFinite(o.minutesLeftDay) && o.minutesLeftDay >= 120,
    lowRangeState: (o) =>
      Number.isFinite(o.m5_adx) &&
      Number.isFinite(o.m15_adx) &&
      o.m5_adx < 18 &&
      o.m15_adx < 18 &&
      (!Number.isFinite(o.m5_atrPct_pctRank) || o.m5_atrPct_pctRank < 0.5),
  };

  const commonSafety = [base.hasCore, base.notNews, base.spreadReasonable];

  const addComboRules = ({ family, direction, nameBase, required, optionalSets, minCount = 40 }) => {
    const recurse = (idx, chosenFns, chosenLabels) => {
      if (idx >= optionalSets.length) {
        const labels = [...required.labels, ...chosenLabels];
        const fns = [...required.fns, ...chosenFns];
        mk(family, direction, `${nameBase} | ${labels.join(", ")}`, labels, fns, minCount);
        return;
      }
      for (const opt of optionalSets[idx]) {
        recurse(idx + 1, [...chosenFns, opt.fn], [...chosenLabels, opt.label]);
      }
    };
    recurse(0, [], []);
  };

  addComboRules({
    family: "trend_pullback",
    direction: "long",
    nameBase: "Trend Pullback Long",
    required: {
      labels: ["h4+h1 bullish", "h4/h1 ADX>=18", "m5 pullback below EMA9", "m1 MACD turn up"],
      fns: [...commonSafety, base.h4Bull, base.h1Bull, base.h4Adx18, base.h1Adx18, base.m5BelowEma9, base.m1MacdTurnUp, base.minutesLeft60],
    },
    optionalSets: [
      [{ label: "m5 RSI<=45", fn: base.m5RsiLe45 }, { label: "m5 RSI<=40", fn: base.m5RsiLe40 }, { label: "m5 RSI<=35", fn: base.m5RsiLe35 }],
      [{ label: "m5 BB pb<=0.30", fn: base.m5PbLow30 }, { label: "m5 BB pb<=0.20", fn: base.m5PbLow20 }],
      [{ label: "m15 bias bullish", fn: base.m15BullishBias }, { label: "m15 ADX>=15", fn: base.m15Adx15 }, { label: "m15 vol>=60p", fn: base.m15Vol60 }],
      [{ label: "m5 vol>=60p", fn: base.m5Vol60 }, { label: "m5 vol>=75p", fn: base.m5Vol75 }, { label: "m5 ADX>=15", fn: base.m5Adx15 }],
    ],
    minCount: 50,
  });

  addComboRules({
    family: "trend_pullback",
    direction: "short",
    nameBase: "Trend Pullback Short",
    required: {
      labels: ["h4+h1 bearish", "h4/h1 ADX>=18", "m5 pullback above EMA9", "m1 MACD turn down"],
      fns: [...commonSafety, base.h4Bear, base.h1Bear, base.h4Adx18, base.h1Adx18, base.m5AboveEma9, base.m1MacdTurnDown, base.minutesLeft60],
    },
    optionalSets: [
      [{ label: "m5 RSI>=55", fn: base.m5RsiGe55 }, { label: "m5 RSI>=60", fn: base.m5RsiGe60 }, { label: "m5 RSI>=65", fn: base.m5RsiGe65 }],
      [{ label: "m5 BB pb>=0.70", fn: base.m5PbHigh70 }, { label: "m5 BB pb>=0.80", fn: base.m5PbHigh80 }],
      [{ label: "m15 bias bearish", fn: base.m15BearishBias }, { label: "m15 ADX>=15", fn: base.m15Adx15 }, { label: "m15 vol>=60p", fn: base.m15Vol60 }],
      [{ label: "m5 vol>=60p", fn: base.m5Vol60 }, { label: "m5 vol>=75p", fn: base.m5Vol75 }, { label: "m5 ADX>=15", fn: base.m5Adx15 }],
    ],
    minCount: 50,
  });

  addComboRules({
    family: "trend_breakout",
    direction: "long",
    nameBase: "Trend Breakout Long",
    required: {
      labels: ["h4+h1 bullish", "m15 MACD up", "m5 MACD confirms", "m5 above mid-band"],
      fns: [
        ...commonSafety,
        base.h4Bull,
        base.h1Bull,
        base.h4Adx18,
        base.h1Adx18,
        base.m15MacdUp,
        base.m15MacdSlopeUp,
        base.m5MacdUp,
        base.m5MacdSlopeUp,
        base.m5PbAbove55,
        base.minutesLeft60,
      ],
    },
    optionalSets: [
      [{ label: "m15 ADX>=15", fn: base.m15Adx15 }, { label: "m15 ADX>=18", fn: base.m15Adx18 }, { label: "m15 vol>=60p", fn: base.m15Vol60 }],
      [{ label: "m5 ADX>=15", fn: base.m5Adx15 }, { label: "m5 ADX>=20", fn: base.m5Adx20 }, { label: "m5 width>=60p", fn: base.m5Width60 }],
      [{ label: "m5 vol>=60p", fn: base.m5Vol60 }, { label: "m5 vol>=75p", fn: base.m5Vol75 }, { label: "m5 width>=75p", fn: base.m5Width75 }],
      [{ label: "m15 bias bullish", fn: base.m15BullishBias }, { label: "h1 EMA20>EMA50", fn: base.h1SpreadPos }],
    ],
    minCount: 50,
  });

  addComboRules({
    family: "trend_breakout",
    direction: "short",
    nameBase: "Trend Breakout Short",
    required: {
      labels: ["h4+h1 bearish", "m15 MACD down", "m5 MACD confirms", "m5 below mid-band"],
      fns: [
        ...commonSafety,
        base.h4Bear,
        base.h1Bear,
        base.h4Adx18,
        base.h1Adx18,
        base.m15MacdDown,
        base.m15MacdSlopeDown,
        base.m5MacdDown,
        base.m5MacdSlopeDown,
        base.m5PbBelow45,
        base.minutesLeft60,
      ],
    },
    optionalSets: [
      [{ label: "m15 ADX>=15", fn: base.m15Adx15 }, { label: "m15 ADX>=18", fn: base.m15Adx18 }, { label: "m15 vol>=60p", fn: base.m15Vol60 }],
      [{ label: "m5 ADX>=15", fn: base.m5Adx15 }, { label: "m5 ADX>=20", fn: base.m5Adx20 }, { label: "m5 width>=60p", fn: base.m5Width60 }],
      [{ label: "m5 vol>=60p", fn: base.m5Vol60 }, { label: "m5 vol>=75p", fn: base.m5Vol75 }, { label: "m5 width>=75p", fn: base.m5Width75 }],
      [{ label: "m15 bias bearish", fn: base.m15BearishBias }, { label: "h1 EMA20<EMA50", fn: base.h1SpreadNeg }],
    ],
    minCount: 50,
  });

  addComboRules({
    family: "range_reversal",
    direction: "long",
    nameBase: "Range Reversal Long",
    required: {
      labels: ["low-power regime", "m5 oversold extreme", "m1 turn up"],
      fns: [...commonSafety, base.lowRangeState, base.h1AdxLow20, base.m15AdxLow18, base.m5PbLow20, base.m5RsiLe35, base.m1MacdTurnUp, base.minutesLeft30],
    },
    optionalSets: [
      [{ label: "m1 RSI<=45", fn: base.m1RsiLe45 }, { label: "m1 RSI<=40", fn: base.m1RsiLe40 }],
      [{ label: "m5 below EMA9", fn: base.m5BelowEma9 }, { label: "m5 vol>=60p", fn: base.m5Vol60 }],
    ],
    minCount: 40,
  });

  addComboRules({
    family: "range_reversal",
    direction: "short",
    nameBase: "Range Reversal Short",
    required: {
      labels: ["low-power regime", "m5 overbought extreme", "m1 turn down"],
      fns: [...commonSafety, base.lowRangeState, base.h1AdxLow20, base.m15AdxLow18, base.m5PbHigh80, base.m5RsiGe65, base.m1MacdTurnDown, base.minutesLeft30],
    },
    optionalSets: [
      [{ label: "m1 RSI>=55", fn: base.m1RsiGe55 }, { label: "m1 RSI>=60", fn: base.m1RsiGe60 }],
      [{ label: "m5 above EMA9", fn: base.m5AboveEma9 }, { label: "m5 vol>=60p", fn: base.m5Vol60 }],
    ],
    minCount: 40,
  });

  return rules;
}

function rankRules(observations) {
  const rules = buildRules();
  const results = [];
  for (const rule of rules) {
    const res = evaluateRule(observations, rule);
    if (res) results.push(res);
  }

  const dedupe = new Set();
  const cleaned = results
    .sort((a, b) => (b.score - a.score) || (b.count - a.count))
    .filter((r) => {
      const key = `${r.family}|${r.direction}|${r.conditions.join("|")}`;
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    });

  const topByFamily = {};
  for (const r of cleaned) {
    const key = `${r.family}_${r.direction}`;
    if (!topByFamily[key]) topByFamily[key] = [];
    if (topByFamily[key].length < 5) topByFamily[key].push(r);
  }

  const topOverall = cleaned
    .filter((r) => r.count >= 50)
    .sort((a, b) => {
      const byMedian = (b.bestMedianBps ?? -Infinity) - (a.bestMedianBps ?? -Infinity);
      if (byMedian !== 0) return byMedian;
      const byP25 = (b.bestP25Bps ?? -Infinity) - (a.bestP25Bps ?? -Infinity);
      if (byP25 !== 0) return byP25;
      return b.count - a.count;
    })
    .slice(0, 12);

  return { evaluatedRules: cleaned.length, topOverall, topByFamily };
}

function topMoments(observations, limit = 15) {
  const candidates = [];
  for (const o of observations) {
    if (Number.isFinite(o.long_best) && Number.isFinite(o.short_best)) {
      const dir = o.long_best >= o.short_best ? "long" : "short";
      const best = Math.max(o.long_best, o.short_best);
      const eod = dir === "long" ? o.long_eod : o.short_eod;
      const mae = dir === "long" ? o.long_mae : o.short_mae;
      candidates.push({
        symbol: o.symbol,
        assetClass: o.assetClass,
        timestamp: o.timestamp,
        dateKey: o.dateKey,
        bestDirection: dir,
        bestBps: best * 10000,
        eodBps: Number.isFinite(eod) ? eod * 10000 : null,
        maeBps: Number.isFinite(mae) ? mae * 10000 : null,
        h4Trend: o.h4_trend,
        h1Trend: o.h1_trend,
        m15Trend: o.m15_trend,
        h4Adx: o.h4_adx,
        h1Adx: o.h1_adx,
        m15Adx: o.m15_adx,
        m5Adx: o.m5_adx,
        m5Rsi: o.m5_rsi,
        m1Rsi: o.m1_rsi,
        m5BbPb: o.m5_bbPb,
        m5AtrPctRank: o.m5_atrPct_pctRank,
        m15AtrPctRank: o.m15_atrPct_pctRank,
        m1MacdSlope: o.m1_macdHistSlope,
        m5MacdSlope: o.m5_macdHistSlope,
      });
    }
  }
  return candidates.sort((a, b) => b.bestBps - a.bestBps).slice(0, limit);
}

function regimeDiagnostics(observations) {
  const byAsset = new Map();
  for (const o of observations) {
    let bucket = byAsset.get(o.assetClass);
    if (!bucket) {
      bucket = [];
      byAsset.set(o.assetClass, bucket);
    }
    bucket.push(o);
  }

  const summarize = (arr) => {
    const longBest = arr.map((o) => o.long_best * 10000).filter(Number.isFinite);
    const shortBest = arr.map((o) => o.short_best * 10000).filter(Number.isFinite);
    const eodAbs = arr
      .flatMap((o) => [o.long_eod, o.short_eod])
      .filter(Number.isFinite)
      .map((v) => Math.abs(v * 10000));
    return {
      count: arr.length,
      lowPowerPct:
        arr.length
          ? arr.filter((o) => Number.isFinite(o.m5_adx) && Number.isFinite(o.m15_adx) && o.m5_adx < 18 && o.m15_adx < 18).length / arr.length
          : null,
      m5AtrPctRankMedian: median(arr.map((o) => o.m5_atrPct_pctRank).filter(Number.isFinite)),
      m5AdxMedian: median(arr.map((o) => o.m5_adx).filter(Number.isFinite)),
      h1AdxMedian: median(arr.map((o) => o.h1_adx).filter(Number.isFinite)),
      spreadPctRankMedian: median(arr.map((o) => o.spreadPct_pctRank).filter(Number.isFinite)),
      spreadPctMedian: median(arr.map((o) => o.spreadPct).filter(Number.isFinite)),
      longBestMedianBps: median(longBest),
      shortBestMedianBps: median(shortBest),
      eodAbsMedianBps: median(eodAbs),
      h4h1AlignedPct:
        arr.length
          ? arr.filter((o) => Math.abs(o.h4_trend) === 1 && o.h4_trend === o.h1_trend).length / arr.length
          : null,
    };
  };

  return {
    overall: summarize(observations),
    forex: summarize(byAsset.get("forex") || []),
    crypto: summarize(byAsset.get("crypto") || []),
  };
}

function formatPct(x, digits = 1) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "n/a";
}

function formatBps(x) {
  return Number.isFinite(x) ? `${x.toFixed(1)} bps` : "n/a";
}

function printConsoleSummary(report) {
  console.log("=== Price Setup Analysis (backtest/prices JSONL) ===");
  console.log(`Files: ${report.coverage.parsedFiles}`);
  console.log(`Rows parsed: ${report.coverage.totalRows} / ${report.coverage.totalLines} lines (invalid ${report.coverage.invalidLines})`);
  console.log(`Observations with intraday future: ${report.universe.observationCount}`);
  console.log(`Overall low-power share (m5&m15 ADX<18): ${formatPct(report.universe.lowPowerPct)}`);
  console.log("");
  console.log("Asset-class diagnostics:");
  for (const key of ["forex", "crypto"]) {
    const s = report.regimes[key];
    if (!s) continue;
    console.log(
      `- ${key}: n=${s.count}, low-power=${formatPct(s.lowPowerPct)}, m5 ADX med=${s.m5AdxMedian?.toFixed(2) ?? "n/a"}, ` +
        `long best med=${formatBps(s.longBestMedianBps)}, short best med=${formatBps(s.shortBestMedianBps)}, EOD |ret| med=${formatBps(s.eodAbsMedianBps)}`
    );
  }
  console.log("");
  console.log("Top setup rules:");
  for (const r of report.rules.topOverall) {
    console.log(
      `- [${r.direction}] ${r.family} | n=${r.count} | best med=${formatBps(r.bestMedianBps)} | p25=${formatBps(r.bestP25Bps)} | ` +
        `hit40=${formatPct(r.hit40Pct)} | eod mean=${formatBps(r.eodMeanBps)}`
    );
  }
  console.log("");
  console.log("Top moments (oracle same-day opportunity; for pattern mining only):");
  for (const m of report.topMoments.slice(0, 10)) {
    console.log(`- ${m.timestamp} ${m.symbol} ${m.bestDirection} best=${formatBps(m.bestBps)} eod=${formatBps(m.eodBps)} mae=${formatBps(m.maeBps)}`);
  }
}

function main() {
  if (!fs.existsSync(PRICE_DIR)) {
    console.error(`Price dir not found: ${PRICE_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(PRICE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(PRICE_DIR, f))
    .sort();

  const observations = [];
  const symbolSummaries = [];
  const coverage = {
    parsedFiles: 0,
    totalRows: 0,
    invalidLines: 0,
    totalLines: 0,
  };

  for (const file of files) {
    const dataset = parsePriceFile(file);
    const partial = buildObservations([dataset]);
    observations.push(...partial.observations);
    symbolSummaries.push(...partial.symbolSummaries);
    coverage.parsedFiles += partial.coverage.parsedFiles;
    coverage.totalRows += partial.coverage.totalRows;
    coverage.invalidLines += partial.coverage.invalidLines;
    coverage.totalLines += partial.coverage.totalLines;
  }
  addPercentileFeatures(observations);

  const universe = buildUniverseStats(observations);
  const rules = rankRules(observations);
  const regimes = regimeDiagnostics(observations);
  const topObservedMoments = topMoments(observations, 20);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: {
      source: "backtest/prices/*.jsonl",
      method: "Intraday same-day opportunity analysis from minute snapshots with indicator features.",
      outcomeDefinition: {
        long_best: "Best achievable same-day long exit using future bid after entering at current ask.",
        short_best: "Best achievable same-day short cover using future ask after entering at current bid.",
        noMaxHold: "No fixed holding time, but exit restricted to the same UTC calendar day.",
      },
      caveat: "Top moments and best_* metrics use an oracle intraday exit and are for pattern mining, not a directly tradable execution rule.",
    },
    coverage,
    universe,
    regimes,
    symbolSummaries: symbolSummaries.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    rules,
    topMoments: topObservedMoments,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, "price-setup-analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  printConsoleSummary(report);
  console.log("");
  console.log(`Saved detailed report: ${outPath}`);
}

main();
