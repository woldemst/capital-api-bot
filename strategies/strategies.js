export const checkCalmRiver = (m5Candles, ema20, ema50) => {
    if (!m5Candles || m5Candles.length < 60) return null;

    const closes = m5Candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const prevCloses = closes.slice(-4, -1); // last 3 before trigger

    const trendUp = lastClose > ema20 && ema20 > ema50;
    const trendDown = lastClose < ema20 && ema20 < ema50;

    // Count candles closed between ema20 & ema50
    const insideCount = prevCloses.filter((c) => c < Math.max(ema20, ema50) && c > Math.min(ema20, ema50)).length;
    if (insideCount > 3) return null; // too much congestion

    if (trendUp && lastClose > ema20) return "BUY";
    if (trendDown && lastClose < ema20) return "SELL";
    return null;
};
