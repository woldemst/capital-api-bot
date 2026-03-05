import crypto from "crypto";

function sanitizeForHash(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item) => sanitizeForHash(item));
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;

    const t = typeof value;
    if (t === "number") return Number.isFinite(value) ? value : null;
    if (t === "string" || t === "boolean") return value;
    if (t !== "object") return null;

    const out = {};
    for (const key of Object.keys(value).sort()) {
        const next = sanitizeForHash(value[key]);
        if (next === undefined) continue;
        out[key] = next;
    }
    return out;
}

export function computeConfigHash(input, { hashLength = 16 } = {}) {
    try {
        const stable = JSON.stringify(sanitizeForHash(input));
        const digest = crypto.createHash("sha256").update(stable).digest("hex");
        const len = Number.isFinite(Number(hashLength)) ? Math.max(6, Number(hashLength)) : 16;
        return digest.slice(0, len);
    } catch {
        return null;
    }
}

