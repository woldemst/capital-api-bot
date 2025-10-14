import fs from "fs";
import path from "path";

// --- Config ---
const signalsDir = "./results";
const outputDir = "./analysis";
const profitableDir = "./analysis_profitable"; // 👈 new folder for profitable trades
const profitThreshold = 0;

// Risk parameters
const RISK_PER_TRADE = 0.02; // 2% risk per trade
const REWARD_RATIO = 1.8;    // Reward:Risk ratio

// Ensure profitable folder exists
if (!fs.existsSync(profitableDir)) fs.mkdirSync(profitableDir, { recursive: true });

function calculateTradeResult(trade) {
    const { signal, M15, H1, H4 } = trade;
    if (!signal || !M15) return null;

    // Get entry price
    const entryPrice = signal === "BUY" ? M15.high : M15.low;

    
    // Calculate SL based on ATR or structure
    const atr = H1.atr || 0.0010; // default to 10 pips if missing
    const stopLoss = signal === "BUY" 
        ? entryPrice - (atr * 1.5)
        : entryPrice + (atr * 1.5);

    // Calculate TP
    const slDistance = Math.abs(entryPrice - stopLoss);
    const takeProfit = signal === "BUY"
        ? entryPrice + (slDistance * REWARD_RATIO)
        : entryPrice - (slDistance * REWARD_RATIO);

    // Add trade details
    return {
        ...trade,
        entry: entryPrice,
        sl: stopLoss,
        tp: takeProfit,
        slPips: slDistance * (trade.symbol?.includes("JPY") ? 100 : 10000),
        tpPips: slDistance * REWARD_RATIO * (trade.symbol?.includes("JPY") ? 100 : 10000),
        setup: {
            h4Trend: H4.emaFast > H4.emaSlow ? "bullish" : "bearish",
            h1Signal: H1.ema9 > H1.ema21 ? "bullish" : "bearish",
            m15Rsi: M15.rsi,
            h1Rsi: H1.rsi,
            atr: atr
        }
    };
}

// --- Only for AUDUSD ---
const symbol = "AUDUSD";
const file = `${symbol}_signals.jsonl`;

console.log(`\n📊 Analyzing ${symbol}...`);

const filePath = path.join(signalsDir, file);
if (!fs.existsSync(filePath)) {
    console.error(`❌ No signals file found for ${symbol} in ${signalsDir}`);
    process.exit(1);
}

const trades = fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
        try {
            return calculateTradeResult({
                ...JSON.parse(line),
                symbol
            });
        } catch (e) {
            console.error(`Error parsing trade: ${e.message}`);
            return null;
        }
    })
    .filter(Boolean);

const buyTrades = trades.filter(t => t.signal === "BUY");
const sellTrades = trades.filter(t => t.signal === "SELL");

console.log(`Total Trades: ${trades.length}`);
console.log(`Buy Signals: ${buyTrades.length}`);
console.log(`Sell Signals: ${sellTrades.length}`);
console.log("\nSetup Analysis:");

const trendAligned = trades.filter(t => 
    (t.signal === "BUY" && t.setup.h4Trend === "bullish") ||
    (t.signal === "SELL" && t.setup.h4Trend === "bearish")
);
console.log(`H4 Trend Aligned: ${trendAligned.length} (${Math.round(trendAligned.length / trades.length * 100)}%)`);

const avgM15Rsi = trades.reduce((sum, t) => sum + t.setup.m15Rsi, 0) / trades.length;
const avgH1Rsi = trades.reduce((sum, t) => sum + t.setup.h1Rsi, 0) / trades.length;
console.log(`Avg M15 RSI: ${avgM15Rsi.toFixed(1)}`);
console.log(`Avg H1 RSI: ${avgH1Rsi.toFixed(1)}`);

const avgSL = trades.reduce((sum, t) => sum + t.slPips, 0) / trades.length;
console.log(`Avg SL Size: ${avgSL.toFixed(1)} pips`);

// 💰 Filter profitable trades (example: RSI confirmation + aligned trend)
const profitableTrades = trades.filter(t => 
    (t.signal === "BUY" && t.setup.h4Trend === "bullish" && t.setup.m15Rsi < 40) ||
    (t.signal === "SELL" && t.setup.h4Trend === "bearish" && t.setup.m15Rsi > 60)
);

console.log(`\n💹 Profitable Trades: ${profitableTrades.length}/${trades.length}`);
console.log(`\n💾 Saving results...`);

// Save analyzed trades
const analyzedFile = path.join(outputDir, `${symbol}_analyzed.jsonl`);
fs.writeFileSync(analyzedFile, trades.map(t => JSON.stringify(t)).join("\n"));

// Save profitable trades separately
const profitableFile = path.join(profitableDir, `${symbol}_profitable.jsonl`);
fs.writeFileSync(profitableFile, profitableTrades.map(t => JSON.stringify(t)).join("\n"));

console.log(`✅ All analyzed trades saved to: ${analyzedFile}`);
console.log(`✅ Profitable trades saved to: ${profitableFile}`);


// --- AUDUSD STRATEGY BACKTEST ---
const outputDirV2 = "./analysis_v2";
const profitableDirV2 = "./analysis_v2_profitable";

// Ensure new output directories exist
if (!fs.existsSync(outputDirV2)) fs.mkdirSync(outputDirV2, { recursive: true });
if (!fs.existsSync(profitableDirV2)) fs.mkdirSync(profitableDirV2, { recursive: true });

console.log(`\n📊 Running AUDUSD Strategy V2 Backtest...`);

const filePathV2 = path.join(signalsDir, file);
if (!fs.existsSync(filePathV2)) {
    console.error(`❌ No signals file found for ${symbol} in ${signalsDir}`);
    process.exit(1);
}

const tradesV2 = fs.readFileSync(filePathV2, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
        try {
            // Using same calculateTradeResult for now; could be replaced with new logic if needed
            return calculateTradeResult({
                ...JSON.parse(line),
                symbol
            });
        } catch (e) {
            console.error(`Error parsing trade (V2): ${e.message}`);
            return null;
        }
    })
    .filter(Boolean);

const buyTradesV2 = tradesV2.filter(t => t.signal === "BUY");
const sellTradesV2 = tradesV2.filter(t => t.signal === "SELL");

console.log(`Total Trades (V2): ${tradesV2.length}`);
console.log(`Buy Signals (V2): ${buyTradesV2.length}`);
console.log(`Sell Signals (V2): ${sellTradesV2.length}`);
console.log("\nSetup Analysis (V2):");

const trendAlignedV2 = tradesV2.filter(t => 
    (t.signal === "BUY" && t.setup.h4Trend === "bullish") ||
    (t.signal === "SELL" && t.setup.h4Trend === "bearish")
);
console.log(`H4 Trend Aligned (V2): ${trendAlignedV2.length} (${Math.round(trendAlignedV2.length / tradesV2.length * 100)}%)`);

const avgM15RsiV2 = tradesV2.reduce((sum, t) => sum + t.setup.m15Rsi, 0) / tradesV2.length;
const avgH1RsiV2 = tradesV2.reduce((sum, t) => sum + t.setup.h1Rsi, 0) / tradesV2.length;
console.log(`Avg M15 RSI (V2): ${avgM15RsiV2.toFixed(1)}`);
console.log(`Avg H1 RSI (V2): ${avgH1RsiV2.toFixed(1)}`);

const avgSLV2 = tradesV2.reduce((sum, t) => sum + t.slPips, 0) / tradesV2.length;
console.log(`Avg SL Size (V2): ${avgSLV2.toFixed(1)} pips`);

// 💰 Filter profitable trades (example: RSI confirmation + aligned trend)
const profitableTradesV2 = tradesV2.filter(t => 
    (t.signal === "BUY" && t.setup.h4Trend === "bullish" && t.setup.m15Rsi < 40) ||
    (t.signal === "SELL" && t.setup.h4Trend === "bearish" && t.setup.m15Rsi > 60)
);

console.log(`\n💹 Profitable Trades (V2): ${profitableTradesV2.length}/${tradesV2.length}`);
console.log(`\n💾 Saving V2 results...`);

// Save analyzed trades for V2
const analyzedFileV2 = path.join(outputDirV2, `${symbol}_analyzed.jsonl`);
fs.writeFileSync(analyzedFileV2, tradesV2.map(t => JSON.stringify(t)).join("\n"));

// Save profitable trades separately for V2
const profitableFileV2 = path.join(profitableDirV2, `${symbol}_profitable.jsonl`);
fs.writeFileSync(profitableFileV2, profitableTradesV2.map(t => JSON.stringify(t)).join("\n"));

console.log(`✅ All analyzed trades (V2) saved to: ${analyzedFileV2}`);
console.log(`✅ Profitable trades (V2) saved to: ${profitableFileV2}`);