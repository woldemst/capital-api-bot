function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SentimentPoller {
    constructor({
        apiClient,
        intervalSeconds = 120,
        jitterSeconds = 15,
        logger = console,
        onSentiment = null,
        shouldContinue = null,
    }) {
        this.apiClient = apiClient;
        this.intervalSeconds = clamp(Number(intervalSeconds) || 120, 60, 300);
        this.jitterSeconds = Math.max(0, Number(jitterSeconds) || 0);
        this.logger = logger;
        this.onSentiment = onSentiment;
        this.shouldContinue = shouldContinue;
        this.running = false;
        this.cache = new Map();
        this.loopPromise = null;
    }

    getSnapshot(symbol) {
        return this.cache.get(String(symbol || "").toUpperCase()) || null;
    }

    listSnapshots() {
        return [...this.cache.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    async pollOnce(symbols = []) {
        const rows = [];
        for (const symbol of symbols) {
            try {
                const sentiment = await this.apiClient.getClientSentiment(symbol);
                const normalized = {
                    symbol: String(sentiment.symbol || symbol).toUpperCase(),
                    clientLongPct: Number.isFinite(Number(sentiment.clientLongPct)) ? Number(sentiment.clientLongPct) : null,
                    clientShortPct: Number.isFinite(Number(sentiment.clientShortPct)) ? Number(sentiment.clientShortPct) : null,
                    timestamp: sentiment.timestamp || new Date().toISOString(),
                    source: "capital.com_client_sentiment",
                };
                this.cache.set(normalized.symbol, normalized);
                rows.push(normalized);
                if (typeof this.onSentiment === "function") {
                    await this.onSentiment(normalized);
                }
            } catch (error) {
                this.logger.warn?.(`[SentimentPoller] Sentiment poll failed for ${symbol}: ${error.message}`);
            }
        }
        return rows;
    }

    nextSleepMs() {
        const base = this.intervalSeconds * 1000;
        if (!this.jitterSeconds) return base;
        const jitter = Math.round((Math.random() * 2 - 1) * this.jitterSeconds * 1000);
        return Math.max(1000, base + jitter);
    }

    async start(symbols = []) {
        if (this.running) return this.loopPromise;
        this.running = true;
        this.loopPromise = (async () => {
            while (this.running && (typeof this.shouldContinue !== "function" || this.shouldContinue())) {
                await this.pollOnce(symbols);
                if (!this.running) break;
                await sleep(this.nextSleepMs());
            }
        })();
        return this.loopPromise;
    }

    stop() {
        this.running = false;
        return this.loopPromise;
    }
}

export default SentimentPoller;

