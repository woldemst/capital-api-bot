import { STRATEGY } from "../config.js";

class Strategy {
    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    asNumber(value, fallback = null) {
        return this.isNumber(value) ? value : fallback;
    }

    pickTrend(indicator) {
        if (!indicator || typeof indicator !== "object") return "neutral";
        const { ema20, ema50, trend } = indicator;

        if (this.isNumber(ema20) && this.isNumber(ema50)) {
            if (ema20 > ema50) return "bullish";
            if (ema20 < ema50) return "bearish";
        }

        if (trend === "bullish" || trend === "bearish") return trend;
        return "neutral";
    }

    adxValue(indicators) {
        const direct = indicators?.adxValue;
        if (this.isNumber(direct)) return direct;
        const nested = indicators?.adx?.adx;
        if (this.isNumber(nested)) return nested;
        if (this.isNumber(indicators?.adx)) return indicators.adx;
        return null;
    }

    pdi(indicators) {
        const direct = this.asNumber(indicators?.pdi);
        if (this.isNumber(direct)) return direct;
        const nested = this.asNumber(indicators?.adx?.pdi);
        if (this.isNumber(nested)) return nested;
        return null;
    }

    mdi(indicators) {
        const direct = this.asNumber(indicators?.mdi);
        if (this.isNumber(direct)) return direct;
        const nested = this.asNumber(indicators?.adx?.mdi);
        if (this.isNumber(nested)) return nested;
        return null;
    }

    diTrend(indicators) {
        const pdi = this.pdi(indicators);
        const mdi = this.mdi(indicators);
        if (!this.isNumber(pdi) || !this.isNumber(mdi)) return "neutral";
        if (pdi > mdi) return "bullish";
        if (pdi < mdi) return "bearish";
        return "neutral";
    }

    macdHist(indicators) {
        if (this.isNumber(indicators?.macdHist)) return indicators.macdHist;
        if (this.isNumber(indicators?.macd?.histogram)) return indicators.macd.histogram;
        return null;
    }

    macdHistDelta(indicators) {
        if (this.isNumber(indicators?.macdHistDelta)) return indicators.macdHistDelta;
        const curr = this.macdHist(indicators);
        const prev = this.asNumber(indicators?.macdHistPrev);
        if (this.isNumber(curr) && this.isNumber(prev)) return curr - prev;
        return null;
    }

    rsi(indicators) {
        return this.asNumber(indicators?.rsi);
    }

    atr(indicators) {
        return this.asNumber(indicators?.atr);
    }

    close(indicators) {
        return this.asNumber(indicators?.close ?? indicators?.lastClose);
    }

    priceVsEma9(indicators) {
        const direct = this.asNumber(indicators?.price_vs_ema9);
        if (this.isNumber(direct)) return direct;
        const close = this.close(indicators);
        const ema9 = this.asNumber(indicators?.ema9);
        if (!this.isNumber(close) || !this.isNumber(ema9) || ema9 === 0) return null;
        return (close - ema9) / ema9;
    }

    scoreBiasTf(indicators) {
        if (!indicators) {
            return {
                bullishVotes: 0,
                bearishVotes: 0,
                bias: "none",
            };
        }

        let bullishVotes = 0;
        let bearishVotes = 0;

        if (this.isNumber(indicators.ema20) && this.isNumber(indicators.ema50)) {
            if (indicators.ema20 > indicators.ema50) bullishVotes += 1;
            if (indicators.ema20 < indicators.ema50) bearishVotes += 1;
        }

        const hist = this.macdHist(indicators);
        if (this.isNumber(hist)) {
            if (hist > 0) bullishVotes += 1;
            if (hist < 0) bearishVotes += 1;
        }

        const rsi = this.rsi(indicators);
        if (this.isNumber(rsi)) {
            if (rsi > 50) bullishVotes += 1;
            if (rsi < 50) bearishVotes += 1;
        }

        const bias = bullishVotes >= 2 ? "bullish" : bearishVotes >= 2 ? "bearish" : "none";
        return { bullishVotes, bearishVotes, bias };
    }

    countTrue(values = []) {
        return values.reduce((count, value) => (value ? count + 1 : count), 0);
    }

    scoreMidTfContradictions(indicators, bias) {
        if (!indicators || !bias || bias === "none") {
            return { score: 0, reasons: [] };
        }

        let score = 0;
        const reasons = [];
        const trend = this.pickTrend(indicators);
        const hist = this.macdHist(indicators);
        const rsi = this.rsi(indicators);

        if (bias === "bullish") {
            if (trend === "bearish") {
                score += 1;
                reasons.push("EMA_BEARISH");
            }
            if (this.isNumber(hist) && hist < 0) {
                score += 1;
                reasons.push("MACD_BEARISH");
            }
            if (this.isNumber(rsi) && rsi < 50) {
                score += 1;
                reasons.push("RSI_BEARISH");
            }
        } else if (bias === "bearish") {
            if (trend === "bullish") {
                score += 1;
                reasons.push("EMA_BULLISH");
            }
            if (this.isNumber(hist) && hist > 0) {
                score += 1;
                reasons.push("MACD_BULLISH");
            }
            if (this.isNumber(rsi) && rsi > 50) {
                score += 1;
                reasons.push("RSI_BULLISH");
            }
        }

        return { score, reasons };
    }

    evaluateHigherTfBiasAndRegime(tf) {
        const d1 = tf?.d1;
        const h4 = tf?.h4;

        const d1Bias = this.scoreBiasTf(d1);
        const h4Bias = this.scoreBiasTf(h4);

        const bullishVotes = d1Bias.bullishVotes + h4Bias.bullishVotes;
        const bearishVotes = d1Bias.bearishVotes + h4Bias.bearishVotes;
        const voteDelta = bullishVotes - bearishVotes;

        let bias = "none";
        if (d1Bias.bias === h4Bias.bias && d1Bias.bias !== "none") {
            bias = d1Bias.bias;
        } else if (bullishVotes >= 4 && voteDelta >= 2) {
            bias = "bullish";
        } else if (bearishVotes >= 4 && voteDelta <= -2) {
            bias = "bearish";
        }

        const adxValues = [this.adxValue(d1), this.adxValue(h4)].filter((v) => this.isNumber(v));
        const adxComposite = adxValues.length ? adxValues.reduce((sum, value) => sum + value, 0) / adxValues.length : null;

        let regime = "RANGE";
        if (this.isNumber(adxComposite)) {
            if (adxComposite >= STRATEGY.REGIME.TREND_ADX) regime = "TREND";
            else if (adxComposite >= STRATEGY.REGIME.TRANSITION_ADX) regime = "TRANSITION";
            else regime = "RANGE";
        }

        return {
            regime,
            bias,
            adxComposite,
            votes: {
                bullish: bullishVotes,
                bearish: bearishVotes,
                d1Bias: d1Bias.bias,
                h4Bias: h4Bias.bias,
            },
        };
    }

    evaluateMidTfAlignment(tf, bias, regime) {
        const h1 = tf?.h1;
        const m15 = tf?.m15;
        const reasons = [];

        const h1Trend = this.pickTrend(h1);
        const m15Trend = this.pickTrend(m15);
        const h1Adx = this.adxValue(h1);
        const m15Adx = this.adxValue(m15);
        const h1DiTrend = this.diTrend(h1);
        const m15DiTrend = this.diTrend(m15);

        const h1AtrPct = this.isNumber(this.atr(h1)) && this.isNumber(this.close(h1)) && this.close(h1) !== 0 ? this.atr(h1) / this.close(h1) : null;
        const m15AtrPct = this.isNumber(this.atr(m15)) && this.isNumber(this.close(m15)) && this.close(m15) !== 0 ? this.atr(m15) / this.close(m15) : null;

        const atrPctValues = [h1AtrPct, m15AtrPct].filter((v) => this.isNumber(v));
        const atrPctComposite = atrPctValues.length ? atrPctValues.reduce((sum, value) => sum + value, 0) / atrPctValues.length : null;

        if (!this.isNumber(atrPctComposite) || atrPctComposite < STRATEGY.MID_TF.MIN_ATR_PCT) {
            reasons.push("ATR_TOO_LOW");
        }

        const minH1Adx = this.asNumber(STRATEGY.MID_TF.MIN_H1_ADX, 18);
        const minM15Adx = this.asNumber(STRATEGY.MID_TF.MIN_M15_ADX, 20);
        const hasH1Strength = this.isNumber(h1Adx) && h1Adx >= minH1Adx;
        const hasM15Strength = this.isNumber(m15Adx) && m15Adx >= minM15Adx;
        if (!hasH1Strength && !hasM15Strength) {
            reasons.push("MID_TF_ADX_TOO_LOW");
        }

        if (Boolean(STRATEGY.MID_TF.REQUIRE_DI_ALIGNMENT)) {
            if (bias === "bullish" && h1DiTrend === "bearish" && m15DiTrend === "bearish") {
                reasons.push("MID_TF_DI_BEARISH");
            }
            if (bias === "bearish" && h1DiTrend === "bullish" && m15DiTrend === "bullish") {
                reasons.push("MID_TF_DI_BULLISH");
            }
        }

        if (regime === "TREND" || regime === "TRANSITION") {
            const h1Contradictions = this.scoreMidTfContradictions(h1, bias);
            const m15Contradictions = this.scoreMidTfContradictions(m15, bias);
            const contradictionScore = h1Contradictions.score + m15Contradictions.score;
            const maxContradictionScore = Number.isFinite(STRATEGY.MID_TF.MAX_CONTRADICTION_SCORE)
                ? STRATEGY.MID_TF.MAX_CONTRADICTION_SCORE
                : 4;

            if (contradictionScore >= maxContradictionScore) {
                reasons.push("MID_TF_STRONG_CONTRADICTION");
            }

            return {
                aligned: reasons.length === 0,
                reasons,
                h1Trend,
                m15Trend,
                h1Adx,
                m15Adx,
                h1DiTrend,
                m15DiTrend,
                atrPctComposite,
                contradictionScore,
                contradictionReasons: {
                    h1: h1Contradictions.reasons,
                    m15: m15Contradictions.reasons,
                },
            };
        }

        return {
            aligned: reasons.length === 0,
            reasons,
            h1Trend,
            m15Trend,
            h1Adx,
            m15Adx,
            h1DiTrend,
            m15DiTrend,
            atrPctComposite,
        };
    }

    evaluateTrendEntry(tf, bias, regime = "TREND") {
        const m5 = tf?.m5;
        const m1 = tf?.m1;
        const reasons = [];

        const m5Close = this.close(m5);
        const m5Ema20 = this.asNumber(m5?.ema20);
        const m5Atr = this.atr(m5);
        const m5BbPb = this.asNumber(m5?.bb?.pb);
        const m5Rsi = this.rsi(m5);
        const m5DiTrend = this.diTrend(m5);
        const m5Hist = this.macdHist(m5);
        const m5HistDelta = this.macdHistDelta(m5);

        const m1Rsi = this.rsi(m1);
        const m1RsiPrev = this.asNumber(m1?.rsiPrev);
        const m1PriceVsEma9 = this.priceVsEma9(m1);

        const closeToEma20 =
            this.isNumber(m5Close) && this.isNumber(m5Ema20) && this.isNumber(m5Atr)
                ? Math.abs(m5Close - m5Ema20) <= m5Atr * STRATEGY.ENTRY.M5_PULLBACK_ATR_MULT
                : false;

        const requiredConfirmations =
            regime === "TRANSITION" ? STRATEGY.ENTRY.MIN_CONFIRMATIONS_TRANSITION : STRATEGY.ENTRY.MIN_CONFIRMATIONS_TREND;
        const requirePullback = Boolean(STRATEGY.ENTRY.REQUIRE_PULLBACK);
        const requireMomentum = Boolean(STRATEGY.ENTRY.REQUIRE_M5_MOMENTUM);
        const requireM1Confirmation = Boolean(STRATEGY.ENTRY.REQUIRE_M1_CONFIRMATION);

        if (bias === "bullish") {
            const pullback = closeToEma20 || (this.isNumber(m5BbPb) && m5BbPb <= STRATEGY.ENTRY.M5_PULLBACK_BB_LOWER_MAX);
            const momentumM5 =
                this.isNumber(m5Hist) &&
                m5Hist > 0 &&
                (!this.isNumber(m5HistDelta) || m5HistDelta > 0);
            const m1RsiRecover = this.isNumber(m1Rsi) && this.isNumber(m1RsiPrev) && m1RsiPrev < STRATEGY.ENTRY.M1_RSI_PIVOT && m1Rsi >= STRATEGY.ENTRY.M1_RSI_PIVOT;
            const m1Confirm =
                (this.isNumber(m1Rsi) && m1Rsi >= this.asNumber(STRATEGY.ENTRY.M1_RSI_LONG_MIN, 50) && this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 > 0) ||
                (m1RsiRecover && this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 > 0);
            const m5RsiGate = !this.isNumber(m5Rsi) || m5Rsi >= this.asNumber(STRATEGY.ENTRY.M5_RSI_LONG_MIN, 48);
            const diGate = m5DiTrend !== "bearish";
            const confirmationScore = this.countTrue([pullback, momentumM5, m1Confirm, m5RsiGate, diGate]);
            const hasEnoughConfirmations = confirmationScore >= requiredConfirmations;
            const mandatoryPass =
                (!requirePullback || pullback) &&
                (!requireMomentum || momentumM5) &&
                (!requireM1Confirmation || m1Confirm) &&
                m5RsiGate &&
                diGate;
            const triggered = mandatoryPass && hasEnoughConfirmations;

            if (requirePullback && !pullback) reasons.push("NO_BULL_PULLBACK");
            if (!momentumM5) reasons.push("M5_MOMENTUM_NOT_TURNING_UP");
            if (!m1Confirm) reasons.push("M1_CONFIRMATION_MISSING");
            if (!m5RsiGate) reasons.push("M5_RSI_TOO_LOW_FOR_LONG");
            if (!diGate) reasons.push("M5_DI_BEARISH");
            if (!hasEnoughConfirmations) reasons.push("ENTRY_CONFIRMATION_SCORE_TOO_LOW");

            return {
                triggered,
                reasons,
                checks: { pullback, momentumM5, m1Confirm, m5RsiGate, diGate, confirmationScore, requiredConfirmations },
            };
        }

        if (bias === "bearish") {
            const pullback = closeToEma20 || (this.isNumber(m5BbPb) && m5BbPb >= STRATEGY.ENTRY.M5_PULLBACK_BB_UPPER_MIN);
            const momentumM5 =
                this.isNumber(m5Hist) &&
                m5Hist < 0 &&
                (!this.isNumber(m5HistDelta) || m5HistDelta < 0);
            const m1RsiRecover = this.isNumber(m1Rsi) && this.isNumber(m1RsiPrev) && m1RsiPrev > STRATEGY.ENTRY.M1_RSI_PIVOT && m1Rsi <= STRATEGY.ENTRY.M1_RSI_PIVOT;
            const m1Confirm =
                (this.isNumber(m1Rsi) && m1Rsi <= this.asNumber(STRATEGY.ENTRY.M1_RSI_SHORT_MAX, 50) && this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 < 0) ||
                (m1RsiRecover && this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 < 0);
            const m5RsiGate = !this.isNumber(m5Rsi) || m5Rsi <= this.asNumber(STRATEGY.ENTRY.M5_RSI_SHORT_MAX, 52);
            const diGate = m5DiTrend !== "bullish";
            const confirmationScore = this.countTrue([pullback, momentumM5, m1Confirm, m5RsiGate, diGate]);
            const hasEnoughConfirmations = confirmationScore >= requiredConfirmations;
            const mandatoryPass =
                (!requirePullback || pullback) &&
                (!requireMomentum || momentumM5) &&
                (!requireM1Confirmation || m1Confirm) &&
                m5RsiGate &&
                diGate;
            const triggered = mandatoryPass && hasEnoughConfirmations;

            if (requirePullback && !pullback) reasons.push("NO_BEAR_PULLBACK");
            if (!momentumM5) reasons.push("M5_MOMENTUM_NOT_TURNING_DOWN");
            if (!m1Confirm) reasons.push("M1_CONFIRMATION_MISSING");
            if (!m5RsiGate) reasons.push("M5_RSI_TOO_HIGH_FOR_SHORT");
            if (!diGate) reasons.push("M5_DI_BULLISH");
            if (!hasEnoughConfirmations) reasons.push("ENTRY_CONFIRMATION_SCORE_TOO_LOW");

            return {
                triggered,
                reasons,
                checks: { pullback, momentumM5, m1Confirm, m5RsiGate, diGate, confirmationScore, requiredConfirmations },
            };
        }

        reasons.push("NO_BIAS");
        return {
            triggered: false,
            reasons,
            checks: {},
        };
    }

    evaluateBiasReversionEntry(tf, bias, phaseC = {}) {
        const cfg = STRATEGY.BIAS_REVERSION || {};
        if (!cfg.ENABLED) {
            return { triggered: false, signal: null, reasons: ["BIAS_REVERSION_DISABLED"], checks: {} };
        }

        const requirePhaseCMisalignment = Boolean(cfg.REQUIRE_PHASE_C_MISALIGNMENT);
        if (requirePhaseCMisalignment && phaseC?.aligned !== false) {
            return { triggered: false, signal: null, reasons: ["PHASE_C_NOT_MISALIGNED"], checks: {} };
        }

        const m5 = tf?.m5;
        const m1 = tf?.m1;
        const reasons = [];

        const m5Pb = this.asNumber(m5?.bb?.pb);
        const m5Rsi = this.rsi(m5);
        const m5HistDelta = this.macdHistDelta(m5);
        const m1Rsi = this.rsi(m1);
        const m1PriceVsEma9 = this.priceVsEma9(m1);

        const requireM1PriceConfirm = Boolean(cfg.REQUIRE_M1_PRICE_E9_CONFIRM);
        const requireM5DeltaConfirm = Boolean(cfg.REQUIRE_M5_MACD_DELTA_CONFIRM);

        if (bias === "bearish") {
            const pbGate = this.isNumber(m5Pb) && m5Pb >= this.asNumber(cfg.M5_BB_PB_SHORT_MIN, 0.7);
            const m5RsiGate = this.isNumber(m5Rsi) && m5Rsi >= this.asNumber(cfg.M5_RSI_SHORT_MIN, 55);
            const m1RsiGate = this.isNumber(m1Rsi) && m1Rsi >= this.asNumber(cfg.M1_RSI_SHORT_MIN, 55);
            const m1PriceGate = this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 > 0;
            const m5DeltaGate = this.isNumber(m5HistDelta) && m5HistDelta > 0;

            if (!pbGate) reasons.push("BIAS_REVERSION_PB_NOT_HIGH_ENOUGH");
            if (!m5RsiGate) reasons.push("BIAS_REVERSION_M5_RSI_NOT_HIGH");
            if (!m1RsiGate) reasons.push("BIAS_REVERSION_M1_RSI_NOT_HIGH");
            if (requireM1PriceConfirm && !m1PriceGate) reasons.push("BIAS_REVERSION_M1_PRICE_CONFIRM_MISSING");
            if (requireM5DeltaConfirm && !m5DeltaGate) reasons.push("BIAS_REVERSION_M5_DELTA_CONFIRM_MISSING");

            const triggered = pbGate && m5RsiGate && m1RsiGate && (!requireM1PriceConfirm || m1PriceGate) && (!requireM5DeltaConfirm || m5DeltaGate);
            return {
                triggered,
                signal: triggered ? "SELL" : null,
                reasons,
                checks: {
                    pbGate,
                    m5RsiGate,
                    m1RsiGate,
                    m1PriceGate,
                    m5DeltaGate,
                },
            };
        }

        if (bias === "bullish") {
            const pbGate = this.isNumber(m5Pb) && m5Pb <= this.asNumber(cfg.M5_BB_PB_LONG_MAX, 0.3);
            const m5RsiGate = this.isNumber(m5Rsi) && m5Rsi <= this.asNumber(cfg.M5_RSI_LONG_MAX, 45);
            const m1RsiGate = this.isNumber(m1Rsi) && m1Rsi <= this.asNumber(cfg.M1_RSI_LONG_MAX, 45);
            const m1PriceGate = this.isNumber(m1PriceVsEma9) && m1PriceVsEma9 < 0;
            const m5DeltaGate = this.isNumber(m5HistDelta) && m5HistDelta < 0;

            if (!pbGate) reasons.push("BIAS_REVERSION_PB_NOT_LOW_ENOUGH");
            if (!m5RsiGate) reasons.push("BIAS_REVERSION_M5_RSI_NOT_LOW");
            if (!m1RsiGate) reasons.push("BIAS_REVERSION_M1_RSI_NOT_LOW");
            if (requireM1PriceConfirm && !m1PriceGate) reasons.push("BIAS_REVERSION_M1_PRICE_CONFIRM_MISSING");
            if (requireM5DeltaConfirm && !m5DeltaGate) reasons.push("BIAS_REVERSION_M5_DELTA_CONFIRM_MISSING");

            const triggered = pbGate && m5RsiGate && m1RsiGate && (!requireM1PriceConfirm || m1PriceGate) && (!requireM5DeltaConfirm || m5DeltaGate);
            return {
                triggered,
                signal: triggered ? "BUY" : null,
                reasons,
                checks: {
                    pbGate,
                    m5RsiGate,
                    m1RsiGate,
                    m1PriceGate,
                    m5DeltaGate,
                },
            };
        }

        return { triggered: false, signal: null, reasons: ["NO_BIAS"], checks: {} };
    }

    generateSignal({ indicators }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const phaseB = this.evaluateHigherTfBiasAndRegime(indicators);
        const transitionAllowed = Boolean(STRATEGY.REGIME.ALLOW_TRANSITION_ENTRIES);
        const isTradeableRegime = phaseB.regime === "TREND" || (phaseB.regime === "TRANSITION" && transitionAllowed);
        if (!isTradeableRegime) {
            return {
                signal: null,
                reason: "regime_not_tradeable",
                context: {
                    phase: "B",
                    reasonCodes: ["REGIME_NOT_TRADEABLE"],
                    regime: phaseB.regime,
                    bias: phaseB.bias,
                    phaseB,
                },
            };
        }

        if (phaseB.bias === "none") {
            return {
                signal: null,
                reason: "no_clear_bias",
                context: {
                    phase: "B",
                    reasonCodes: ["NO_CLEAR_HIGHER_TF_BIAS"],
                    regime: phaseB.regime,
                    bias: phaseB.bias,
                    phaseB,
                },
            };
        }

        const phaseC = this.evaluateMidTfAlignment(indicators, phaseB.bias, phaseB.regime);
        if (!phaseC.aligned) {
            const phaseR = this.evaluateBiasReversionEntry(indicators, phaseB.bias, phaseC);
            if (phaseR.triggered && phaseR.signal) {
                return {
                    signal: phaseR.signal,
                    reason: "bias_reversion_entry",
                    context: {
                        phase: "R",
                        reasonCodes: ["BIAS_REVERSION_ENTRY_CONFIRMED"],
                        regime: phaseB.regime,
                        bias: phaseB.bias,
                        phaseB,
                        phaseC,
                        phaseR,
                    },
                };
            }

            return {
                signal: null,
                reason: "mid_tf_not_aligned",
                context: {
                    phase: "C",
                    reasonCodes: phaseC.reasons,
                    regime: phaseB.regime,
                    bias: phaseB.bias,
                    phaseB,
                    phaseC,
                },
            };
        }

        const phaseD = this.evaluateTrendEntry(indicators, phaseB.bias, phaseB.regime);
        if (!phaseD.triggered) {
            return {
                signal: null,
                reason: "entry_not_triggered",
                context: {
                    phase: "D",
                    reasonCodes: phaseD.reasons,
                    regime: phaseB.regime,
                    bias: phaseB.bias,
                    phaseB,
                    phaseC,
                    phaseD,
                },
            };
        }

        return {
            signal: phaseB.bias === "bullish" ? "BUY" : "SELL",
            reason: "mtf_trend_entry",
            context: {
                phase: "D",
                reasonCodes: ["TREND_ENTRY_CONFIRMED"],
                regime: phaseB.regime,
                bias: phaseB.bias,
                phaseB,
                phaseC,
                phaseD,
            },
        };
    }
}

export default new Strategy();
