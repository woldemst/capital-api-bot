import Strategy from "../strategies/strategies.js";

const m15Windows = {};

export function generateSignal(data, symbol) {
    if (!data || !data.M1 || !data.M15 || !data.H1 || !data.H4) return null;

    // initialize rolling window
    if (!m15Windows[symbol]) m15Windows[symbol] = [];
    m15Windows[symbol].push(data.M15);

    // keep last 3 M15 candles
    const m15Candles = m15Windows[symbol].slice(-3);

    if (m15Candles.length < 3) return null;

    const indicators = {
        m1: data.M1,
        m5: data.M5,
        m15: data.M15,
        h1: data.H1,
        h4: data.H4
    };

    const candles = { m15Candles };

    // generate signal
    const result = Strategy.getSignal({ symbol, indicators, candles });

    if (!result || !result.signal) return null;

    return {
        signal: result.signal,
        reason: result.reason,
        time: data.M1.timestamp,
        indicators,
        M1: data.M1,
        M5: data.M5,
        M15: data.M15,
        H1: data.H1,
        H4: data.H4
    };
}