import fs from "fs";
import path from "path";

const DATA_DIR = "./data";
const OUTPUT_DIR = "./analysis";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Only required timeframes
const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"];

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

function findPreviousIndex(arr, targetTime) {
    // find the most recent candle before (or exactly at) the target time
    let left = 0;
    let right = arr.length - 1;
    let result = -1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midTime = new Date(arr[mid].time).getTime();

        if (midTime <= targetTime) {
            result = mid;       // candidate found
            left = mid + 1;     // try to find a later one
        } else {
            right = mid - 1;
        }
    }

    return result; // -1 if none before target
}

function mergeTimeframes(symbol) {
    console.log(`🔍 Loading data for symbol: ${symbol}`);
    const dataByTF = {};
    const missingTFs = [];
    for (const tf of TIMEFRAMES) {
        dataByTF[tf] = loadAndSortData(symbol, tf);
        console.log(`  - Loaded ${dataByTF[tf].length} entries for ${tf}`);
        if (dataByTF[tf].length === 0) {
            missingTFs.push(tf);
        }
    }

    // Require M1, M5, M15, H1 to be present (guarantee inclusion, but allow nulls for missing)
    if (missingTFs.length > 0) {
        console.warn(`⚠️ The following required timeframes have NO data and will be filled as null: ${missingTFs.join(", ")}`);
    }

    // Use the smallest timeframe (M1) as the base timeline
    const baseData = dataByTF["M1"];
    if (!baseData || !baseData.length) {
        console.error("❌ No base timeframe data (M1) available. Aborting.");
        return [];
    }

    // For reference: find earliest/latest among available timeframes (for info)
    const availableTFs = TIMEFRAMES.filter(tf => dataByTF[tf] && dataByTF[tf].length > 0);
    if (availableTFs.length < TIMEFRAMES.length) {
        console.warn(`⚠️ Some required timeframes have missing data. Merged dataset will have nulls for those.`);
    }
    const earliestTimes = [];
    const latestTimes = [];
    for (const tf of availableTFs) {
        const data = dataByTF[tf];
        earliestTimes.push(new Date(data[0].time).getTime());
        latestTimes.push(new Date(data[data.length - 1].time).getTime());
    }
    const overlapStart = Math.max(...earliestTimes);
    const overlapEnd = Math.min(...latestTimes);
    if (overlapStart > overlapEnd) {
        console.warn("⚠️ No overlapping date range among available timeframes. Proceeding with full M1 range, filling missing as nulls.");
    }

    // Merge: for each M1 bar, find closest in other timeframes, fill null if not found or timeframe missing
    const merged = [];
    for (const baseEntry of baseData) {
        const baseTime = new Date(baseEntry.time).getTime();
        const combinedEntry = { time: baseEntry.time, M1: baseEntry };

        for (const tf of TIMEFRAMES) {
            if (tf === "M1") continue;
            const tfData = dataByTF[tf];
            if (!tfData || tfData.length === 0) {
                combinedEntry[tf] = null;
                continue;
            }
            const idx = findPreviousIndex(tfData, baseTime);
            combinedEntry[tf] = idx >= 0 ? tfData[idx] : null;
        }
        merged.push(combinedEntry);
    }

    // Info log: show how many merged entries, and which timeframes had missing data
    console.log(`✅ Merged ${merged.length} entries for ${symbol}.`);
    if (missingTFs.length > 0) {
        console.log(`ℹ️ Merged data contains nulls for missing timeframes: ${missingTFs.join(", ")}`);
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