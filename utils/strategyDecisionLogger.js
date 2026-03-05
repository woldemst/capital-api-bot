import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "backtest", "decision-logs");

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function sanitizeSymbol(symbol = "unknown") {
    return String(symbol || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cloneJson(value) {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function toIso(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function getDecisionLogPath(symbol = "unknown") {
    ensureLogDir();
    return path.join(LOG_DIR, `${sanitizeSymbol(symbol)}.jsonl`);
}

export function logStrategyDecision(entry = {}) {
    const symbol = String(entry.symbol || "unknown").toUpperCase();
    const payload = {
        symbol,
        timestamp: toIso(entry.timestamp) || new Date().toISOString(),
        phase: String(entry.phase || "unknown"),
        event: String(entry.event || "unknown"),
        strategyId: entry.strategyId ? String(entry.strategyId) : null,
        strategyName: entry.strategyName ? String(entry.strategyName) : null,
        configHash: entry.configHash ? String(entry.configHash) : null,
        signal: entry.signal ? String(entry.signal).toUpperCase() : null,
        side: entry.side ? String(entry.side).toUpperCase() : null,
        blockReason: entry.blockReason ? String(entry.blockReason) : null,
        reason: entry.reason ? String(entry.reason) : null,
        sessions: Array.isArray(entry.sessions) ? entry.sessions : [],
        guard: cloneJson(entry.guard),
        snapshot: cloneJson(entry.snapshot),
        decision: cloneJson(entry.decision),
        orderPlan: cloneJson(entry.orderPlan),
        execution: cloneJson(entry.execution),
        metadata: cloneJson(entry.metadata),
        loggedAt: new Date().toISOString(),
    };

    ensureLogDir();
    fs.appendFileSync(getDecisionLogPath(symbol), JSON.stringify(payload) + "\n");
}

