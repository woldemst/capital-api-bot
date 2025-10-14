import fs from "fs";
import path from "path";
import readline from "readline";

function analyzeSignals(inputFile, analyzedFile, profitableFile) {
  return new Promise((resolve, reject) => {
    const analyzedStream = fs.createWriteStream(analyzedFile, { flags: "w" });
    const profitableStream = fs.createWriteStream(profitableFile, { flags: "w" });

    const rl = readline.createInterface({
      input: fs.createReadStream(inputFile),
      crlfDelay: Infinity,
    });

    let totalProfit = 0;
    let totalTrades = 0;

    rl.on("line", (line) => {
      if (!line.trim()) return;

      const signal = JSON.parse(line);
      const profit = signal.profit || 0;
      totalProfit += profit;
      totalTrades++;

      analyzedStream.write(line + "\n");

      if (profit > 0) {
        profitableStream.write(line + "\n");
      }
    });

    rl.on("close", () => {
      analyzedStream.close();
      profitableStream.close();
      resolve({ totalProfit, totalTrades });
    });

    rl.on("error", (err) => {
      reject(err);
    });
  });
}

// --- EXISTING BACKTEST ANALYSIS ---

(async () => {
  try {
    const inputDir = "./results";
    const outputDir = "./analysis";
    const outputProfitableDir = "./analysis_profitable";

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    if (!fs.existsSync(outputProfitableDir)) fs.mkdirSync(outputProfitableDir);

    const symbols = fs.readdirSync(inputDir).filter((file) => file.endsWith("_signals.jsonl"));

    for (const file of symbols) {
      const symbol = file.replace("_signals.jsonl", "");
      const inputFile = path.join(inputDir, file);
      const analyzedFile = path.join(outputDir, `${symbol}_analyzed.jsonl`);
      const profitableFile = path.join(outputProfitableDir, `${symbol}_profitable.jsonl`);

      const { totalProfit, totalTrades } = await analyzeSignals(inputFile, analyzedFile, profitableFile);

      console.log(`Symbol: ${symbol}`);
      console.log(`Total Trades: ${totalTrades}`);
      console.log(`Total Profit: ${totalProfit.toFixed(2)}`);
      console.log("-----");
    }
  } catch (error) {
    console.error("Error during backtest analysis:", error);
  }
})();

// --- AUDUSD STRATEGY BACKTEST ---

(async () => {
  try {
    const inputDirV2 = "./results";
    const outputDirV2 = "./analysis_v2";
    const outputProfitableDirV2 = "./analysis_v2_profitable";

    if (!fs.existsSync(outputDirV2)) fs.mkdirSync(outputDirV2);
    if (!fs.existsSync(outputProfitableDirV2)) fs.mkdirSync(outputProfitableDirV2);

    const symbol = "AUDUSD";
    const inputFile = path.join(inputDirV2, `${symbol}_signals.jsonl`);
    const analyzedFile = path.join(outputDirV2, `${symbol}_analyzed.jsonl`);
    const profitableFile = path.join(outputProfitableDirV2, `${symbol}_profitable.jsonl`);

    if (!fs.existsSync(inputFile)) {
      console.warn(`Input file for ${symbol} not found: ${inputFile}`);
      return;
    }

    const { totalProfit, totalTrades } = await analyzeSignals(inputFile, analyzedFile, profitableFile);

    console.log(`AUDUSD Strategy Backtest (v2)`);
    console.log(`Total Trades: ${totalTrades}`);
    console.log(`Total Profit: ${totalProfit.toFixed(2)}`);
    console.log("-----");
  } catch (error) {
    console.error("Error during AUDUSD strategy backtest analysis:", error);
  }
})();