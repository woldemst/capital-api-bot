const STAGE_RULES = {
    forex: {
        biasAdxMin: 18,
        setupAdxMin: 18,
        entryAdxMin: 16,
        setupRsiSlopeTolerance: 0.5,
        buySetupRsiMin: 32,
        buySetupRsiMax: 60,
        sellSetupRsiMin: 45,
        sellSetupRsiMax: 60,
        buyEntryReclaimMax: 0.0001,
        sellEntryReclaimMin: null,
    },
    crypto: {
        biasAdxMin: 22,
        setupAdxMin: 20,
        entryAdxMin: 18,
        setupRsiSlopeTolerance: 1.2,
        buySetupRsiMin: 40,
        buySetupRsiMax: 62,
        sellSetupRsiMin: 38,
        sellSetupRsiMax: 60,
        buyEntryReclaimMax: 0.0015,
        sellEntryReclaimMin: -0.0015,
    },
};

class Strategy {
    constructor() {}

    // Only supported variant: H1_M15_M5.
    generateSignal3Stage({ indicators, variant, assetClass = "forex" }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const selectedAssetClass = assetClass === "crypto" ? "crypto" : "forex";
        const rules = STAGE_RULES[selectedAssetClass];

        const selectedVariant = variant === "H1_M15_M5" ? variant : "H1_M15_M5";
        const biasTF = "h1";
        const setupTF = "m15";
        const entryTF = "m5";

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
        const biasStrengthOk = !this.isNumber(biasAdx) || biasAdx >= rules.biasAdxMin;
        const biasOk = direction !== null && biasStrengthOk;

        const baseContext = {
            assetClass: selectedAssetClass,
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
                ? setupRsi >= rules.buySetupRsiMin && setupRsi <= rules.buySetupRsiMax
                : setupRsi >= rules.sellSetupRsiMin && setupRsi <= rules.sellSetupRsiMax);
        const setupRsiSlopeOk =
            !this.isNumber(setupRsiPrev) ||
            (isBuy
                ? setupRsi >= setupRsiPrev - rules.setupRsiSlopeTolerance
                : setupRsi <= setupRsiPrev + rules.setupRsiSlopeTolerance);
        const setupAdxOk = !this.isNumber(setupAdx) || setupAdx >= rules.setupAdxMin;
        const setupChecks = {
            pullbackOk: setupPullbackOk,
            rsiRangeOk: setupRsiRangeOk,
            rsiSlopeOk: setupRsiSlopeOk,
            adxOk: setupAdxOk,
        };
        const setupOk = setupPullbackOk && setupRsiRangeOk && setupRsiSlopeOk && setupAdxOk;
        const setupScore = [setupPullbackOk, setupRsiRangeOk, setupRsiSlopeOk, setupAdxOk].filter(Boolean).length;

        if (!setupOk) {
            return {
                signal: null,
                reason: "setup_blocked",
                context: {
                    ...baseContext,
                    setupScore,
                    setupChecks,
                    gateStates: { biasOk, setupOk, entryOk: false },
                },
            };
        }

        const entryMacdOk =
            this.isNumber(entryMacdHist) && (isBuy ? entryMacdHist > 0 : entryMacdHist < 0);
        const entryPriceReclaimOk =
            this.isNumber(entryPullbackValue) &&
            (isBuy
                ? entryPullbackValue >= 0 && entryPullbackValue <= rules.buyEntryReclaimMax
                : entryPullbackValue <= 0 && (!this.isNumber(rules.sellEntryReclaimMin) || entryPullbackValue >= rules.sellEntryReclaimMin));
        const entryAdxOk = !this.isNumber(entryAdx) || entryAdx >= rules.entryAdxMin;
        const entryChecks = {
            macdOk: entryMacdOk,
            reclaimOk: entryPriceReclaimOk,
            adxOk: entryAdxOk,
        };
        const entryOk = entryMacdOk && entryPriceReclaimOk && entryAdxOk;
        const entryScore = [entryMacdOk, entryPriceReclaimOk, entryAdxOk].filter(Boolean).length;

        if (!entryOk) {
            return {
                signal: null,
                reason: "entry_blocked",
                context: {
                    ...baseContext,
                    setupScore,
                    setupChecks,
                    entryScore,
                    entryChecks,
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
                setupChecks,
                entryScore,
                entryChecks,
                gateStates: { biasOk, setupOk, entryOk },
            },
        };
    }

    generateSignal3StageForex({ indicators, variant }) {
        return this.generateSignal3Stage({ indicators, variant, assetClass: "forex" });
    }

    generateSignal3StageCrypto({ indicators, variant = "H1_M15_M5" }) {
        return this.generateSignal3Stage({ indicators, variant, assetClass: "crypto" });
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
