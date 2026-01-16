async function calculateTradeParameters(signal, symbol, bid, ask) {
    // Use ATR from the entry timeframe (M15)
    const price = signal === "buy" ? ask : bid;
    const atr = await this.calculateATR(symbol); // Already uses M15 timeframe
    // ATR-based dynamic stops/TPs
    const stopLossDistance = 1.5 * atr;
    const takeProfitDistance = 3 * atr;
    const stopLossPrice = signal === "buy" ? price - stopLossDistance : price + stopLossDistance;
    const takeProfitPrice = signal === "buy" ? price + takeProfitDistance : price - takeProfitDistance;
    const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
    logger.info(`[calculateTradeParameters] ATR: ${atr}, Size: ${size}`);

    // Trailing stop parameters (optional, can be used for trailing logic)
    const trailingStopParams = {
        activationPrice:
            signal === "buy"
                ? price + stopLossDistance // Activate at 1R profit
                : price - stopLossDistance,
        trailingDistance: atr, // Trail by 1 ATR
    };

    return {
        size,
        stopLossPrice,
        takeProfitPrice,
        stopLossPips: stopLossDistance,
        takeProfitPips: takeProfitDistance,
        trailingStopParams,
        partialTakeProfit:
            signal === "buy"
                ? price + stopLossDistance // Take partial at 1R
                : price - stopLossDistance,
    };
}

// 06/06/2025
async function calculateTradeParameters(signal, symbol, bid, ask, indicators) {
    // Use ATR from the entry timeframe (M15)
    const price = signal === "BUY" ? ask : bid;
    // const atr = await this.calculateATR(symbol); // Already uses M15 timeframe
    const atr = indicators?.m15?.atr;

    // ATR-based dynamic stops/TPs
    const stopLossDistance = 1.5 * atr;
    const takeProfitDistance = 3 * atr;
    const stopLossPrice = signal === "BUY" ? price - stopLossDistance : price + stopLossDistance;
    const takeProfitPrice = signal === "BUY" ? price + takeProfitDistance : price - takeProfitDistance;
    const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
    logger.info(`[calculateTradeParameters] ATR: ${atr}, Size: ${size}`);

    //     // --- Respect broker TP constraints if available ---
    try {
        const tpRange = await getAllowedTPRange(symbol, signal, price);
        if (tpRange) {
            const { minDistance, maxDistance } = tpRange; // in price units
            const tpDistance = Math.abs(takeProfitPrice - price);

            // If TP too close or too far, clamp it to allowed range but keep the direction.
            if (tpDistance < minDistance || (maxDistance && tpDistance > maxDistance)) {
                const directionFactor = signal === "BUY" ? 1 : -1;
                const clampedDistance = Math.min(Math.max(tpDistance, minDistance), maxDistance || tpDistance);
                takeProfitPrice = price + directionFactor * clampedDistance;
            }
        }
    } catch (e) {
        logger.warn(`[Trade Params] Could not adjust TP to broker range for ${symbol}: ${e.message}`);
    }
    const slDistance = Math.abs(price - stopLossPrice);

    logger.info(
        `[Trade Params] ${symbol} ${signal}:
            Entry: ${price}
            SL: ${stopLossPrice}
            TP: ${takeProfitPrice}
            RR: ${(Math.abs(takeProfitPrice - price) / slDistance).toFixed(2)}:1
            Size : ${size}`
    );
    return { size, price, stopLossPrice, takeProfitPrice };
}
