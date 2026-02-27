import test from "node:test";
import assert from "node:assert/strict";

import {
    calculateCryptoPositionSizeFromRisk,
    computeStrategyTradeCountersForDay,
    detectJumpRegime,
    evaluateLiquidityWindowGate,
    getDateKeyInTimeZone,
} from "../../strategies/cryptoLiquidityWindowMomentum.js";

function buildBar({ tsMs, o, h, l, c, v = null }) {
    return {
        t: new Date(tsMs).toISOString(),
        tsMs,
        o,
        h,
        l,
        c,
        v,
    };
}

test("Berlin liquidity window gate is DST-safe across summer and winter transition dates", () => {
    const afterDstStart = "2026-03-29T12:30:00.000Z"; // 14:30 Berlin (CEST)
    const afterDstEnd = "2026-10-25T13:30:00.000Z"; // 14:30 Berlin (CET)
    const summerOutside = "2026-03-29T18:30:00.000Z"; // 20:30 Berlin (outside 14-20)

    const spring = evaluateLiquidityWindowGate({ timestamp: afterDstStart, timeZone: "Europe/Berlin", windowStart: "14:00", windowEnd: "20:00" });
    const autumn = evaluateLiquidityWindowGate({ timestamp: afterDstEnd, timeZone: "Europe/Berlin", windowStart: "14:00", windowEnd: "20:00" });
    const outside = evaluateLiquidityWindowGate({ timestamp: summerOutside, timeZone: "Europe/Berlin", windowStart: "14:00", windowEnd: "20:00" });

    assert.equal(spring.withinWindow, true);
    assert.equal(autumn.withinWindow, true);
    assert.equal(outside.withinWindow, false);
});

test("Jump detection blocks entries during cooldown when a 5m jump exceeds return threshold", () => {
    const start = Date.parse("2026-02-26T12:00:00.000Z");
    const bars = [];
    let price = 100;

    for (let i = 0; i < 20; i += 1) {
        const tsMs = start + i * 5 * 60 * 1000;
        const prev = price;
        if (i === 17) {
            price = prev * 1.02; // 2% jump
        } else {
            price = prev * 1.001;
        }
        bars.push(
            buildBar({
                tsMs,
                o: prev,
                h: Math.max(prev, price) * 1.001,
                l: Math.min(prev, price) * 0.999,
                c: price,
            }),
        );
    }

    const nowTsMs = start + 19 * 5 * 60 * 1000;
    const out = detectJumpRegime({
        bars5m: bars,
        atr14: 0.8,
        jumpThresholdPct: 0.01,
        jumpAtrMult: 2.5,
        lookbackBars: 12,
        nowTsMs,
        cooldownMinutes: 60,
    });

    assert.equal(out.jumpDetected, true);
    assert.equal(out.jumpMetricUsed.includes("return5m"), true);
    assert.ok(out.jumpCooldownRemainingMinutes > 0);
});

test("Position sizing uses risk and caps by leverage when needed", () => {
    const normal = calculateCryptoPositionSizeFromRisk({
        equity: 10000,
        entryPrice: 100,
        stopPrice: 99,
        riskPct: 0.0035,
        maxLeverage: 2,
    });
    assert.equal(normal.riskAmount, 35);
    assert.equal(normal.stopDistance, 1);
    assert.equal(normal.size, 35);
    assert.equal(normal.leverageCapped, false);

    const capped = calculateCryptoPositionSizeFromRisk({
        equity: 10000,
        entryPrice: 100,
        stopPrice: 99.9,
        riskPct: 0.015,
        maxLeverage: 2,
    });
    assert.equal(capped.size, 200);
    assert.equal(capped.leverageCapped, true);
});

test("Trade counters compute per-day totals and per-symbol cooldown reference in Berlin timezone", () => {
    const tz = "Europe/Berlin";
    const ts = "2026-02-26T15:00:00.000Z";
    const dayKey = getDateKeyInTimeZone(ts, tz);
    const events = [
        { type: "OPEN", symbol: "BTCUSD", timestamp: "2026-02-26T12:05:00.000Z" },
        { type: "EXIT", symbol: "BTCUSD", timestamp: "2026-02-26T13:45:00.000Z" },
        { type: "OPEN", symbol: "ETHUSD", timestamp: "2026-02-26T13:55:00.000Z" },
        { type: "OPEN", symbol: "BTCUSD", timestamp: "2026-02-25T14:05:00.000Z" }, // previous Berlin day
        { type: "EXIT", symbol: "BTCUSD", timestamp: "2026-02-25T16:00:00.000Z" },
    ];

    const out = computeStrategyTradeCountersForDay({
        events,
        symbol: "BTCUSD",
        dayKey,
        timeZone: tz,
    });

    assert.equal(out.tradesTodayTotal, 2);
    assert.equal(out.tradesTodaySymbol, 1);
    assert.equal(new Date(out.lastExitAtMs).toISOString(), "2026-02-26T13:45:00.000Z");
});

