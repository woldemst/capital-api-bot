import Strategy from "../strategies/strategies.js";

// This will now expose the signal generator for your legacy strategy
export function generateSignal(data, pair) {
    if (!data || !data.M1 || !data.H1 || !data.H4 || !data.M15) return null;

    const indicators = {
        h4: data.H4,
        h1: data.H1,
        m15: data.M15,
    };

    const bid = data.M1.close;
    const ask = data.M1.close; // adjust if separate ask exists

    // If your data has M15 candles array, pass it
    const candles = {
        m15Candles: data.M15Candles || [], // or whatever your array is called
    };

    const signalResult = Strategy.getSignal({ pair, indicators, candles });

    if (!signalResult || !signalResult.signal) return null;

    // Return signal + all relevant data for analysis/backtesting
    return {
        signal: signalResult.signal,
        buyScore: signalResult.buyScore,
        sellScore: signalResult.sellScore,
        time: data.M1.timestamp,
        indicators: {
            h4: data.H4,
            h1: data.H1,
            m15: data.M15,
        },
        M1: data.M1,
        M5: data.M5,
        M15: data.M15,
        H1: data.H1,
        H4: data.H4,
    };
}
