import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "backtest", "logs");
const REPORT_DIR = path.join(process.cwd(), "backtest", "reports");

const REQUIRED_FIELDS = [
    "dealId",
    "symbol",
    "signal",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "openedAt",
    "status",
    "closeReason",
    "closePrice",
    "closedAt",
    "indicators",
    "indicatorsClose",
];

const NUMERIC_FIELDS = new Set(["entryPrice", "stopLoss", "takeProfit", "closePrice"]);
const DATE_FIELDS = new Set(["openedAt", "closedAt"]);
const TIMEFRAMES = ["d1", "h4", "h1", "m15", "m5", "m1"];

const FEATURE_SPECS = [
    { key: "rsi", path: ["rsi"] },
    { key: "adx", path: ["adx", "adx"] },
    { key: "macd_hist", path: ["macd", "histogram"] },
    { key: "atr", path: ["atr"] },
    { key: "ema9_ema21", compute: (ind) => toNumber(ind.ema9) - toNumber(ind.ema21) },
    { key: "ema20_ema50", compute: (ind) => toNumber(ind.ema20) - toNumber(ind.ema50) },
    { key: "price_vs_ema9", path: ["price_vs_ema9"] },
    { key: "price_vs_ema21", path: ["price_vs_ema21"] },
    { key: "bb_pb", path: ["bb", "pb"] },
    { key: "trend", compute: (ind) => trendToNumber(ind.trend) },
    { key: "isBullishCross", compute: (ind) => boolToNumber(ind.isBullishCross) },
    { key: "isBearishCross", compute: (ind) => boolToNumber(ind.isBearishCross) },
    { key: "backQuantScore", path: ["backQuantScore"] },
    { key: "backQuantSignal", path: ["backQuantSignal"] },
];

function toNumber(value) {
    if (value === undefined || value === null || value === "") return NaN;
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : NaN;
}

function boolToNumber(value) {
    if (value === true) return 1;
    if (value === false) return 0;
    return NaN;
}

function trendToNumber(value) {
    if (value === "bullish") return 1;
    if (value === "bearish") return -1;
    if (value === "neutral") return 0;
    return NaN;
}

function getPathValue(obj, pathParts) {
    let cur = obj;
    for (const part of pathParts) {
        if (!cur || typeof cur !== "object") return undefined;
        cur = cur[part];
    }
    return cur;
}

function normalizeOutcome(closeReason) {
    const reason = String(closeReason || "").toLowerCase();
    if (reason === "hit_tp") return "win";
    if (reason === "hit_sl") return "loss";
    return "other";
}

function summarize(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return {
        n: values.length,
        mean,
        median,
        min: sorted[0],
        max: sorted[sorted.length - 1],
    };
}

function csvEscape(value) {
    if (value === undefined || value === null) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
}

function extractFeatures(indicators) {
    const out = {};
    if (!indicators || typeof indicators !== "object") return out;

    for (const tf of TIMEFRAMES) {
        const ind = indicators[tf];
        if (!ind || typeof ind !== "object") continue;
        for (const spec of FEATURE_SPECS) {
            let value;
            if (spec.compute) {
                value = spec.compute(ind);
            } else {
                value = getPathValue(ind, spec.path);
                value = toNumber(value);
            }
            if (!Number.isFinite(value)) continue;
            out[`${tf}.${spec.key}`] = value;
        }
    }

    return out;
}

function computeDeltas(openFeatures, closeFeatures) {
    const out = {};
    if (!openFeatures || !closeFeatures) return out;
    for (const [key, openValue] of Object.entries(openFeatures)) {
        const closeValue = closeFeatures[key];
        if (!Number.isFinite(openValue) || !Number.isFinite(closeValue)) continue;
        out[`delta.${key}`] = closeValue - openValue;
    }
    return out;
}

function collectLogs() {
    const files = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")) : [];
    const records = [];
    const corrupted = [];

    for (const file of files) {
        const filePath = path.join(LOG_DIR, file);
        const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
        lines.forEach((line, idx) => {
            if (!line.trim()) return;
            try {
                const parsed = JSON.parse(line);
                records.push({ file, line: idx + 1, record: parsed });
            } catch (error) {
                corrupted.push({ file, line: idx + 1, error: error.message });
            }
        });
    }

    return { records, corrupted, files };
}

function auditRecords(records, corrupted) {
    const missingFields = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, 0]));
    const invalidNumeric = {};
    const invalidDate = {};
    const invalidType = {};
    const duplicates = {};
    const openNotClosed = [];
    let indicatorsCloseMissing = 0;
    let indicatorsCloseSameAsOpen = 0;

    const seenDealIds = new Map();

    for (const entry of records) {
        const obj = entry.record;

        for (const field of REQUIRED_FIELDS) {
            if (!(field in obj) || obj[field] === null || obj[field] === "" || obj[field] === undefined) {
                missingFields[field] += 1;
            }
        }

        for (const field of NUMERIC_FIELDS) {
            if (obj[field] === undefined || obj[field] === null || obj[field] === "") continue;
            const num = toNumber(obj[field]);
            if (!Number.isFinite(num)) {
                invalidNumeric[field] = (invalidNumeric[field] || 0) + 1;
            } else if (typeof obj[field] !== "number") {
                invalidType[field] = (invalidType[field] || 0) + 1;
            }
        }

        for (const field of DATE_FIELDS) {
            if (obj[field] === undefined || obj[field] === null || obj[field] === "") continue;
            const ts = Date.parse(obj[field]);
            if (!Number.isFinite(ts)) {
                invalidDate[field] = (invalidDate[field] || 0) + 1;
            }
        }

        if (obj.indicators !== undefined && obj.indicators !== null && typeof obj.indicators !== "object") {
            invalidType.indicators = (invalidType.indicators || 0) + 1;
        }
        if (obj.indicatorsClose !== undefined && obj.indicatorsClose !== null && typeof obj.indicatorsClose !== "object") {
            invalidType.indicatorsClose = (invalidType.indicatorsClose || 0) + 1;
        }

        if (obj.dealId) {
            const prev = seenDealIds.get(obj.dealId);
            if (prev) {
                duplicates[obj.dealId] = duplicates[obj.dealId] || [];
                duplicates[obj.dealId].push({ file: entry.file, line: entry.line });
            } else {
                seenDealIds.set(obj.dealId, { file: entry.file, line: entry.line });
            }
        }

        const hasClose = obj.closedAt && obj.closePrice !== undefined && obj.closePrice !== null && obj.closeReason;
        if (!hasClose) {
            openNotClosed.push({ dealId: obj.dealId, file: entry.file, line: entry.line });
        }

        if (!obj.indicatorsClose) {
            indicatorsCloseMissing += 1;
        } else if (obj.indicators) {
            try {
                const same = JSON.stringify(obj.indicators) === JSON.stringify(obj.indicatorsClose);
                if (same) indicatorsCloseSameAsOpen += 1;
            } catch {
                // ignore
            }
        }
    }

    return {
        corruptedCount: corrupted.length,
        missingFields: Object.fromEntries(Object.entries(missingFields).filter(([, count]) => count > 0)),
        invalidNumeric,
        invalidDate,
        invalidType,
        duplicateDealIds: Object.keys(duplicates).length,
        duplicates,
        openNotClosed,
        indicatorsCloseMissing,
        indicatorsCloseSameAsOpen,
    };
}

function buildReport({ audit, tradeRows, topFeatures, topDeltaFeatures, rules }) {
    const lines = [];
    const outcomes = tradeRows.reduce(
        (acc, row) => {
            acc[row.outcome] = (acc[row.outcome] || 0) + 1;
            return acc;
        },
        { win: 0, loss: 0, other: 0 }
    );

    lines.push("# Trade Log Analysis");
    lines.push("");
    lines.push("## Data Audit");
    lines.push(`- Records: ${tradeRows.length}`);
    lines.push(`- Corrupted lines: ${audit.corruptedCount}`);
    lines.push(`- Duplicate dealIds: ${audit.duplicateDealIds}`);
    lines.push(`- Open trades without close: ${audit.openNotClosed.length}`);
    lines.push(`- indicatorsClose missing: ${audit.indicatorsCloseMissing}`);
    lines.push(`- indicatorsClose identical to open: ${audit.indicatorsCloseSameAsOpen}`);
    lines.push("");
    lines.push("### Missing Fields");
    if (Object.keys(audit.missingFields).length) {
        for (const [field, count] of Object.entries(audit.missingFields)) {
            lines.push(`- ${field}: ${count}`);
        }
    } else {
        lines.push("- None");
    }
    lines.push("");
    lines.push("### Invalid Types");
    if (Object.keys(audit.invalidType).length) {
        for (const [field, count] of Object.entries(audit.invalidType)) {
            lines.push(`- ${field}: ${count}`);
        }
    } else {
        lines.push("- None");
    }
    lines.push("");

    lines.push("## Outcomes & PnL");
    lines.push(`- Wins: ${outcomes.win}, Losses: ${outcomes.loss}, Other: ${outcomes.other}`);
    const pnlWin = summarize(tradeRows.filter((r) => r.outcome === "win").map((r) => r.pnl).filter(Number.isFinite));
    const pnlLoss = summarize(tradeRows.filter((r) => r.outcome === "loss").map((r) => r.pnl).filter(Number.isFinite));
    const rWin = summarize(tradeRows.filter((r) => r.outcome === "win").map((r) => r.R).filter(Number.isFinite));
    const rLoss = summarize(tradeRows.filter((r) => r.outcome === "loss").map((r) => r.R).filter(Number.isFinite));
    lines.push(`- PnL win mean: ${pnlWin?.mean ?? "n/a"}, loss mean: ${pnlLoss?.mean ?? "n/a"}`);
    lines.push(`- R win mean: ${rWin?.mean ?? "n/a"}, loss mean: ${rLoss?.mean ?? "n/a"}`);
    lines.push("");

    lines.push("## Top Feature Differences (Open Indicators)");
    if (!topFeatures.length) {
        lines.push("- Not enough samples to compare features.");
    } else {
        for (const row of topFeatures) {
            lines.push(`- ${row.key}: win=${row.winMean.toFixed(4)} loss=${row.lossMean.toFixed(4)} diff=${row.diff.toFixed(4)} (n=${row.nWin}/${row.nLoss})`);
        }
    }
    lines.push("");

    lines.push("## Top Delta Differences (Close - Open)");
    if (!topDeltaFeatures.length) {
        lines.push("- Not enough samples to compare deltas.");
    } else {
        for (const row of topDeltaFeatures) {
            lines.push(`- ${row.key}: win=${row.winMean.toFixed(4)} loss=${row.lossMean.toFixed(4)} diff=${row.diff.toFixed(4)} (n=${row.nWin}/${row.nLoss})`);
        }
    }
    lines.push("");

    lines.push("## Candidate Rules to Test");
    if (!rules.length) {
        lines.push("- Not enough samples to suggest rules.");
    } else {
        for (const rule of rules) {
            lines.push(`- ${rule.label} | winRate=${(rule.winRate * 100).toFixed(1)}% (n=${rule.total})`);
        }
    }

    return lines.join("\n");
}

function computeFeatureStats(tradeRows) {
    const featureBuckets = {};
    for (const row of tradeRows) {
        if (row.outcome !== "win" && row.outcome !== "loss") continue;
        for (const [key, value] of Object.entries(row.features)) {
            if (!Number.isFinite(value)) continue;
            featureBuckets[key] = featureBuckets[key] || { win: [], loss: [] };
            featureBuckets[key][row.outcome].push(value);
        }
    }

    const featureStats = {};
    for (const [key, bucket] of Object.entries(featureBuckets)) {
        const winSummary = summarize(bucket.win);
        const lossSummary = summarize(bucket.loss);
        if (!winSummary || !lossSummary) continue;
        featureStats[key] = {
            win: winSummary,
            loss: lossSummary,
            diff: winSummary.mean - lossSummary.mean,
        };
    }

    return featureStats;
}

function computeTopFeatures(featureStats, limit = 10) {
    return Object.entries(featureStats)
        .map(([key, stats]) => ({
            key,
            winMean: stats.win.mean,
            lossMean: stats.loss.mean,
            diff: stats.diff,
            nWin: stats.win.n,
            nLoss: stats.loss.n,
        }))
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
        .slice(0, limit);
}

function buildRules(tradeRows, featureStats, limit = 5) {
    const rules = [];
    for (const [key, stats] of Object.entries(featureStats)) {
        const threshold = (stats.win.mean + stats.loss.mean) / 2;
        const direction = stats.win.mean >= stats.loss.mean ? ">=" : "<=";

        let wins = 0;
        let total = 0;
        for (const row of tradeRows) {
            if (row.outcome !== "win" && row.outcome !== "loss") continue;
            const value = row.features[key];
            if (!Number.isFinite(value)) continue;
            const pass = direction === ">=" ? value >= threshold : value <= threshold;
            if (!pass) continue;
            total += 1;
            if (row.outcome === "win") wins += 1;
        }

        if (total < 3) continue;
        rules.push({
            label: `${key} ${direction} ${threshold.toFixed(4)}`,
            winRate: wins / total,
            total,
        });
    }

    return rules.sort((a, b) => b.winRate - a.winRate || b.total - a.total).slice(0, limit);
}

function run() {
    const { records, corrupted, files } = collectLogs();
    const audit = auditRecords(records, corrupted);

    const tradeRows = records.map(({ record }) => {
        const outcome = normalizeOutcome(record.closeReason);

        const entryPrice = toNumber(record.entryPrice);
        const closePrice = toNumber(record.closePrice);
        const stopLoss = toNumber(record.stopLoss);
        const signal = String(record.signal || "").toUpperCase();

        let pnl = NaN;
        if (Number.isFinite(entryPrice) && Number.isFinite(closePrice)) {
            pnl = signal === "BUY" ? closePrice - entryPrice : signal === "SELL" ? entryPrice - closePrice : NaN;
        }

        const risk = Number.isFinite(entryPrice) && Number.isFinite(stopLoss) ? Math.abs(entryPrice - stopLoss) : NaN;
        const R = Number.isFinite(risk) && risk > 0 && Number.isFinite(pnl) ? pnl / risk : NaN;

        const openFeatures = extractFeatures(record.indicators);
        const closeFeatures = extractFeatures(record.indicatorsClose);
        const deltas = computeDeltas(openFeatures, closeFeatures);

        return {
            dealId: record.dealId,
            symbol: record.symbol,
            signal: record.signal,
            entryPrice: record.entryPrice,
            stopLoss: record.stopLoss,
            takeProfit: record.takeProfit,
            openedAt: record.openedAt,
            status: record.status,
            closeReason: record.closeReason,
            closePrice: record.closePrice,
            closedAt: record.closedAt,
            outcome,
            pnl,
            risk,
            R,
            features: { ...openFeatures, ...deltas },
        };
    });

    const featureStats = computeFeatureStats(tradeRows);
    const openFeatureStats = Object.fromEntries(Object.entries(featureStats).filter(([key]) => !key.startsWith("delta.")));
    const deltaFeatureStats = Object.fromEntries(Object.entries(featureStats).filter(([key]) => key.startsWith("delta.")));
    const topFeatures = computeTopFeatures(openFeatureStats, 10);
    const topDeltaFeatures = computeTopFeatures(deltaFeatureStats, 10);
    const rules = buildRules(tradeRows, openFeatureStats, 5);

    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const csvColumns = [
        "dealId",
        "symbol",
        "signal",
        "entryPrice",
        "stopLoss",
        "takeProfit",
        "openedAt",
        "status",
        "closeReason",
        "closePrice",
        "closedAt",
        "outcome",
        "pnl",
        "risk",
        "R",
    ];

    const featureColumns = Array.from(
        tradeRows.reduce((set, row) => {
            Object.keys(row.features).forEach((key) => set.add(key));
            return set;
        }, new Set())
    ).sort();

    const columns = [...csvColumns, ...featureColumns];
    const csvLines = [columns.join(",")];

    for (const row of tradeRows) {
        const line = columns.map((col) => csvEscape(row[col] ?? row.features[col]));
        csvLines.push(line.join(","));
    }

    const csvPath = path.join(REPORT_DIR, "trade_summary.csv");
    fs.writeFileSync(csvPath, csvLines.join("\n"));

    const report = buildReport({ audit, tradeRows, topFeatures, topDeltaFeatures, rules });
    const reportPath = path.join(REPORT_DIR, "trade_report.md");
    fs.writeFileSync(reportPath, report);

    console.log(`Processed ${tradeRows.length} records from ${files.length} files.`);
    console.log(`Report: ${reportPath}`);
    console.log(`CSV: ${csvPath}`);
    console.log("\nTop rules to test:");
    if (!rules.length) {
        console.log("  (not enough samples)");
    } else {
        rules.forEach((rule) => {
            console.log(`  - ${rule.label} | winRate ${(rule.winRate * 100).toFixed(1)}% (n=${rule.total})`);
        });
    }
}

run();
