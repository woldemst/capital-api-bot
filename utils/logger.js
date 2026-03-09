import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "backtest", "logs");
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    trade: 2,
    debug: 3,
};

const activeLogLevel = String(process.env.LOG_LEVEL || "debug").toLowerCase();
const activeLevelValue = LOG_LEVELS[activeLogLevel] ?? LOG_LEVELS.info;
const shouldLog = (level) => LOG_LEVELS[level] <= activeLevelValue;
const dashboardMode = String(process.env.CLI_DASHBOARD || "auto").trim().toLowerCase();
const entryScriptName = path.basename(process.argv?.[1] || "");
const dashboardEligibleContext = entryScriptName === "bot.js";

const DASHBOARD_ENABLED =
    Boolean(process.stdout?.isTTY) &&
    String(process.env.PM2_HOME || "").trim() === "" &&
    (dashboardMode === "1" || dashboardMode === "true" || ((dashboardMode === "auto" || dashboardMode === "") && dashboardEligibleContext));
const DASHBOARD_WIDTH_MIN = 110;
const DASHBOARD_WIDTH_MAX = 168;
const TABLE_COLUMNS = [
    { key: "symbol", label: "SYM", width: 8, align: "left" },
    { key: "status", label: "STATUS", width: 14, align: "left" },
    { key: "session", label: "SES", width: 9, align: "left" },
    { key: "regime", label: "REGIME", width: 9, align: "left" },
    { key: "adx", label: "ADX", width: 7, align: "right" },
    { key: "setup", label: "SETUP", width: 14, align: "left" },
    { key: "trigger", label: "TRG", width: 5, align: "left" },
];
const ANSI = {
    reset: "\u001b[0m",
    cyan: "\u001b[36m",
    brightCyan: "\u001b[96m",
    green: "\u001b[92m",
    yellow: "\u001b[93m",
    red: "\u001b[91m",
    dim: "\u001b[2m",
    white: "\u001b[97m",
};
const dashboardState = {
    startedAt: new Date().toISOString(),
    strategy: "-",
    hubStatus: "-",
    sessionStatus: "BOOTING",
    mode: "-",
    analysisIntervalMs: "-",
    nextRefreshMinutes: "-",
    liveSymbols: [],
    activeSessions: [],
    tradableSymbols: [],
    currentSymbol: "-",
    openTrades: "-",
    maxTrades: "-",
    balance: "-",
    availMargin: "-",
    brokerOpenNow: "-",
    trailingOpenPositions: "-",
    blockedSummary: "-",
    blockedDetail: [],
    recentEvents: [],
    symbolRows: new Map(),
    initialized: false,
};
const repeatLogState = new Map();
const REPEAT_SUPPRESSION_RULES = [
    {
        level: "info",
        pattern: /^\[DealID Monitor\] tick .* \| openNow=(\d+)$/,
        key: (match) => `dealid:${match[1]}`,
        intervalMs: 5 * 60 * 1000,
    },
    {
        level: "info",
        pattern: /^\[Monitoring\] Trailing stop check .* open positions: (\d+)$/,
        key: (match) => `trailing:${match[1]}`,
        intervalMs: 5 * 60 * 1000,
    },
    {
        level: "info",
        pattern: /^\[Bot\] Active sessions \(UTC\): (.+)$/,
        key: (match) => `active_sessions:${match[1]}`,
        intervalMs: 10 * 60 * 1000,
    },
    {
        level: "info",
        pattern: /^\[Bot\]\[Filter\] Blocked summary: (.+)$/,
        key: (match) => `blocked_summary:${match[1]}`,
        intervalMs: 10 * 60 * 1000,
    },
    {
        level: "debug",
        pattern: /^\[Bot\]\[Filter\] Blocked detail: (.+)$/,
        key: (match) => `blocked_detail:${match[1]}`,
        intervalMs: 10 * 60 * 1000,
    },
    {
        level: "warn",
        pattern: /^\[Bot\]\[Filter\] All session symbols were filtered out this tick\. (.+)$/,
        key: (match) => `all_filtered:${match[1]}`,
        intervalMs: 10 * 60 * 1000,
    },
    {
        level: "info",
        pattern: /^\[Analyze\] Processing ([A-Z0-9]+)$/,
        key: (match) => `analyze:${match[1]}`,
        intervalMs: 5 * 60 * 1000,
    },
    {
        level: "debug",
        pattern: /^\[CandleFetch\] ([A-Z0-9]+): fetched (.+)$/,
        key: (match) => `candlefetch:${match[1]}:${match[2]}`,
        intervalMs: 5 * 60 * 1000,
    },
    {
        level: "info",
        pattern: /^\[ProcessPrice\] Open trades: (\d+\/\d+) \| Balance: ([^|]+) \| AvailMargin: (.+)$/,
        key: (match) => `process_price:${match[1]}:${match[2].trim()}:${match[3].trim()}`,
        intervalMs: 5 * 60 * 1000,
    },
];

function toConsolePayload(message, error = null) {
    if (typeof message === "object") {
        return `${JSON.stringify(message, null, 2)}${error ? `\n${String(error)}` : ""}`;
    }
    return error ? `${String(message)} ${String(error)}` : String(message);
}

function stripAnsi(text) {
    return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function supportsColor() {
    if (!DASHBOARD_ENABLED) return false;
    if (String(process.env.NO_COLOR || "").trim() === "1") return false;
    return true;
}

function colorize(text, color) {
    if (!supportsColor()) return text;
    const prefix = ANSI[color];
    return prefix ? `${prefix}${text}${ANSI.reset}` : text;
}

function truncate(text, maxLength) {
    const raw = String(text ?? "-");
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, Math.max(0, maxLength - 3))}...`;
}

function pad(text, width, align = "left") {
    const raw = truncate(text, width);
    if (raw.length >= width) return raw;
    return align === "right" ? raw.padStart(width, " ") : raw.padEnd(width, " ");
}

function splitCsv(value) {
    return String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

function shortTime(isoString) {
    const raw = String(isoString || "");
    const match = raw.match(/T(\d{2}:\d{2}:\d{2})/);
    return match ? match[1] : raw.slice(11, 19) || "-";
}

function dashboardWidth() {
    const cols = Number(process.stdout?.columns) || 140;
    return Math.max(DASHBOARD_WIDTH_MIN, Math.min(DASHBOARD_WIDTH_MAX, cols - 2));
}

function ensureDashboardInit() {
    if (!DASHBOARD_ENABLED || dashboardState.initialized) return;
    dashboardState.initialized = true;
    try {
        process.stdout.write("\u001b[?25l");
    } catch {
        // ignore
    }

    const cleanup = () => {
        try {
            process.stdout.write(`${ANSI.reset}\u001b[?25h`);
        } catch {
            // ignore
        }
    };
    const handleSignal = (exitCode) => {
        cleanup();
        process.exit(exitCode);
    };

    process.once("exit", cleanup);
    process.once("SIGINT", () => handleSignal(130));
    process.once("SIGTERM", () => handleSignal(143));
}

function border(width, char = "=") {
    return colorize(`+${char.repeat(Math.max(8, width - 2))}+`, char === "=" ? "brightCyan" : "cyan");
}

function frameLine(content, width, color = "white") {
    const innerWidth = Math.max(8, width - 4);
    const clipped = pad(content, innerWidth);
    const edge = colorize("|", "cyan");
    return `${edge} ${colorize(clipped, color)} ${edge}`;
}

function statusColor(status) {
    const raw = String(status || "").toUpperCase();
    if (raw.startsWith("SIGNAL") || raw === "OPEN") return "green";
    if (raw.includes("BLOCK") || raw.includes("ERROR")) return "red";
    if (raw.includes("WAIT") || raw === "PROCESSING" || raw === "SCANNING") return "yellow";
    return "white";
}

function ensureSymbolRow(symbol) {
    const key = String(symbol || "").toUpperCase();
    if (!key) return null;
    if (!dashboardState.symbolRows.has(key)) {
        dashboardState.symbolRows.set(key, {
            symbol: key,
            status: "IDLE",
            session: "-",
            regime: "-",
            adx: "-",
            setup: "-",
            trigger: "-",
            note: "-",
            updatedAt: dashboardState.startedAt,
        });
    }
    return dashboardState.symbolRows.get(key);
}

function updateSymbolRow(symbol, patch = {}) {
    const row = ensureSymbolRow(symbol);
    if (!row) return;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
}

function pushRecentEvent(level, message, timestamp) {
    const raw = stripAnsi(String(message || "").replace(/\s+/g, " ").trim());
    if (!raw) return;
    const noisyPrefixes = ["[DealID Monitor] tick", "[Signal]["];
    if (noisyPrefixes.some((prefix) => raw.startsWith(prefix))) return;
    dashboardState.recentEvents.unshift({
        time: shortTime(timestamp),
        level: String(level || "info").toUpperCase(),
        text: truncate(raw, 118),
    });
    dashboardState.recentEvents = dashboardState.recentEvents.slice(0, 8);
}

function parseActiveSessions(text) {
    const markerA = "Active sessions (UTC): ";
    const markerB = ", Session symbols: ";
    const markerC = ", Tradable symbols: ";
    const idxA = text.indexOf(markerA);
    const idxB = text.indexOf(markerB);
    const idxC = text.indexOf(markerC);
    if (idxA === -1 || idxB === -1 || idxC === -1) return false;
    const head = text.slice(idxA + markerA.length, idxB).trim();
    const tradableText = text.slice(idxC + markerC.length).trim();
    const sessionMatch = head.match(/\(([^)]*)\)/);
    dashboardState.activeSessions = splitCsv(sessionMatch?.[1] || "");
    dashboardState.tradableSymbols = splitCsv(tradableText);
    return true;
}

function parseBlockedDetails(text) {
    const match = text.match(/\[Bot\]\[Filter\] Blocked detail: (.+)$/);
    if (!match) return false;
    const entries = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    dashboardState.blockedDetail = entries;
    for (const entry of entries) {
        const [symbolRaw, reasonRaw] = entry.split(":");
        const symbol = String(symbolRaw || "").toUpperCase();
        const reason = String(reasonRaw || "").trim();
        if (!dashboardState.liveSymbols.includes(symbol)) continue;
        updateSymbolRow(symbol, {
            status: reason === "strategy_session_filter" ? "SESSION_BLOCK" : "BLOCKED",
            note: reason,
        });
    }
    return true;
}

function parseMessage(level, message, timestamp) {
    const text = String(message || "");

    if (text.startsWith("[Strategy]")) {
        dashboardState.strategy = text.replace("[Strategy] ", "");
        return;
    }

    let match = text.match(/^\[Bot\] LIVE_SYMBOLS filter active \((\d+)\): (.+)$/);
    if (match) {
        dashboardState.liveSymbols = splitCsv(match[2]);
        for (const symbol of dashboardState.liveSymbols) ensureSymbolRow(symbol);
        return;
    }

    if (text === "Session started") {
        dashboardState.sessionStatus = "UP";
        return;
    }

    match = text.match(/^\[(DEV|PROD)\] Setting up analysis interval: (\d+)ms$/);
    if (match) {
        dashboardState.mode = match[1];
        dashboardState.analysisIntervalMs = match[2];
        return;
    }

    match = text.match(/^\[Bot\] Scheduled session refresh at midnight in ([0-9.]+) minutes\.$/);
    if (match) {
        dashboardState.nextRefreshMinutes = match[1];
        return;
    }

    match = text.match(/^\[Hub\] API\/UI listening on (.+)$/);
    if (match) {
        dashboardState.hubStatus = `LISTEN ${match[1]}`;
        return;
    }

    if (text.startsWith("[Hub] Port ") && text.includes("already in use")) {
        dashboardState.hubStatus = "PORT_IN_USE";
        return;
    }

    if (parseActiveSessions(text)) return;

    match = text.match(/^\[Bot\]\[Filter\] Blocked summary: (.+)$/);
    if (match) {
        dashboardState.blockedSummary = match[1];
        return;
    }

    if (parseBlockedDetails(text)) return;

    match = text.match(/^\[Analyze\] Processing ([A-Z0-9]+)$/);
    if (match) {
        dashboardState.currentSymbol = match[1];
        if (dashboardState.liveSymbols.includes(match[1])) {
            updateSymbolRow(match[1], { status: "SCANNING", note: "analyzing" });
        }
        return;
    }

    match = text.match(/^\[CandleFetch\] ([A-Z0-9]+): fetched (.+)$/);
    if (match) {
        if (dashboardState.liveSymbols.includes(match[1])) {
            updateSymbolRow(match[1], { status: "PROCESSING", note: truncate(match[2], 36) });
        }
        return;
    }

    match = text.match(/^\[ProcessPrice\] Open trades: (\d+)\/(\d+) \| Balance: ([^|]+) \| AvailMargin: (.+)$/);
    if (match) {
        dashboardState.openTrades = match[1];
        dashboardState.maxTrades = match[2];
        dashboardState.balance = match[3].trim();
        dashboardState.availMargin = match[4].trim();
        return;
    }

    match = text.match(/^\[DealID Monitor\].*openNow=(\d+)$/);
    if (match) {
        dashboardState.brokerOpenNow = match[1];
        return;
    }

    match = text.match(/^\[Monitoring\] Trailing stop check .* open positions: (\d+)$/);
    if (match) {
        dashboardState.trailingOpenPositions = match[1];
        return;
    }

    match = text.match(/^\[Signal\] ([A-Z0-9]+): no intraday signal \| blocker=([^|]+) \| session=([^|]+) \| regime=([^|]+) \| adx=([^|]+) \| setup=([^|]+) \| trigger=(.+)$/);
    if (match) {
        const [, symbol, blocker, session, regime, adx, setup, trigger] = match;
        updateSymbolRow(symbol, {
            status: blocker.trim(),
            session: session.trim(),
            regime: regime.trim(),
            adx: adx.trim(),
            setup: setup.trim(),
            trigger: trigger.trim(),
            note: blocker.trim(),
        });
        return;
    }

    match = text.match(/^\[Signal\] ([A-Z0-9]+): (BUY|SELL) \(([^/]+) \/ ([^)]+)\)$/);
    if (match) {
        const [, symbol, side, regime, setup] = match;
        updateSymbolRow(symbol, {
            status: `SIGNAL_${side}`,
            regime: regime.trim(),
            setup: setup.trim(),
            trigger: "yes",
            note: side.trim(),
        });
        return;
    }

    match = text.match(/^\[ProcessPrice\] ([A-Z0-9]+) blocked: snapshot_invalid:(.+)$/);
    if (match) {
        updateSymbolRow(match[1], {
            status: "SNAPSHOT_BLOCK",
            note: truncate(match[2], 36),
        });
        return;
    }

    match = text.match(/^\[ProcessPrice\] Risk guard blocked ([A-Z0-9]+): (.+)$/);
    if (match) {
        updateSymbolRow(match[1], {
            status: "RISK_BLOCK",
            note: truncate(match[2], 36),
        });
        return;
    }

    match = text.match(/^\[Order\] OPENED ([A-Z0-9]+) (BUY|SELL) /);
    if (match) {
        updateSymbolRow(match[1], {
            status: "OPEN",
            trigger: "yes",
            note: match[2],
        });
        return;
    }

    match = text.match(/^\[ProcessPrice\] ([A-Z0-9]+) already in market\.$/);
    if (match) {
        updateSymbolRow(match[1], {
            status: "OPEN",
            note: "already_in_market",
        });
        return;
    }

    match = text.match(/^\[ProcessPrice\] Max trades reached\. Skipping ([A-Z0-9]+)\.$/);
    if (match) {
        updateSymbolRow(match[1], {
            status: "MAX_POSITIONS",
            note: "portfolio_limit",
        });
    }
}

function buildSymbolTable(width) {
    const baseWidth = TABLE_COLUMNS.reduce((sum, col) => sum + col.width, 0) + (TABLE_COLUMNS.length - 1) * 3;
    const noteWidth = Math.max(18, width - 6 - baseWidth - "NOTE".length - 3);
    const header = [...TABLE_COLUMNS.map((col) => pad(col.label, col.width)), pad("NOTE", noteWidth)].join(" | ");
    const divider = `${"-".repeat(Math.max(3, width - 4))}`;
    const rows = [header, divider];

    const orderedSymbols = dashboardState.liveSymbols.length ? dashboardState.liveSymbols : [...dashboardState.symbolRows.keys()].sort();
    for (const symbol of orderedSymbols) {
        const row = ensureSymbolRow(symbol);
        const cells = [
            pad(row.symbol, 8),
            pad(row.status, 14),
            pad(row.session, 9),
            pad(row.regime, 9),
            pad(row.adx, 7, "right"),
            pad(row.setup, 14),
            pad(row.trigger, 5),
            pad(row.note, noteWidth),
        ];
        rows.push(cells.join(" | "));
    }

    return rows;
}

function renderDashboard() {
    if (!DASHBOARD_ENABLED) return;
    ensureDashboardInit();

    const width = dashboardWidth();
    const now = new Date().toISOString();
    const accountLine = [
        `BAL ${dashboardState.balance}`,
        `MARGIN ${dashboardState.availMargin}`,
        `OPEN ${dashboardState.openTrades}/${dashboardState.maxTrades}`,
        `BROKER ${dashboardState.brokerOpenNow}`,
        `TRAIL ${dashboardState.trailingOpenPositions}`,
    ].join(" | ");
    const statusLine = [
        `MODE ${dashboardState.mode}`,
        `SESSION ${dashboardState.sessionStatus}`,
        `HUB ${dashboardState.hubStatus}`,
        `INTERVAL ${dashboardState.analysisIntervalMs}ms`,
        `REFRESH ${dashboardState.nextRefreshMinutes}m`,
        `UPDATED ${shortTime(now)}`,
    ].join(" | ");
    const marketLine = [
        `ACTIVE ${dashboardState.activeSessions.join("+") || "-"}`,
        `TRADABLE ${dashboardState.tradableSymbols.join(",") || "-"}`,
        `CURRENT ${dashboardState.currentSymbol}`,
        `BLOCKED ${dashboardState.blockedSummary}`,
    ].join(" | ");

    const recentEvents = dashboardState.recentEvents.length
        ? dashboardState.recentEvents.map(
              (event) => `${pad(event.time, 8)} ${pad(event.level, 5)} ${truncate(event.text, width - 20)}`,
          )
        : ["-"];

    const lines = [
        "\u001b[2J\u001b[H",
        border(width, "="),
        frameLine("TRON GRID // CAPITAL API BOT // LIVE FLOW", width, "brightCyan"),
        frameLine(statusLine, width, "white"),
        frameLine(accountLine, width, "white"),
        frameLine(marketLine, width, "white"),
        border(width, "-"),
        frameLine(`STRATEGY ${dashboardState.strategy}`, width, "white"),
        frameLine("SYMBOL MATRIX", width, "brightCyan"),
        ...buildSymbolTable(width).map((row, index) => frameLine(row, width, index === 0 ? "brightCyan" : "white")),
        border(width, "-"),
        frameLine("RECENT EVENTS", width, "brightCyan"),
        ...recentEvents.map((event) => frameLine(event, width, "white")),
        border(width, "="),
    ];

    process.stdout.write(lines.join("\n"));
}

function emitRaw(level, message, error = null) {
    const timestamp = new Date().toISOString();
    const payload = toConsolePayload(message, error);
    const printer =
        level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
    if (payload.includes("\n")) {
        printer(`[${level.toUpperCase()}] ${timestamp} |\n${payload}\n`);
    } else {
        printer(`[${level.toUpperCase()}] ${timestamp} | ${payload}`);
    }
}

function shouldSuppressRepeat(level, payload) {
    const text = String(payload || "");
    const now = Date.now();
    for (const rule of REPEAT_SUPPRESSION_RULES) {
        if (rule.level !== level) continue;
        const match = text.match(rule.pattern);
        if (!match) continue;
        const key = rule.key(match, text);
        const previousAt = repeatLogState.get(key) || 0;
        if (now - previousAt < rule.intervalMs) return true;
        repeatLogState.set(key, now);
        return false;
    }
    return false;
}

function log(level, message, error = null) {
    if (!shouldLog(level)) return;
    const timestamp = new Date().toISOString();
    const payload = toConsolePayload(message, error);

    if (shouldSuppressRepeat(level, payload)) return;

    if (DASHBOARD_ENABLED) {
        parseMessage(level, payload, timestamp);
        pushRecentEvent(level, payload, timestamp);
        renderDashboard();
        return;
    }

    emitRaw(level, message, error);
}

const logger = {
    info: (message) => log("info", message),
    error: (message, error) => log("error", message, error),
    warn: (message, error) => log("warn", message, error),
    trade: (action, symbol, details) => {
        if (!shouldLog("trade")) return;
        const message = typeof details === "object" ? `${action} ${symbol}: ${JSON.stringify(details)}` : `${action} ${symbol}: ${details}`;
        if (DASHBOARD_ENABLED) {
            pushRecentEvent("trade", `[TRADE] ${message}`, new Date().toISOString());
            renderDashboard();
            return;
        }

        if (typeof details === "object") {
            console.log(`[TRADE] ${new Date().toISOString()} | ${action} ${symbol}:\n${JSON.stringify(details, null, 2)}\n`);
        } else {
            console.log(`[TRADE] ${new Date().toISOString()} | ${action} ${symbol}: ${details}`);
        }
    },
    debug: (message) => log("debug", message),
    isDashboardEnabled: () => DASHBOARD_ENABLED,
};

export default logger;
