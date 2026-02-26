import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "backtest", "logs");
const REPORT_DIR = path.join(process.cwd(), "backtest", "reports");

const DEFAULT_RISK_PCT = 0.005;
const DEFAULT_CRYPTO_RISK_PCT = 0.004;
const CRYPTO_HINTS = ["BTC", "ETH", "DOGE", "SOL", "XRP", "ADA", "LTC"];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isCrypto(symbol) {
  const s = String(symbol || "").toUpperCase();
  return CRYPTO_HINTS.some((x) => s.includes(x));
}

function median(values) {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

function sum(values) {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

function parseTrade(entry) {
  if (!entry || String(entry.status || "").toLowerCase() !== "closed") return null;
  const closedAt = String(entry.closedAt || "");
  const closedAtMs = Date.parse(closedAt);
  if (!Number.isFinite(closedAtMs)) return null;

  const symbol = String(entry.symbol || "");
  const signal = String(entry.signal || entry.side || "").toUpperCase();
  const entryPrice = toNum(entry.entryPrice ?? entry.level);
  const stopLoss = toNum(entry.stopLoss ?? entry.stopLevel);
  const closePrice = toNum(entry.closePrice ?? entry.closeLevel);

  let rMultiple = null;
  if ((signal === "BUY" || signal === "SELL") && entryPrice !== null && stopLoss !== null && closePrice !== null) {
    const riskDist = Math.abs(entryPrice - stopLoss);
    if (riskDist > 0) {
      const pnlDist = signal === "BUY" ? closePrice - entryPrice : entryPrice - closePrice;
      rMultiple = pnlDist / riskDist;
    }
  }

  const riskPct =
    toNum(entry?.riskMeta?.riskPct) ??
    toNum(entry?.riskPctConfigured) ??
    (isCrypto(symbol) ? DEFAULT_CRYPTO_RISK_PCT : DEFAULT_RISK_PCT);

  const estimatedPnlPct = Number.isFinite(rMultiple) && Number.isFinite(riskPct) ? rMultiple * riskPct : null;
  const fallbackPnlPct = toNum(entry?.tradeStats?.pnlPct);
  const pnlPct = Number.isFinite(estimatedPnlPct) ? estimatedPnlPct : Number.isFinite(fallbackPnlPct) ? fallbackPnlPct / 100 : null;

  return {
    dealId: String(entry.dealId || ""),
    symbol,
    signal,
    closeReason: String(entry.closeReason || "unknown"),
    closedAt,
    closedAtMs,
    day: new Date(closedAtMs).toISOString().slice(0, 10),
    rMultiple,
    riskPct,
    pnlPct,
    pnlPoints: toNum(entry?.tradeStats?.pnlPoints),
    holdMinutes: toNum(entry?.tradeStats?.holdMinutes),
  };
}

function loadClosedTrades() {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  const trades = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, file), "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const t = parseTrade(obj);
      if (t) trades.push(t);
    }
  }
  trades.sort((a, b) => a.closedAtMs - b.closedAtMs);
  return trades;
}

function metrics(trades) {
  const n = trades.length;
  const pnlSeries = trades.map((t) => t.pnlPct).filter(Number.isFinite);
  const wins = trades.filter((t) => Number.isFinite(t.pnlPct) && t.pnlPct > 0);
  const losses = trades.filter((t) => Number.isFinite(t.pnlPct) && t.pnlPct < 0);
  const breakeven = trades.filter((t) => Number.isFinite(t.pnlPct) && t.pnlPct === 0);

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let currentLossStreak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    if (Number.isFinite(t.pnlPct)) {
      equity *= 1 + t.pnlPct;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? (equity - peak) / peak : 0;
      if (dd < maxDd) maxDd = dd;
      if (t.pnlPct < 0) {
        currentLossStreak += 1;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      } else if (t.pnlPct > 0) {
        currentLossStreak = 0;
      }
    }
  }

  const grossProfit = sum(wins.map((t) => t.pnlPct));
  const grossLossAbs = Math.abs(sum(losses.map((t) => t.pnlPct)));
  const pf = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;
  const expectancyPct = pnlSeries.length ? sum(pnlSeries) / pnlSeries.length : null;

  const rVals = trades.map((t) => t.rMultiple).filter(Number.isFinite);

  return {
    count: n,
    analyzableCount: pnlSeries.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: pnlSeries.length ? wins.length / pnlSeries.length : null,
    profitFactor: pf,
    expectancyPct,
    netPnlPct: pnlSeries.length ? sum(pnlSeries) : null,
    medianPnlPct: median(pnlSeries),
    medianR: median(rVals),
    maxDrawdownPct: maxDd,
    maxLossStreak,
    medianHoldMinutes: median(trades.map((t) => t.holdMinutes).filter(Number.isFinite)),
  };
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(item);
  }
  return m;
}

function buildSplitMetrics(trades) {
  const days = [...new Set(trades.map((t) => t.day))].sort();
  if (days.length < 4) return null;
  const splitIdx = Math.floor(days.length * 0.7);
  const trainDays = new Set(days.slice(0, splitIdx));
  const testDays = new Set(days.slice(splitIdx));
  const train = trades.filter((t) => trainDays.has(t.day));
  const test = trades.filter((t) => testDays.has(t.day));
  return {
    trainDays: [...trainDays],
    testDays: [...testDays],
    train: metrics(train),
    test: metrics(test),
  };
}

function formatPct(x, digits = 2) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "n/a";
}

function main() {
  const trades = loadClosedTrades();
  const overall = metrics(trades);
  const bySymbol = [...groupBy(trades, (t) => t.symbol).entries()]
    .map(([symbol, rows]) => ({ symbol, ...metrics(rows) }))
    .sort((a, b) => (b.count - a.count) || ((b.netPnlPct ?? -Infinity) - (a.netPnlPct ?? -Infinity)));

  const byReason = [...groupBy(trades, (t) => t.closeReason || "unknown").entries()]
    .map(([closeReason, rows]) => ({ closeReason, count: rows.length, ...metrics(rows) }))
    .sort((a, b) => b.count - a.count);

  const split = buildSplitMetrics(trades);
  const report = {
    generatedAt: new Date().toISOString(),
    scope: "backtest/logs/*.jsonl closed trades",
    assumptions: {
      pnlPct: "Uses riskMeta+r-multiple when available; falls back to tradeStats.pnlPct.",
      split: "70/30 split by unique close dates (not a full walk-forward simulation).",
    },
    overall,
    bySymbol,
    byReason,
    split,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, "trade-log-analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== Trade Log Analysis ===");
  console.log(`Closed trades: ${overall.count} (analyzable=${overall.analyzableCount})`);
  console.log(
    `WinRate=${formatPct(overall.winRate)} PF=${Number.isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : "n/a"} ` +
      `Expectancy=${formatPct(overall.expectancyPct)} Net=${formatPct(overall.netPnlPct)} MaxDD=${formatPct(overall.maxDrawdownPct)} ` +
      `MaxLossStreak=${overall.maxLossStreak}`
  );
  console.log("Top symbols:");
  for (const s of bySymbol.slice(0, 8)) {
    console.log(
      `- ${s.symbol}: n=${s.count}, winRate=${formatPct(s.winRate)}, PF=${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "n/a"}, ` +
        `net=${formatPct(s.netPnlPct)}, maxDD=${formatPct(s.maxDrawdownPct)}`
    );
  }
  if (split) {
    console.log("70/30 date split:");
    console.log(
      `- train: n=${split.train.count}, winRate=${formatPct(split.train.winRate)}, PF=${
        Number.isFinite(split.train.profitFactor) ? split.train.profitFactor.toFixed(2) : "n/a"
      }, net=${formatPct(split.train.netPnlPct)}`
    );
    console.log(
      `- test: n=${split.test.count}, winRate=${formatPct(split.test.winRate)}, PF=${
        Number.isFinite(split.test.profitFactor) ? split.test.profitFactor.toFixed(2) : "n/a"
      }, net=${formatPct(split.test.netPnlPct)}`
    );
  }
  console.log(`Saved detailed report: ${outPath}`);
}

main();
