import fs from "node:fs";
import path from "node:path";
import { SESSION_SYMBOLS, CRYPTO_SYMBOLS } from "../intraday/config.js";

const PRICE_DIR = path.join(process.cwd(), "backtest", "prices");
const REPORT_DIR = path.join(process.cwd(), "backtest", "reports");
const TARGET_UNIVERSE = new Set(
  [...Object.values(SESSION_SYMBOLS).flat(), ...CRYPTO_SYMBOLS].map((s) => String(s).toUpperCase())
);

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function quantile(values, q) {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)));
  return arr[idx];
}

function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function loadPriceFile(filePath) {
  const symbol = path.basename(filePath, ".jsonl").toUpperCase();
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(raw.timestamp || "");
    if (!Number.isFinite(ts)) continue;
    const bid = toNum(raw.bid);
    const ask = toNum(raw.ask);
    const mid = toNum(raw.mid) ?? ([bid, ask].every(Number.isFinite) ? (bid + ask) / 2 : bid ?? ask);
    if (!Number.isFinite(mid)) continue;
    rows.push({
      symbol,
      ts,
      timestamp: new Date(ts).toISOString(),
      dateKey: new Date(ts).toISOString().slice(0, 10),
      hourUtc: new Date(ts).getUTCHours(),
      minuteUtc: new Date(ts).getUTCMinutes(),
      bid,
      ask,
      mid,
      spread: toNum(raw.spread) ?? ([bid, ask].every(Number.isFinite) ? ask - bid : null),
      sessions: Array.isArray(raw.sessions) ? raw.sessions.map((x) => String(x).toUpperCase()) : [],
      newsBlocked: Boolean(raw.newsBlocked),
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function computeSameDayOpportunity(rows) {
  const byDay = groupBy(rows, (r) => r.dateKey);
  const out = [];

  for (const dayRows of byDay.values()) {
    const futureMaxBid = new Array(dayRows.length).fill(null);
    const futureMinAsk = new Array(dayRows.length).fill(null);
    let maxBid = -Infinity;
    let minAsk = Infinity;
    for (let i = dayRows.length - 1; i >= 0; i -= 1) {
      const r = dayRows[i];
      if (Number.isFinite(r.bid) && r.bid > maxBid) maxBid = r.bid;
      if (Number.isFinite(r.ask) && r.ask < minAsk) minAsk = r.ask;
      futureMaxBid[i] = Number.isFinite(maxBid) ? maxBid : null;
      futureMinAsk[i] = Number.isFinite(minAsk) ? minAsk : null;
    }

    for (let i = 0; i < dayRows.length; i += 1) {
      const r = dayRows[i];
      const longBest = Number.isFinite(r.ask) && Number.isFinite(futureMaxBid[i]) && r.ask > 0 ? (futureMaxBid[i] - r.ask) / r.ask : null;
      const shortBest = Number.isFinite(r.bid) && Number.isFinite(futureMinAsk[i]) && r.bid > 0 ? (r.bid - futureMinAsk[i]) / r.bid : null;
      const bestDirection =
        Number.isFinite(longBest) && Number.isFinite(shortBest) ? (longBest >= shortBest ? "LONG" : "SHORT")
        : Number.isFinite(longBest) ? "LONG"
        : Number.isFinite(shortBest) ? "SHORT"
        : null;
      const bestRet = bestDirection === "LONG" ? longBest : bestDirection === "SHORT" ? shortBest : null;
      out.push({
        ...r,
        longBest,
        shortBest,
        bestDirection,
        bestRet,
      });
    }
  }

  return out;
}

function summarizeBucket(key, rows) {
  const bestBps = rows.map((r) => (Number.isFinite(r.bestRet) ? r.bestRet * 10000 : null)).filter(Number.isFinite);
  const longBps = rows.map((r) => (Number.isFinite(r.longBest) ? r.longBest * 10000 : null)).filter(Number.isFinite);
  const shortBps = rows.map((r) => (Number.isFinite(r.shortBest) ? r.shortBest * 10000 : null)).filter(Number.isFinite);
  const spreadBps = rows
    .map((r) => (Number.isFinite(r.spread) && Number.isFinite(r.mid) && r.mid > 0 ? (r.spread / r.mid) * 10000 : null))
    .filter(Number.isFinite);

  return {
    key,
    count: rows.length,
    bestMedianBps: median(bestBps),
    bestMeanBps: mean(bestBps),
    bestP25Bps: quantile(bestBps, 0.25),
    bestP75Bps: quantile(bestBps, 0.75),
    longMedianBps: median(longBps),
    shortMedianBps: median(shortBps),
    spreadMedianBps: median(spreadBps),
    newsBlockedPct: rows.length ? rows.filter((r) => r.newsBlocked).length / rows.length : null,
    longWinsPct: rows.length ? rows.filter((r) => r.bestDirection === "LONG").length / rows.length : null,
    shortWinsPct: rows.length ? rows.filter((r) => r.bestDirection === "SHORT").length / rows.length : null,
  };
}

function formatBps(x) {
  return Number.isFinite(x) ? `${x.toFixed(1)} bps` : "n/a";
}

function formatPct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

function main() {
  if (!fs.existsSync(PRICE_DIR)) {
    console.error(`Price dir not found: ${PRICE_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(PRICE_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  const allObs = [];
  const perFileCoverage = [];
  const includeAllSymbols = String(process.env.ANALYZE_ALL_SYMBOLS || "").toLowerCase() === "true";
  const skippedSymbols = [];

  for (const file of files) {
    const symbol = path.basename(file, ".jsonl").toUpperCase();
    if (!includeAllSymbols && !TARGET_UNIVERSE.has(symbol)) {
      skippedSymbols.push(symbol);
      continue;
    }
    const rows = loadPriceFile(path.join(PRICE_DIR, file));
    const obs = computeSameDayOpportunity(rows);
    allObs.push(...obs);
    perFileCoverage.push({ symbol, rows: rows.length, observations: obs.length });
  }

  const bySymbol = [...groupBy(allObs, (r) => r.symbol).entries()]
    .map(([key, rows]) => summarizeBucket(key, rows))
    .sort((a, b) => (b.bestMedianBps ?? -Infinity) - (a.bestMedianBps ?? -Infinity));

  const byHour = [...groupBy(allObs, (r) => String(r.hourUtc).padStart(2, "0")).entries()]
    .map(([key, rows]) => summarizeBucket(key, rows))
    .sort((a, b) => (b.bestMedianBps ?? -Infinity) - (a.bestMedianBps ?? -Infinity));

  const bySymbolHour = [...groupBy(allObs, (r) => `${r.symbol}@${String(r.hourUtc).padStart(2, "0")}Z`).entries()]
    .map(([key, rows]) => summarizeBucket(key, rows))
    .filter((r) => r.count >= 30)
    .sort((a, b) => {
      const byMed = (b.bestMedianBps ?? -Infinity) - (a.bestMedianBps ?? -Infinity);
      if (byMed !== 0) return byMed;
      return b.count - a.count;
    });

  const bySession = [...groupBy(
    allObs.flatMap((r) => (r.sessions.length ? r.sessions.map((s) => ({ ...r, session: s })) : [{ ...r, session: "NONE" }])),
    (r) => r.session
  ).entries()]
    .map(([key, rows]) => summarizeBucket(key, rows))
    .sort((a, b) => (b.bestMedianBps ?? -Infinity) - (a.bestMedianBps ?? -Infinity));

  const report = {
    generatedAt: new Date().toISOString(),
    scope: "backtest/prices/*.jsonl same-day oracle opportunity by symbol/hour/session (pattern mining, not tradable exits)",
    universe: {
      mode: includeAllSymbols ? "ALL_LOGGED_SYMBOLS" : "TARGET_UNIVERSE_ONLY",
      targetSymbols: [...TARGET_UNIVERSE].sort(),
      skippedSymbols,
    },
    coverage: {
      files: files.length,
      observations: allObs.length,
      perFileCoverage,
    },
    bySymbol,
    byHourUtc: byHour,
    bySession,
    topSymbolHourWindows: bySymbolHour.slice(0, 100),
    topMoments: allObs
      .filter((r) => Number.isFinite(r.bestRet))
      .sort((a, b) => (b.bestRet - a.bestRet))
      .slice(0, 30)
      .map((r) => ({
        symbol: r.symbol,
        timestamp: r.timestamp,
        hourUtc: r.hourUtc,
        sessions: r.sessions,
        bestDirection: r.bestDirection,
        bestBps: r.bestRet * 10000,
        longBps: Number.isFinite(r.longBest) ? r.longBest * 10000 : null,
        shortBps: Number.isFinite(r.shortBest) ? r.shortBest * 10000 : null,
        newsBlocked: r.newsBlocked,
      })),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, "price-window-profitability.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("=== Price Window Profitability (same-day oracle opportunity) ===");
  console.log(`Universe mode: ${includeAllSymbols ? "ALL_LOGGED_SYMBOLS" : "TARGET_UNIVERSE_ONLY"}`);
  console.log(`Files discovered: ${files.length}, included symbols: ${perFileCoverage.length}, observations: ${allObs.length}`);
  if (skippedSymbols.length) {
    console.log(`Skipped (outside target universe): ${skippedSymbols.join(", ")}`);
  }
  console.log("Top symbols by median opportunity:");
  for (const row of bySymbol.slice(0, 10)) {
    console.log(
      `- ${row.key}: n=${row.count}, bestMed=${formatBps(row.bestMedianBps)}, p25=${formatBps(row.bestP25Bps)}, ` +
      `longMed=${formatBps(row.longMedianBps)}, shortMed=${formatBps(row.shortMedianBps)}, spreadMed=${formatBps(row.spreadMedianBps)}`
    );
  }
  console.log("Top UTC hours:");
  for (const row of byHour.slice(0, 8)) {
    console.log(
      `- ${row.key}: n=${row.count}, bestMed=${formatBps(row.bestMedianBps)}, longWin=${formatPct(row.longWinsPct)}, shortWin=${formatPct(row.shortWinsPct)}`
    );
  }
  console.log("Top symbol-hour windows (min 30 obs):");
  for (const row of bySymbolHour.slice(0, 15)) {
    console.log(`- ${row.key}: n=${row.count}, bestMed=${formatBps(row.bestMedianBps)}, p25=${formatBps(row.bestP25Bps)}`);
  }
  console.log(`Saved report: ${outPath}`);
}

main();
