import fs from "fs";
import path from "path";

// --- Config ---
const signalsDir = "./results";
const outputDir = "./analysis";
const profitThreshold = 0; // minimum profit to count as profitable

// Ensure output dir exists
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Get all signal files
const signalFiles = fs.readdirSync(signalsDir).filter((f) => f.endsWith("_signals.jsonl"));

signalFiles.forEach((file) => {
    const filePath = path.join(signalsDir, file);
    const trades = fs
        .readFileSync(filePath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    const profitableTrades = trades.filter((trade) => {
        // Handle different field names
        const profit = trade.profit ?? trade.pnl ?? trade.result ?? 0;

        // For JPY or CAD pairs, small pips may look like 0 due to rounding
        // We use profitThreshold = 0 to capture any positive value
        return profit > profitThreshold;
    });

    const outputFile = path.join(outputDir, file.replace("_signals.jsonl", "_profitable.jsonl"));
    fs.writeFileSync(outputFile, profitableTrades.map((t) => JSON.stringify(t)).join("\n"));

    console.log(`💹 Backtesting ${file.replace("_signals.jsonl", "")} (${trades.length} trades)...`);
    console.log(`✅ ${file.replace("_signals.jsonl", "")}: ${profitableTrades.length}/${trades.length} profitable trades saved to ${outputFile}`);
});
