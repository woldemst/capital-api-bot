import test from "node:test";
import assert from "node:assert/strict";
import { deriveApiEnvironment, validateStartupConfig } from "../../utils/startupValidation.js";

function buildBaseConfig(overrides = {}) {
    return {
        api: {
            KEY: "demo-key",
            IDENTIFIER: "demo-user",
            PASSWORD: "demo-pass",
            BASE_URL: "https://demo-api-capital.backend-capital.com/api/v1",
        },
        liveSymbols: ["EURUSD", "GBPUSD"],
        sessions: {
            LONDON: { SYMBOLS: ["EURUSD", "GBPUSD"] },
            NY: { SYMBOLS: ["EURUSD", "USDCAD"] },
        },
        tradingWindows: {
            FOREX: [{ start: 1320, end: 779 }],
        },
        newsGuard: {
            ENABLED: true,
            FOREX_ONLY: true,
        },
        env: {},
        ...overrides,
    };
}

test("deriveApiEnvironment erkennt demo und live", () => {
    assert.equal(deriveApiEnvironment("https://demo-api-capital.backend-capital.com/api/v1"), "DEMO");
    assert.equal(deriveApiEnvironment("https://api-capital.backend-capital.com/api/v1"), "LIVE");
    assert.equal(deriveApiEnvironment(""), "UNKNOWN");
});

test("validateStartupConfig akzeptiert ein valides Broker-Setup", () => {
    const result = validateStartupConfig(buildBaseConfig());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.environment, "DEMO");
    assert.deepEqual(result.liveSymbols, ["EURUSD", "GBPUSD"]);
});

test("validateStartupConfig akzeptiert auch eine Live-API-Konfiguration", () => {
    const result = validateStartupConfig(
        buildBaseConfig({
            api: {
                KEY: "live-key",
                IDENTIFIER: "live-user",
                PASSWORD: "live-pass",
                BASE_URL: "https://api-capital.backend-capital.com/api/v1",
            },
        }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.environment, "LIVE");
});

test("validateStartupConfig blockiert LIVE_SYMBOLS ausserhalb der Session-Konfiguration", () => {
    const result = validateStartupConfig(
        buildBaseConfig({
            liveSymbols: ["EURUSD", "USDJPY"],
        }),
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /USDJPY/);
});
