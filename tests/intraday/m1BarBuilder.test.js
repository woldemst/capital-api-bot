import test from "node:test";
import assert from "node:assert/strict";
import { M1BarBuilder } from "../../intraday/capital/m1BarBuilder.js";

test("M1BarBuilder closes previous minute and opens next minute", () => {
    const closedBars = [];
    const builder = new M1BarBuilder({
        onBarClosed: (bar) => closedBars.push(bar),
    });

    builder.ingestTick({ symbol: "EURUSD", bid: 1.1, ask: 1.1002, timestamp: "2026-02-25T10:00:01.000Z" });
    builder.ingestTick({ symbol: "EURUSD", bid: 1.1004, ask: 1.1006, timestamp: "2026-02-25T10:00:20.000Z" });
    const closed = builder.ingestTick({ symbol: "EURUSD", bid: 1.1001, ask: 1.1003, timestamp: "2026-02-25T10:01:00.000Z" });

    assert.ok(closed);
    assert.equal(closed.symbol, "EURUSD");
    assert.equal(closedBars.length, 1);
    assert.equal(closed.o < closed.h, true);
    assert.equal(closed.l <= closed.c, true);
});

