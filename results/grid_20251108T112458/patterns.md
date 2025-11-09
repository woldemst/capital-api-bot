# Experiment Run grid_20251108T112458

**Exec Summary**
- Trades: 222 | Win% 49.1% | PF 1.82 | Expectancy 0.26R | Max DD 12.95R
- Soft exits triggered 105, saved 81 (77.14% avoided SL)

**Cross-TF Patterns**
- H1 trend aligned win rate: 49.1% vs counter 0%
- M15 trend aligned win rate: 49.1% vs counter 0%
- H1 RSI bands → Low: 59.22% | Mid: 36.84% | High: 41.98%
- ATR sweet spot (5-12 pips) win rate: 50.48% | low 0% | high 47.86%
- Session win rates: asia 60.29% | london 41.44% | new_york 51.16%

**Experiment Grid Snapshot**
- trend_off__atr_off__rsi_off__soft_off__rr_1.2: trades=284, exp=-0.00R, PF=0.99, improved 38%
- trend_off__atr_off__rsi_off__soft_off__rr_1.5: trades=284, exp=0.02R, PF=1.04, improved 50%
- trend_off__atr_off__rsi_off__soft_off__rr_2: trades=284, exp=-0.01R, PF=0.98, improved 50%
- trend_off__atr_off__rsi_off__soft_conservative__rr_1.2: trades=284, exp=-0.00R, PF=0.99, improved 38%
- trend_off__atr_off__rsi_off__soft_conservative__rr_1.5: trades=284, exp=0.02R, PF=1.04, improved 50%
- trend_off__atr_off__rsi_off__soft_conservative__rr_2: trades=284, exp=-0.01R, PF=0.98, improved 50%
- trend_off__atr_off__rsi_off__soft_standard__rr_1.2: trades=284, exp=-0.00R, PF=0.99, improved 38%
- trend_off__atr_off__rsi_off__soft_standard__rr_1.5: trades=284, exp=0.02R, PF=1.04, improved 50%
- trend_off__atr_off__rsi_off__soft_standard__rr_2: trades=284, exp=-0.01R, PF=0.98, improved 50%
- trend_off__atr_off__rsi_off__soft_aggressive__rr_1.2: trades=284, exp=0.15R, PF=1.50, improved 63%

**Next Steps**
- Replay best config with live spreads to confirm slippage impact
- Forward-test ATR band and RSI gate toggles during NY open
- A/B soft-exit aggressiveness on news-filtered days