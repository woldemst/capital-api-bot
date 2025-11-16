// backtest/loadCombinedData.js
import fs from "fs";
import readline from "readline";

/**
 * Streams a combined JSONL file and yields parsed candles.
 *
 * Yields:
 * {
 *   timestamp,
 *   M1: {...},
 *   M5: {...},
 *   M15: {...},
 *   H1: {...},
 *   H4: {...}
 * }
 */
export async function* loadCombinedData(jsonlPath) {
    const fileStream = fs.createReadStream(jsonlPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;

        let obj;
        try {
            obj = JSON.parse(line);
        } catch (err) {
            console.warn(`[loadCombinedData] Bad JSON: ${err.message}`);
            continue;
        }

        const timestamp = obj.time || obj.M1?.timestamp || obj.M5?.timestamp;
        if (!timestamp) continue;

        yield {
            timestamp,
            M1: obj.M1 || null,
            M5: obj.M5 || null,
            M15: obj.M15 || null,
            H1: obj.H1 || null,
            H4: obj.H4 || null,
        };
    }
}
