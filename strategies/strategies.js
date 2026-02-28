const STAGE_RULES = {
    forex: {
        allowedSymbols: ["EURJPY", "USDJPY"],
        blockedSymbols: [],
        blockedHoursUtc: [],
        requireH4H1Alignment: true,
        requireD1Filter: true,
        allowD1Neutral: true,
        useM1Timing: true,
        buyH1AdxMin: 18,
        buyM15AdxMin: 15,
        buySetupRsiMin: 28,
        buySetupRsiMax: 45,
        buyPullbackMin: -0.005,
        buyPullbackMax: 0,
        buyMacdHistMin: -0.03,
        buyEntryMacdSlopeMin: 0,
        buyEntryBbPbMax: 0.45,
        buyM1MacdSlopeMin: 0,
        buyM1RsiMax: 55,
        sellH1AdxMin: 18,
        sellM15AdxMin: 15,
        sellSetupRsiMin: 55,
        sellSetupRsiMax: 78,
        sellPullbackMin: 0,
        sellPullbackMax: 0.005,
        sellMacdHistMax: 0.03,
        sellEntryMacdSlopeMax: 0,
        sellEntryBbPbMin: 0.55,
        sellM1MacdSlopeMax: 0,
        sellM1RsiMin: 45,
        spreadPctMax: 0.00025,
        symbolOverrides: {
            EURJPY: {
                buyH1AdxMin: 14,
                sellH1AdxMin: 14,
                regime: {
                    h1AdxMin: 10,
                },
            },
            USDJPY: {
                buyH1AdxMin: 18,
                sellH1AdxMin: 18,
            },
        },
        regime: {
            h1AdxMin: 12,
            m15AdxMin: 12,
            m15AtrPctMin: 0.00025,
            m15AtrPctMax: 0.04,
            spreadPctMax: 0.0002,
            blockNySession: false,
        },
    },
    crypto: {
        enabled: true,
        blockedSymbols: ["BTCEUR", "SOLUSD", "ADAUSD", "ETHUSD", "XRPUSD"],
        blockedHoursUtc: [1, 15],
        requireH4H1Alignment: true,
        requireD1Filter: false,
        allowD1Neutral: true,
        blockCounterTrendLongInDoubleBear: true,
        blockCounterTrendShortInDoubleBull: false,
        useM1Timing: true,
        buyH1AdxMin: 18,
        buyM15AdxMin: 12,
        buySetupRsiMin: 30,
        buySetupRsiMax: 45,
        buyPullbackMin: -0.012,
        buyPullbackMax: 0,
        buyMacdHistMin: -0.05,
        buyEntryMacdSlopeMin: 0,
        buyEntryBbPbMax: 0.4,
        buyM1MacdSlopeMin: 0,
        buyM1RsiMax: 52,
        buyHourStartUtc: 0,
        buyHourEndUtc: 21,
        sellH1AdxMin: 18,
        sellM15AdxMin: 15,
        sellSetupRsiMin: 55,
        sellSetupRsiMax: 85,
        sellPullbackMin: 0,
        sellPullbackMax: 0.015,
        sellHourStartUtc: 0,
        sellHourEndUtc: 21,
        sellMacdHistMax: 0.05,
        sellEntryMacdSlopeMax: 0,
        sellEntryBbPbMin: 0.55,
        sellM1MacdSlopeMax: 0,
        sellM1RsiMin: 48,
        spreadPctMax: 0.006,
        allowedSessions: ["TOKYO", "SYDNEY"],
        regime: {
            h1AdxMin: 12,
            m15AdxMin: 12,
            m15AtrPctMin: 0.00025,
            m15AtrPctMax: 0.04,
        },
    },
};

class Strategy {
    constructor() {}

    // Only supported variant: H1_M15_M5.
    generateSignal3Stage({ symbol = "", indicators, variant, assetClass = "forex", market = {}, timestamp = null, sessions = [] }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const selectedAssetClass = assetClass === "crypto" ? "crypto" : "forex";
        const normalizedSymbol = String(symbol || "").toUpperCase();
        let rules = STAGE_RULES[selectedAssetClass];
        if (rules?.symbolOverrides?.[normalizedSymbol]) {
            rules = this.mergeRuleConfig(rules, rules.symbolOverrides[normalizedSymbol]);
        }

        const selectedVariant = variant === "H1_M15_M5_REGIME" ? "H1_M15_M5_REGIME" : "H1_M15_M5";
        const biasTF = "h1";
        const trendTF = "h4";
        const setupTF = "m15";
        const entryTF = "m5";
        const microTF = "m1";

        const biasIndicators = indicators?.[biasTF];
        const d1Indicators = indicators?.d1;
        const trendIndicators = indicators?.[trendTF];
        const setupIndicators = indicators?.[setupTF];
        const entryIndicators = indicators?.[entryTF];
        const microIndicators = indicators?.[microTF];

        const tsMs = Date.parse(String(timestamp || ""));
        const hourUtc = Number.isFinite(tsMs) ? new Date(tsMs).getUTCHours() : null;
        const normalizedSessions = Array.isArray(sessions) ? sessions.map((session) => String(session).toUpperCase()) : [];
        const spreadValue =
            this.isNumber(market?.spread)
                ? market.spread
                : this.isNumber(market?.ask) && this.isNumber(market?.bid)
                  ? Math.abs(market.ask - market.bid)
                  : null;
        const marketPrice =
            this.isNumber(market?.price)
                ? market.price
                : this.isNumber(market?.mid)
                  ? market.mid
                  : this.isNumber(market?.ask) && this.isNumber(market?.bid)
                    ? (market.ask + market.bid) / 2
                    : this.isNumber(market?.ask)
                      ? market.ask
                      : this.isNumber(market?.bid)
                        ? market.bid
                        : null;
        const spreadPct = this.isNumber(spreadValue) && this.isNumber(marketPrice) && marketPrice !== 0 ? spreadValue / marketPrice : null;

        const d1Trend = this.pickTrend(d1Indicators);
        const h4Trend = this.pickTrend(trendIndicators);
        const biasTrend = this.pickTrend(biasIndicators);
        const biasAdx = this.adx(biasIndicators);
        const setupPullbackValue = this.priceVsEma9(setupIndicators);
        const setupRsi = this.rsi(setupIndicators);
        const setupRsiPrev = this.rsiPrev(setupIndicators);
        const setupAdx = this.adx(setupIndicators);
        const setupAtrPct = this.atrPct(setupIndicators);
        const entryMacdHist = this.macdHist(entryIndicators);
        const entryMacdHistSlope = this.macdHistSlope(entryIndicators);
        const entryPullbackValue = this.priceVsEma9(entryIndicators);
        const entryAdx = this.adx(entryIndicators);
        const entryBbPb = this.bbPb(entryIndicators);
        const microMacdHist = this.macdHist(microIndicators);
        const microMacdHistSlope = this.macdHistSlope(microIndicators);
        const microRsi = this.rsi(microIndicators);

        const biasOk = this.isNumber(biasAdx);
        const doubleBull = h4Trend === "bullish" && biasTrend === "bullish";
        const doubleBear = h4Trend === "bearish" && biasTrend === "bearish";
        const d1BuyOk = !rules.requireD1Filter || d1Trend === "bullish" || (rules.allowD1Neutral && d1Trend === "neutral");
        const d1SellOk = !rules.requireD1Filter || d1Trend === "bearish" || (rules.allowD1Neutral && d1Trend === "neutral");

        const baseContext = {
            assetClass: selectedAssetClass,
            symbol: normalizedSymbol,
            variant: selectedVariant,
            biasTF,
            d1Trend,
            h4Trend,
            setupTF,
            entryTF,
            biasTrend,
            biasAdx,
            setupPullbackValue,
            setupRsi,
            setupRsiPrev,
            setupAdx,
            setupAtrPct,
            entryMacdHist,
            entryMacdHistSlope,
            entryPullbackValue,
            entryAdx,
            entryBbPb,
            microTF,
            microMacdHist,
            microMacdHistSlope,
            microRsi,
            hourUtc,
            sessions: normalizedSessions,
            spreadPct,
            trendAlignment: { doubleBull, doubleBear, d1BuyOk, d1SellOk },
            gateStates: { biasOk, setupOk: false, entryOk: false },
        };

        if (selectedAssetClass === "forex") {
            const allowedSymbols = Array.isArray(rules.allowedSymbols) ? rules.allowedSymbols.map((s) => String(s).toUpperCase()) : [];
            const blockedSymbols = Array.isArray(rules.blockedSymbols) ? rules.blockedSymbols : [];
            const blockedHoursUtc = Array.isArray(rules.blockedHoursUtc) ? rules.blockedHoursUtc : [];
            if (allowedSymbols.length && !allowedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_not_allowed",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
            if (blockedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
            if (this.isNumber(hourUtc) && blockedHoursUtc.includes(hourUtc)) {
                return {
                    signal: null,
                    reason: "hour_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { hourAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
        }

        if (selectedAssetClass === "crypto" && !rules.enabled) {
            return {
                signal: null,
                reason: "crypto_disabled",
                context: {
                    ...baseContext,
                    patternChecks: { cryptoEnabled: false },
                    gateStates: { biasOk, setupOk: false, entryOk: false },
                },
            };
        }
        if (selectedAssetClass === "crypto") {
            const allowedSymbols = Array.isArray(rules.allowedSymbols) ? rules.allowedSymbols.map((s) => String(s).toUpperCase()) : [];
            const blockedSymbols = Array.isArray(rules.blockedSymbols) ? rules.blockedSymbols : [];
            const blockedHoursUtc = Array.isArray(rules.blockedHoursUtc) ? rules.blockedHoursUtc : [];
            if (allowedSymbols.length && !allowedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_not_allowed",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
            if (blockedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
            if (this.isNumber(hourUtc) && blockedHoursUtc.includes(hourUtc)) {
                return {
                    signal: null,
                    reason: "hour_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { hourAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
        }

        const buyTrendAligned = rules.requireH4H1Alignment ? doubleBull : biasTrend !== "bearish";
        const sellTrendAligned = rules.requireH4H1Alignment ? doubleBear : biasTrend !== "bullish";
        const buyCounterTrendBlocked = selectedAssetClass === "crypto" && Boolean(rules.blockCounterTrendLongInDoubleBear) && doubleBear;
        const sellCounterTrendBlocked = selectedAssetClass === "crypto" && Boolean(rules.blockCounterTrendShortInDoubleBull) && doubleBull;
        const m1BuyTimingOk =
            !rules.useM1Timing ||
            ((rules.buyM1MacdSlopeMin === undefined || (this.isNumber(microMacdHistSlope) && microMacdHistSlope >= rules.buyM1MacdSlopeMin)) &&
                (rules.buyM1RsiMax === undefined || (this.isNumber(microRsi) && microRsi <= rules.buyM1RsiMax)));
        const m1SellTimingOk =
            !rules.useM1Timing ||
            ((rules.sellM1MacdSlopeMax === undefined || (this.isNumber(microMacdHistSlope) && microMacdHistSlope <= rules.sellM1MacdSlopeMax)) &&
                (rules.sellM1RsiMin === undefined || (this.isNumber(microRsi) && microRsi >= rules.sellM1RsiMin)));

        const forexSellChecks = {
            trendAligned: sellTrendAligned,
            d1Ok: d1SellOk,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.sellH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.sellM15AdxMin,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            rsiRangeOk: this.inRange(setupRsi, rules.sellSetupRsiMin, rules.sellSetupRsiMax),
            pullbackOk: this.inRange(setupPullbackValue, rules.sellPullbackMin, rules.sellPullbackMax),
            macdOk: this.isNumber(entryMacdHist) && entryMacdHist <= rules.sellMacdHistMax,
            m5MacdSlopeOk:
                rules.sellEntryMacdSlopeMax === undefined ||
                (this.isNumber(entryMacdHistSlope) && entryMacdHistSlope <= rules.sellEntryMacdSlopeMax),
            m5BbOk: rules.sellEntryBbPbMin === undefined || (this.isNumber(entryBbPb) && entryBbPb >= rules.sellEntryBbPbMin),
            m1TimingOk: m1SellTimingOk,
        };

        const forexBuyChecks = {
            trendAligned: buyTrendAligned,
            d1Ok: d1BuyOk,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.buyH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.buyM15AdxMin,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            pullbackOk: this.inRange(setupPullbackValue, rules.buyPullbackMin, rules.buyPullbackMax),
            rsiRangeOk: this.inRange(setupRsi, rules.buySetupRsiMin, rules.buySetupRsiMax),
            macdOk: this.isNumber(entryMacdHist) && entryMacdHist >= rules.buyMacdHistMin,
            m5MacdSlopeOk:
                rules.buyEntryMacdSlopeMin === undefined ||
                (this.isNumber(entryMacdHistSlope) && entryMacdHistSlope >= rules.buyEntryMacdSlopeMin),
            m5BbOk: rules.buyEntryBbPbMax === undefined || (this.isNumber(entryBbPb) && entryBbPb <= rules.buyEntryBbPbMax),
            m1TimingOk: m1BuyTimingOk,
        };

        const cryptoAllowedSessions =
            Array.isArray(rules.allowedSessions) && rules.allowedSessions.length
                ? rules.allowedSessions.map((session) => String(session).toUpperCase())
                : ["CRYPTO"];
        const cryptoSessionOk = normalizedSessions.some((session) => cryptoAllowedSessions.includes(session));
        const cryptoSellChecks = {
            trendAligned: sellTrendAligned,
            d1Ok: d1SellOk,
            counterTrendOk: !sellCounterTrendBlocked,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.sellH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.sellM15AdxMin,
            m15RsiOk: this.inRange(setupRsi, rules.sellSetupRsiMin, rules.sellSetupRsiMax),
            pullbackOk: this.inRange(setupPullbackValue, rules.sellPullbackMin, rules.sellPullbackMax),
            m5MacdOk: this.isNumber(entryMacdHist) && entryMacdHist <= rules.sellMacdHistMax,
            m5MacdSlopeOk:
                rules.sellEntryMacdSlopeMax === undefined ||
                (this.isNumber(entryMacdHistSlope) && entryMacdHistSlope <= rules.sellEntryMacdSlopeMax),
            m5BbOk: rules.sellEntryBbPbMin === undefined || (this.isNumber(entryBbPb) && entryBbPb >= rules.sellEntryBbPbMin),
            m1TimingOk: m1SellTimingOk,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            hourOk: this.isNumber(hourUtc) && hourUtc >= rules.sellHourStartUtc && hourUtc <= rules.sellHourEndUtc,
            sessionOk: cryptoSessionOk,
        };
        const cryptoBuyChecks = {
            trendAligned: buyTrendAligned,
            d1Ok: d1BuyOk,
            counterTrendOk: !buyCounterTrendBlocked,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.buyH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.buyM15AdxMin,
            m15RsiOk: this.inRange(setupRsi, rules.buySetupRsiMin, rules.buySetupRsiMax),
            pullbackOk: this.inRange(setupPullbackValue, rules.buyPullbackMin, rules.buyPullbackMax),
            m5MacdOk: this.isNumber(entryMacdHist) && entryMacdHist >= rules.buyMacdHistMin,
            m5MacdSlopeOk:
                rules.buyEntryMacdSlopeMin === undefined ||
                (this.isNumber(entryMacdHistSlope) && entryMacdHistSlope >= rules.buyEntryMacdSlopeMin),
            m5BbOk: rules.buyEntryBbPbMax === undefined || (this.isNumber(entryBbPb) && entryBbPb <= rules.buyEntryBbPbMax),
            m1TimingOk: m1BuyTimingOk,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            hourOk: this.isNumber(hourUtc) && hourUtc >= rules.buyHourStartUtc && hourUtc <= rules.buyHourEndUtc,
            sessionOk: cryptoSessionOk,
        };

        const forexSellOk = Object.values(forexSellChecks).every(Boolean);
        const forexBuyOk = Object.values(forexBuyChecks).every(Boolean);
        const cryptoSellOk = Object.values(cryptoSellChecks).every(Boolean);
        const cryptoBuyOk = Object.values(cryptoBuyChecks).every(Boolean);

        let signal = null;
        let patternChecks = {};

        if (selectedAssetClass === "crypto") {
            if (doubleBull && cryptoBuyOk) {
                signal = "BUY";
                patternChecks = cryptoBuyChecks;
            } else if (doubleBear && cryptoSellOk) {
                signal = "SELL";
                patternChecks = cryptoSellChecks;
            } else if (cryptoSellOk) {
                signal = "SELL";
                patternChecks = cryptoSellChecks;
            } else if (cryptoBuyOk) {
                signal = "BUY";
                patternChecks = cryptoBuyChecks;
            } else {
                patternChecks = { sell: cryptoSellChecks, buy: cryptoBuyChecks };
            }
        } else if (forexSellOk) {
            signal = "SELL";
            patternChecks = forexSellChecks;
        } else if (forexBuyOk) {
            signal = "BUY";
            patternChecks = forexBuyChecks;
        } else {
            patternChecks = { sell: forexSellChecks, buy: forexBuyChecks };
        }

        if (!signal) {
            return {
                signal: null,
                reason: "pattern_blocked",
                context: {
                    ...baseContext,
                    patternChecks,
                    gateStates: { biasOk, setupOk: false, entryOk: false },
                },
            };
        }

        if (selectedVariant === "H1_M15_M5_REGIME") {
            const regimeRules = rules?.regime ?? {};
            const regimeChecks = {
                h1AdxFloorOk: this.isNumber(biasAdx) && biasAdx >= (regimeRules.h1AdxMin ?? 0),
                m15AdxFloorOk: this.isNumber(setupAdx) && setupAdx >= (regimeRules.m15AdxMin ?? 0),
                m15AtrPctFloorOk: this.isNumber(setupAtrPct) && setupAtrPct >= (regimeRules.m15AtrPctMin ?? 0),
                m15AtrPctCeilingOk:
                    !this.isNumber(regimeRules.m15AtrPctMax) || (this.isNumber(setupAtrPct) && setupAtrPct <= regimeRules.m15AtrPctMax),
                spreadOk: !this.isNumber(regimeRules.spreadPctMax) || (this.isNumber(spreadPct) && spreadPct <= regimeRules.spreadPctMax),
                sessionOk: !regimeRules.blockNySession || !normalizedSessions.includes("NY"),
            };
            const regimeOk = Object.values(regimeChecks).every(Boolean);
            if (!regimeOk) {
                return {
                    signal: null,
                    reason: "regime_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: {
                            direction: patternChecks,
                            regime: regimeChecks,
                        },
                        gateStates: { biasOk, setupOk: true, entryOk: false },
                    },
                };
            }
            patternChecks = {
                direction: patternChecks,
                regime: regimeChecks,
            };
        }

        return {
            signal,
            reason: "pattern_confirmed",
            context: {
                ...baseContext,
                patternChecks,
                gateStates: { biasOk, setupOk: true, entryOk: true },
            },
        };
    }

    generateSignal3StageForex({ symbol, indicators, variant, market, timestamp, sessions }) {
        return this.generateSignal3Stage({ symbol, indicators, variant, assetClass: "forex", market, timestamp, sessions });
    }

    generateSignal3StageCrypto({ symbol, indicators, variant = "H1_M15_M5", market, timestamp, sessions }) {
        return this.generateSignal3Stage({ symbol, indicators, variant, assetClass: "crypto", market, timestamp, sessions });
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

    macdHistSlope(indicators) {
        const direct = indicators?.macdHistSlope;
        if (this.isNumber(direct)) return direct;
        const current = this.macdHist(indicators);
        const prev = indicators?.macdHistPrev;
        if (this.isNumber(current) && this.isNumber(prev)) return current - prev;
        return null;
    }

    bbPb(indicators) {
        const pb = indicators?.bb?.pb;
        return this.isNumber(pb) ? pb : null;
    }

    priceVsEma9(indicators) {
        const direct = indicators?.price_vs_ema9;
        if (this.isNumber(direct)) return direct;
        const price = indicators?.close ?? indicators?.lastClose;
        const ema9 = indicators?.ema9;
        if (this.isNumber(price) && this.isNumber(ema9) && ema9 !== 0) return (price - ema9) / ema9;
        return null;
    }

    atrPct(indicators) {
        const direct = indicators?.atrPct;
        if (this.isNumber(direct)) return direct;
        const atr = indicators?.atr;
        const close = indicators?.close ?? indicators?.lastClose;
        if (this.isNumber(atr) && this.isNumber(close) && close !== 0) return atr / close;
        return null;
    }

    inRange(value, min = null, max = null) {
        if (!this.isNumber(value)) return false;
        if (this.isNumber(min) && value < min) return false;
        if (this.isNumber(max) && value > max) return false;
        return true;
    }

    mergeRuleConfig(base, override) {
        const next = { ...(base || {}) };
        for (const [key, value] of Object.entries(override || {})) {
            if (key === "symbolOverrides") continue;
            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                base?.[key] &&
                typeof base[key] === "object" &&
                !Array.isArray(base[key])
            ) {
                next[key] = { ...base[key], ...value };
            } else {
                next[key] = value;
            }
        }
        return next;
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
