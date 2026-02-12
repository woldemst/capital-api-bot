const BIAS_ADX_MIN = 18;
const SETUP_ADX_MIN = 18;
const ENTRY_ADX_MIN = 18;
const BUY_SETUP_RSI_MIN = 32;
const BUY_SETUP_RSI_MAX = 60;
const SELL_SETUP_RSI_MIN = 45;
const SELL_SETUP_RSI_MAX = 65;

class Strategy {
    constructor() {}

    // Variants: H4_H1_M15 (default) and H1_M15_M5.
    generateSignal3Stage({ indicators, variant }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const variants = {
            H4_H1_M15: { biasTF: "h4", setupTF: "h1", entryTF: "m15" },
            H1_M15_M5: { biasTF: "h1", setupTF: "m15", entryTF: "m5" },
        };
        const selectedVariant = variants[variant] ? variant : "H4_H1_M15";
        const { biasTF, setupTF, entryTF } = variants[selectedVariant];

        const biasIndicators = indicators?.[biasTF];
        const setupIndicators = indicators?.[setupTF];
        const entryIndicators = indicators?.[entryTF];

        const biasTrend = this.pickTrend(biasIndicators);
        const biasAdx = this.adx(biasIndicators);
        const setupPullbackValue = this.priceVsEma9(setupIndicators);
        const setupRsi = this.rsi(setupIndicators);
        const setupRsiPrev = this.rsiPrev(setupIndicators);
        const setupAdx = this.adx(setupIndicators);
        const entryMacdHist = this.macdHist(entryIndicators);
        const entryPullbackValue = this.priceVsEma9(entryIndicators);
        const entryAdx = this.adx(entryIndicators);

        const direction = biasTrend === "bullish" ? "BUY" : biasTrend === "bearish" ? "SELL" : null;
        const biasStrengthOk = !this.isNumber(biasAdx) || biasAdx >= BIAS_ADX_MIN;
        const biasOk = direction !== null && biasStrengthOk;

        const baseContext = {
            variant: selectedVariant,
            biasTF,
            setupTF,
            entryTF,
            biasTrend,
            biasAdx,
            setupPullbackValue,
            setupRsi,
            setupRsiPrev,
            setupAdx,
            entryMacdHist,
            entryPullbackValue,
            entryAdx,
            gateStates: { biasOk, setupOk: false, entryOk: false },
        };

        if (!biasOk) {
            return { signal: null, reason: "bias_blocked", context: baseContext };
        }

        const isBuy = direction === "BUY";
        const setupPullbackOk =
            this.isNumber(setupPullbackValue) &&
            (isBuy ? setupPullbackValue <= 0 : setupPullbackValue >= 0);
        const setupRsiRangeOk =
            this.isNumber(setupRsi) &&
            (isBuy
                ? setupRsi >= BUY_SETUP_RSI_MIN && setupRsi <= BUY_SETUP_RSI_MAX
                : setupRsi >= SELL_SETUP_RSI_MIN && setupRsi <= SELL_SETUP_RSI_MAX);
        const setupRsiSlopeOk =
            !this.isNumber(setupRsiPrev) ||
            (isBuy ? setupRsi > setupRsiPrev : setupRsi < setupRsiPrev);
        const setupAdxOk = !this.isNumber(setupAdx) || setupAdx >= SETUP_ADX_MIN;
        const setupOk = setupPullbackOk && setupRsiRangeOk && setupRsiSlopeOk && setupAdxOk;
        const setupScore = [setupPullbackOk, setupRsiRangeOk, setupRsiSlopeOk, setupAdxOk].filter(Boolean).length;

        if (!setupOk) {
            return {
                signal: null,
                reason: "setup_blocked",
                context: {
                    ...baseContext,
                    setupScore,
                    gateStates: { biasOk, setupOk, entryOk: false },
                },
            };
        }

        const entryMacdOk =
            this.isNumber(entryMacdHist) && (isBuy ? entryMacdHist > 0 : entryMacdHist < 0);
        const entryPriceReclaimOk =
            this.isNumber(entryPullbackValue) &&
            (isBuy ? entryPullbackValue >= 0 : entryPullbackValue <= 0);
        const entryAdxOk = !this.isNumber(entryAdx) || entryAdx >= ENTRY_ADX_MIN;
        const entryOk = entryMacdOk && entryPriceReclaimOk && entryAdxOk;
        const entryScore = [entryMacdOk, entryPriceReclaimOk, entryAdxOk].filter(Boolean).length;

        if (!entryOk) {
            return {
                signal: null,
                reason: "entry_blocked",
                context: {
                    ...baseContext,
                    setupScore,
                    entryScore,
                    gateStates: { biasOk, setupOk, entryOk },
                },
            };
        }

        return {
            signal: direction,
            reason: "three_stage_confirmed",
            context: {
                ...baseContext,
                setupScore,
                entryScore,
                gateStates: { biasOk, setupOk, entryOk },
            },
        };
    }

    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    rsi(indicators) {
        const rsi = indicators?.rsi;
        return this.isNumber(rsi) ? rsi : null;
    }

    rsiPrev(indicators) {
        const rsiPrev = indicators?.rsiPrev;
        return this.isNumber(rsiPrev) ? rsiPrev : null;
    }

    adx(indicators) {
        const adx = indicators?.adx;
        if (this.isNumber(adx)) return adx;
        if (adx && this.isNumber(adx.adx)) return adx.adx;
        return null;
    }

    macdHist(indicators) {
        const hist = indicators?.macd?.histogram;
        return this.isNumber(hist) ? hist : null;
    }

    priceVsEma9(indicators) {
        const direct = indicators?.price_vs_ema9;
        if (this.isNumber(direct)) return direct;
        const price = indicators?.close ?? indicators?.lastClose;
        const ema9 = indicators?.ema9;
        if (this.isNumber(price) && this.isNumber(ema9) && ema9 !== 0) return (price - ema9) / ema9;
        return null;
    }

    pickTrend(indicator) {
        if (!indicator || typeof indicator !== "object") return "neutral";
        const { ema20, ema50, trend } = indicator;

        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
        if (trend === "bullish" || trend === "bearish") return trend;

        return "neutral";
    }
}

export default new Strategy();
