/**
 * findProfitableCandles.js
 * ---------------------------------------
 * This script scans through candle data (e.g. M5 timeframe)
 * and finds candles that would have produced a profitable trade
 * within the next 1–4 candles using simple SL/TP logic.
 *
 * Usage:
 *   node findProfitableCandles.js candles_m5.json
 *
 * Output:
 *   profitable_m5.json
 */

import fs from "fs";

const INPUT_FILE = process.argv[2];
const OUTPUT_FILE = "profitable_m5.json";

// risk/reward parameters
const RR_RATIO = 1.5; // TP = SL * RR_RATIO
const MAX_LOOKAHEAD = 4; // how many candles ahead to check

// helper function to check if a candle was bullish/bearish
function getDirection(candle) {
    return candle.close > candle.open ? "bullish" : candle.close < candle.open ? "bearish" : null;
}

// main async process
(async () => {
    try {
        if (!fs.existsSync(INPUT_FILE)) {
            console.error(`❌ Input file not found: ${INPUT_FILE}`);
            process.exit(1);
        }

        console.log(`📥 Reading candles from ${INPUT_FILE}...`);
        const raw = fs.readFileSync(INPUT_FILE, "utf8");
        const candles = JSON.parse(raw);
        console.log(`Loaded ${candles.length} candles`);

        const profitable = [];

        for (let i = 0; i < candles.length - MAX_LOOKAHEAD; i++) {
            const c = candles[i];
            const dir = getDirection(c);
            if (!dir || !c.atr) continue; // skip dojis or invalid ATR

            // define SL and TP
            const entry = c.close;
            let sl, tp;
            if (dir === "bullish") {
                sl = c.low - c.atr;
                tp = entry + c.atr * RR_RATIO;
            } else {
                sl = c.high + c.atr;
                tp = entry - c.atr * RR_RATIO;
            }

            // check next candles for hit
            let result = "none";
            for (let j = 1; j <= MAX_LOOKAHEAD; j++) {
                const next = candles[i + j];
                if (!next) break;

                if (dir === "bullish") {
                    if (next.low <= sl) {
                        result = "loss";
                        break;
                    }
                    if (next.high >= tp) {
                        result = "win";
                        break;
                    }
                } else {
                    if (next.high >= sl) {
                        result = "loss";
                        break;
                    }
                    if (next.low <= tp) {
                        result = "win";
                        break;
                    }
                }
            }

            if (result === "win") {
                profitable.push({
                    index: i,
                    timestamp: c.timestamp,
                    direction: dir,
                    entry,
                    sl,
                    tp,
                    atr: c.atr,
                    rsi: c.rsi,
                    emaFast: c.emaFast,
                    emaSlow: c.emaSlow,
                    adx: c.adx?.adx,
                    bb: c.bb,
                    profitAfterCandles: MAX_LOOKAHEAD,
                });
            }
        }

        console.log(`✅ Found ${profitable.length} profitable signals`);

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(profitable, null, 2));
        console.log(`💾 Saved to ${OUTPUT_FILE}`);
    } catch (err) {
        console.error("❌ Error while processing:", err);
    }
})();
