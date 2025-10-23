import fs from "fs";
import path from "path";

// --- CONFIG ---
const inputFile = "./results/EURUSD_backtest_results.jsonl";
const outputFile = "./results/EURUSD_profitable_trades.jsonl";
const RISK_PER_TRADE = 0.02; // 2% risk per trade
const REWARD_RATIO = 2; // 1:2 risk:reward

// Example: simulate trade result (replace with your actual logic)
function simulateTrade(signal, entryPrice, direction, slPips = 20, rr = REWARD_RATIO) {
    // Assume entryPrice is available, direction is "BUY"/"SELL"
    // TP = SL * rr, SL = slPips
    const tpPips = slPips * rr;
    // Simulate: random win/loss (replace with your own logic)
    const won = Math.random() > 0.5; // Replace with real result
    const pips = won ? tpPips : -slPips;
    return { won, pips, profit: won ? tpPips : -slPips };
}

async function filterProfitableTrades() {
    const lines = fs.readFileSync(inputFile, "utf8").split("\n").filter(Boolean);
    let totalProfit = 0;
    let profitableCount = 0;

    const outputStream = fs.createWriteStream(outputFile, { flags: "w" });

    for (const line of lines) {
        const trade = JSON.parse(line);
        // You need entry price and direction for real calculation!
        // For demo, let's assume entryPrice = 1.1000, direction from signal
        const entryPrice = 1.1;
        const direction = trade.signal;

        // Simulate trade result (replace with your own backtest logic)
        const result = simulateTrade(trade, entryPrice, direction);

        if (result.won) {
            profitableCount++;
            totalProfit += result.profit;
            outputStream.write(
                JSON.stringify({
                    time: trade.time,
                    signal: trade.signal,
                    reason: trade.reason,
                    indicators: trade.indicators,
                    pips: result.pips,
                    profit: result.profit,
                    context: trade.context,
                }) + "\n"
            );
        }
    }

    outputStream.end();
    console.log(`✅ Profitable trades: ${profitableCount}`);
    console.log(`💰 Total pips won: ${totalProfit}`);
    console.log(`Saved to: ${outputFile}`);
}

filterProfitableTrades();
