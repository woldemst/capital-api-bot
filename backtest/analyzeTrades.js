import fs from "fs";
import path from "path";

const DATA_DIR = "./data";
const OUTPUT_DIR = "./analysis";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"];
const MAX_DIFF_MS = 2 * 60 * 1000; // 2 minutes in milliseconds

function loadAndSortData(symbol, timeframe) {
    const filePath = path.join(DATA_DIR, symbol, `${symbol}_${timeframe}.json`);
    if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ File not found: ${filePath}`);
        return [];
    }
    const raw = fs.readFileSync(filePath, "utf8");
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        console.error(`❌ Failed to parse JSON from ${filePath}`);
        return [];
    }
    // Normalize: if entry has .timestamp but not .time, copy .timestamp into .time
    for (const entry of data) {
        if (!('time' in entry) && ('timestamp' in entry)) {
            entry.time = entry.timestamp;
        }
    }
    data.sort((a, b) => new Date(a.time) - new Date(b.time));
    return data;
}

function findClosestIndex(arr, targetTime) {
    let left = 0;
    let right = arr.length - 1;
    let bestIndex = -1;
    let bestDiff = Infinity;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midTime = new Date(arr[mid].time).getTime();
        const diff = Math.abs(midTime - targetTime);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIndex = mid;
        }
        if (midTime < targetTime) {
            left = mid + 1;
        } else if (midTime > targetTime) {
            right = mid - 1;
        } else {
            break;
        }
    }

    return bestDiff <= MAX_DIFF_MS ? bestIndex : -1;
}

function mergeTimeframes(symbol) {
    console.log(`🔍 Loading data for symbol: ${symbol}`);
    const dataByTF = {};
    for (const tf of TIMEFRAMES) {
        dataByTF[tf] = loadAndSortData(symbol, tf);
        console.log(`  - Loaded ${dataByTF[tf].length} entries for ${tf}`);
    }

    // Determine overlapping date range among all timeframes
    const earliestTimes = [];
    const latestTimes = [];
    for (const tf of TIMEFRAMES) {
        const data = dataByTF[tf];
        if (data.length === 0) {
            // If any timeframe has no data, overlapping range is empty
            console.error(`❌ No data for timeframe ${tf}, cannot determine overlapping range.`);
            return [];
        }
        earliestTimes.push(new Date(data[0].time).getTime());
        latestTimes.push(new Date(data[data.length - 1].time).getTime());
    }
    const overlapStart = Math.max(...earliestTimes);
    const overlapEnd = Math.min(...latestTimes);
    if (overlapStart > overlapEnd) {
        console.error("❌ No overlapping date range among timeframes. Aborting.");
        return [];
    }

    // Filter each timeframe data to the overlapping date range
    for (const tf of TIMEFRAMES) {
        dataByTF[tf] = dataByTF[tf].filter(entry => {
            const t = new Date(entry.time).getTime();
            return t >= overlapStart && t <= overlapEnd;
        });
        if (dataByTF[tf].length === 0) {
            console.error(`❌ No data for timeframe ${tf} after filtering to overlapping range.`);
            return [];
        }
    }

    // Use the smallest timeframe (M1) as the base timeline
    const baseData = dataByTF["M1"];
    if (!baseData.length) {
        console.error("❌ No base timeframe data (M1) available. Aborting.");
        return [];
    }

    const merged = [];

    for (const baseEntry of baseData) {
        const baseTime = new Date(baseEntry.time).getTime();
        const combinedEntry = { time: baseEntry.time, M1: baseEntry };

        for (const tf of TIMEFRAMES) {
            if (tf === "M1") continue;
            const tfData = dataByTF[tf];
            if (!tfData.length) {
                combinedEntry[tf] = null;
                continue;
            }
            const idx = findClosestIndex(tfData, baseTime);
            combinedEntry[tf] = idx >= 0 ? tfData[idx] : null;
        }

        merged.push(combinedEntry);
    }

    return merged;
}

function main() {
    // 1. Detect all symbol names dynamically by reading subdirectories in ./data
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const symbolSet = new Set();
    for (const entry of entries) {
        if (entry.isDirectory()) {
            symbolSet.add(entry.name);
        }
    }
    const symbols = Array.from(symbolSet);
    if (symbols.length === 0) {
        console.error("❌ No symbol directories found in data directory.");
        return;
    }

    console.log(`🔎 Found ${symbols.length} symbol(s): ${symbols.join(", ")}`);
    for (const symbol of symbols) {
        console.log(`\n=== Processing symbol: ${symbol} ===`);
        const mergedData = mergeTimeframes(symbol);
        if (!mergedData.length) {
            console.error(`❌ No merged data created for ${symbol}.`);
            continue;
        }
        const outPath = path.join(OUTPUT_DIR, `${symbol}_combined.jsonl`);
        const stream = fs.createWriteStream(outPath, { encoding: "utf8" });
        for (const entry of mergedData) {
            stream.write(JSON.stringify(entry) + "\n");
        }
        stream.end();
        stream.on("finish", () => {
            console.log(`✅ Merged dataset saved to: ${outPath} (JSONL format, one JSON object per line)`);
        });
    }
}

main();