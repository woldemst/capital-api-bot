import fs from "fs";
import readline from "readline";
import { generateSignal } from "./signals.js";

const pairs = [
    "EURUSD", "USDJPY", "GBPUSD", "AUDUSD",
    "NZDUSD", "EURJPY", "GBPJPY", "USDCAD"
];

const inputDir = "./analysis";
const outputDir = "./results";
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

async function processPair(pair) {
    const inputPath = `${inputDir}/${pair}_combined.jsonl`;
    const outputPath = `${outputDir}/${pair}_signals.jsonl`;

    if (!fs.existsSync(inputPath)) {
        console.warn(`⚠️ No input data for ${pair}, skipping.`);
        return;
    }

    const fileStream = fs.createReadStream(inputPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const outputFile = fs.createWriteStream(outputPath);

    console.log(`🔍 Simulating trades for ${pair}...`);

    let total = 0;
    let signalsSaved = 0;

    for await (const line of rl) {
        const data = JSON.parse(line);
        total++;

        const signal = generateSignal(data, pair);
        if (!signal) continue;

        signalsSaved++;
        outputFile.write(JSON.stringify(signal) + "\n");
    }

    outputFile.end();
    console.log(`✅ ${pair}: ${signalsSaved}/${total} trades simulated → ${outputPath}`);
}

async function main() {
    for (const pair of pairs) {
        await processPair(pair);
    }
}

main().catch(err => console.error("❌ Error running strategy:", err));