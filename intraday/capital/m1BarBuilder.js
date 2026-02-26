function minuteBucketUtc(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    d.setUTCSeconds(0, 0);
    return d.getTime();
}

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function midFromTick(tick) {
    const bid = toNum(tick?.bid);
    const ask = toNum(tick?.ask);
    const mid = toNum(tick?.mid);
    if (Number.isFinite(mid)) return mid;
    if ([bid, ask].every(Number.isFinite)) return (bid + ask) / 2;
    return bid ?? ask ?? null;
}

export class M1BarBuilder {
    constructor({ onBarClosed = null } = {}) {
        this.onBarClosed = onBarClosed;
        this.activeBars = new Map();
    }

    ingestTick(tick) {
        const symbol = String(tick?.symbol || "").toUpperCase();
        const ts = Date.parse(tick?.timestamp || "");
        const price = midFromTick(tick);
        if (!symbol || !Number.isFinite(ts) || !Number.isFinite(price)) return null;

        const bucket = minuteBucketUtc(ts);
        const active = this.activeBars.get(symbol);
        let closedBar = null;

        if (active && active.bucket !== bucket) {
            closedBar = {
                symbol,
                timeframe: "M1",
                t: new Date(active.bucket).toISOString(),
                o: active.o,
                h: active.h,
                l: active.l,
                c: active.c,
                bid: active.lastBid,
                ask: active.lastAsk,
                volume: active.tickCount,
            };
            if (typeof this.onBarClosed === "function") {
                this.onBarClosed(closedBar);
            }
            this.activeBars.delete(symbol);
        }

        const next = this.activeBars.get(symbol) || {
            bucket,
            o: price,
            h: price,
            l: price,
            c: price,
            tickCount: 0,
            lastBid: toNum(tick?.bid),
            lastAsk: toNum(tick?.ask),
        };

        next.bucket = bucket;
        next.h = Math.max(next.h, price);
        next.l = Math.min(next.l, price);
        next.c = price;
        next.tickCount += 1;
        next.lastBid = toNum(tick?.bid);
        next.lastAsk = toNum(tick?.ask);
        this.activeBars.set(symbol, next);
        return closedBar;
    }

    flush(symbol = null) {
        const items = [];
        const keys = symbol ? [String(symbol).toUpperCase()] : [...this.activeBars.keys()];
        for (const key of keys) {
            const active = this.activeBars.get(key);
            if (!active) continue;
            items.push({
                symbol: key,
                timeframe: "M1",
                t: new Date(active.bucket).toISOString(),
                o: active.o,
                h: active.h,
                l: active.l,
                c: active.c,
                bid: active.lastBid,
                ask: active.lastAsk,
                volume: active.tickCount,
            });
            this.activeBars.delete(key);
        }
        return items;
    }
}

export default M1BarBuilder;

