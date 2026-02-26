# Intraday 7-Step Strategy Process

This repository now contains an additive intraday strategy architecture in `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday`.

## Design Rules

- Intraday only (`M1`, `M5`, `M15`, `H1`)
- Guardrails before order planning (anti-overtrading, anti-hope-trading)
- Backtestable and log-first by design
- Each strategy step has a dedicated module with explicit input/output objects and log fields

## Module Map

- Step 1: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step1MarketTimeWindow.js`
- Step 2: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step2ContextRegime.js`
- Step 3: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step3Setup.js`
- Step 4: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step4Trigger.js`
- Step 5: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step5EntryRisk.js`
- Step 6: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step6TradeManagement.js`
- Step 7: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/step7ReviewBacktest.js`
- Guardrails: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/guardrails.js`
- Runtime state: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/state.js`
- Orchestrator: `/Users/waldemarweinert/DEV/trading/capital-api-bot/intraday/engine.js`

## Execution Flow (strict order)

1. Step 1 defines session, allowed symbols, and intraday cutoff state.
2. Step 2 classifies `H1` market context/regime.
3. Step 3 finds a `M15` setup aligned to regime.
4. Step 4 confirms a `M5` trigger.
5. Guardrails must pass before Step 5.
6. Step 5 builds an order plan with mandatory initial `SL` and `TP`.
7. Step 6 manages open trades intraday (breakeven/trailing/cutoff).
8. Step 7 records minute snapshots and trade logs and supports backtest replay/metrics.

## Integration Notes

- Existing legacy strategy code remains untouched.
- The new engine can be wired into live or replay flows incrementally.
- Price snapshots should include bars/indicators/sessions/news/sentiment so replay and live share the same decision path.

