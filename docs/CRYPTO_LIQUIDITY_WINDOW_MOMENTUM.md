# CRYPTO_LIQUIDITY_WINDOW_MOMENTUM

## Enable in Live Bot

Set the crypto strategy selector to the new strategy (forex is unchanged):

```bash
export CRYPTO_PRIMARY_STRATEGY=CRYPTO_LIQUIDITY_WINDOW_MOMENTUM
```

Optional toggles:

```bash
export ENABLE_CRYPTO_LIQUIDITY_WINDOW_MOMENTUM=true
export CLWM_RISK_PROFILE=normal   # or aggressive
export CLWM_WINDOW_START=14:00
export CLWM_WINDOW_END=20:00
export CLWM_DISABLE_H1_FILTER=false
```

## Tunable Config Block

Primary tuning lives in `/Users/waldemarweinert/DEV/trading/capital-api-bot/config.js` under:

- `STRATEGIES.CRYPTO_LIQUIDITY_WINDOW_MOMENTUM`
- `perSymbolOverrides` (spread/jump/stop ATR/min stop)

## Backtest

Run replay backtest on `backtest/prices/*.jsonl` for:

- `BTCUSD`
- `SOLUSD`
- `XRPUSD`
- `DOGEUSD`
- `ETHUSD`

```bash
npm run backtest:crypto-lwm
```

Outputs:

- report JSON: `backtest/reports/crypto-lwm/`
- decision minute log (JSONL): `.../CRYPTO_LIQUIDITY_WINDOW_MOMENTUM-minute.jsonl`
- closed trades log (JSONL): `.../CRYPTO_LIQUIDITY_WINDOW_MOMENTUM-trades.jsonl`

