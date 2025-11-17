
// BackQuant Fourier For Loop indicator ported from Pine Script to JavaScript
// Original idea: "Fourier For Loop [BackQuant]" (TradingView Pine Script v5)

function dft(real, imag, dir = 1) {
    const N = real.length;
    const outReal = new Array(N);
    const outImag = new Array(N);

    for (let i = 0; i < N; i++) {
        let sumReal = 0;
        let sumImag = 0;
        const kx = i / N;
        const arg = -dir * 2 * Math.PI * kx;

        for (let k = 0; k < N; k++) {
            const cos = Math.cos(k * arg);
            const sin = Math.sin(k * arg);
            const xr = real[k];
            const xi = imag[k];

            sumReal += xr * cos - xi * sin;
            sumImag += xr * sin + xi * cos;
        }

        if (dir === 1) {
            outReal[i] = sumReal / N;
            outImag[i] = sumImag / N;
        } else {
            outReal[i] = sumReal;
            outImag[i] = sumImag;
        }
    }

    return { real: outReal, imag: outImag };
}

function computeSubjectAt(values, t, N) {
    // t is the "current bar" index (0 = oldest, values.length - 1 = newest)
    // In Pine: xval[i] means "i bars ago" from current bar
    // So we build a window of length N: window[0] = current, window[1] = 1 bar ago, ...
    if (t - (N - 1) < 0) return null;

    const x = new Array(N);
    const y = new Array(N).fill(0);

    for (let i = 0; i < N; i++) {
        const srcIndex = t - i;
        x[i] = values[srcIndex];
    }

    const { real, imag } = dft(x, y, 1);
    const r0 = real[0];
    const im0 = imag[0];

    return Math.sqrt(r0 * r0 + im0 * im0);
}

function computeScore(values, t, N, start, end) {
    const len = values.length;
    if (t < 0 || t >= len) return null;

    // We need at least N bars for each subject and up to "end" bars of lookback
    const minT = (N - 1) + end;
    if (t < minT) return null;

    const subjectNow = computeSubjectAt(values, t, N);
    if (subjectNow == null) return null;

    let score = 0;

    // Pine: for i = start to end: return_val += (subject > subject[i] ? 1 : -1)
    // subject[i] = "i bars ago", so here we compare with t - i
    for (let i = start; i <= end; i++) {
        const subjectPast = computeSubjectAt(values, t - i, N);
        if (subjectPast == null) return null;
        score += subjectNow > subjectPast ? 1 : -1;
    }

    return score;
}

/**
 * Calculate BackQuant Fourier For Loop score and signal for the latest bar.
 *
 * @param {Object} params
 * @param {number[]} params.highs - Array of high prices (oldest to newest).
 * @param {number[]} params.lows - Array of low prices (oldest to newest).
 * @param {number[]} params.closes - Array of close prices (oldest to newest).
 * @param {number} [params.N=50] - Calculation period (Fourier window length).
 * @param {number} [params.start=1] - Start offset for the for-loop comparison.
 * @param {number} [params.end=45] - End offset for the for-loop comparison.
 * @param {number} [params.upper=40] - Long threshold.
 * @param {number} [params.lower=-10] - Short threshold.
 * @returns {null | { score: number, upper: number, lower: number, isLong: boolean, isShort: boolean, out: number }}
 */
export function calculateBackQuantSignal({
    highs,
    lows,
    closes,
    N = 50,
    start = 1,
    end = 45,
    upper = 40,
    lower = -10,
} = {}) {
    if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) {
        return null;
    }

    const len = Math.min(highs.length, lows.length, closes.length);
    if (len === 0) return null;

    const hlc3 = [];
    for (let i = 0; i < len; i++) {
        const h = highs[i];
        const l = lows[i];
        const c = closes[i];

        if (h == null || l == null || c == null) {
            return null;
        }

        hlc3.push((h + l + c) / 3);
    }

    // Need enough history: N bars for each subject and "end" bars of lookback
    if (len < N + end) {
        return null;
    }

    const lastIndex = len - 1;

    const scoreNow = computeScore(hlc3, lastIndex, N, start, end);
    if (scoreNow == null) return null;

    const scorePrev = computeScore(hlc3, lastIndex - 1, N, start, end);

    const isLong = scoreNow > upper;
    const crossedUnderLower = scorePrev != null && scorePrev >= lower && scoreNow < lower;
    const isShort = crossedUnderLower;

    let out = 0;
    if (isLong && !isShort) out = 1;
    if (isShort) out = -1;

    return {
        score: scoreNow,
        upper,
        lower,
        isLong,
        isShort,
        out,
    };
}