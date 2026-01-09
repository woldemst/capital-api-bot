# Trade Log Analysis on 09.01.2026

## Data Audit
- Records: 14
- Corrupted lines: 0
- Duplicate dealIds: 0
- Open trades without close: 2
- indicatorsClose missing: 2
- indicatorsClose identical to open: 0

### Missing Fields
- closeReason: 2
- closePrice: 2
- closedAt: 2
- indicatorsClose: 2

### Invalid Types
- stopLoss: 14
- takeProfit: 14

## Outcomes & PnL
- Wins: 4, Losses: 8, Other: 2
- PnL win mean: 0.020600000000001895, loss mean: -0.007259999999999073
- R win mean: 1.161662103582066, loss mean: -0.6577341398406713

## Top Feature Differences (Open Indicators)
- h4.backQuantScore: win=29.0000 loss=-2.7143 diff=31.7143 (n=4/7)
- m15.backQuantScore: win=22.5000 loss=2.4286 diff=20.0714 (n=4/7)
- h1.backQuantScore: win=22.5000 loss=6.4286 diff=16.0714 (n=4/7)
- m5.backQuantScore: win=18.0000 loss=6.4286 diff=11.5714 (n=4/7)
- d1.rsi: win=60.2650 loss=49.1643 diff=11.1007 (n=4/7)
- h4.rsi: win=62.0500 loss=50.9986 diff=11.0514 (n=4/7)
- d1.backQuantScore: win=0.5000 loss=9.2857 diff=-8.7857 (n=4/7)
- h1.rsi: win=58.4075 loss=50.0687 diff=8.3388 (n=4/8)
- m5.adx: win=20.2401 loss=26.4360 diff=-6.1959 (n=4/7)
- m1.rsi: win=54.8325 loss=49.3029 diff=5.5296 (n=4/7)

## Top Delta Differences (Close - Open)
- delta.m1.backQuantScore: win=-1.5000 loss=6.5714 diff=-8.0714 (n=4/7)
- delta.m5.rsi: win=2.6900 loss=-5.1963 diff=7.8862 (n=4/8)
- delta.m15.rsi: win=1.1800 loss=-4.1900 diff=5.3700 (n=4/8)
- delta.m1.adx: win=-1.8250 loss=3.4611 diff=-5.2861 (n=4/7)
- delta.m15.backQuantScore: win=0.0000 loss=3.7143 diff=-3.7143 (n=4/7)
- delta.m5.adx: win=-0.1126 loss=-1.9031 diff=1.7906 (n=4/7)
- delta.m1.rsi: win=0.6300 loss=-0.7714 diff=1.4014 (n=4/7)
- delta.m15.adx: win=-1.4141 loss=-0.0244 diff=-1.3897 (n=4/7)
- delta.h4.rsi: win=0.5175 loss=-0.4671 diff=0.9846 (n=4/7)
- delta.m15.trend: win=0.0000 loss=-0.5714 diff=0.5714 (n=4/7)

## Candidate Rules to Test
- m5.adx <= 23.3380 | winRate=60.0% (n=5)
- m1.rsi >= 52.0677 | winRate=60.0% (n=5)
- d1.trend >= 0.5714 | winRate=50.0% (n=8)
- d1.rsi >= 54.7146 | winRate=50.0% (n=6)
- d1.price_vs_ema9 >= 0.0017 | winRate=50.0% (n=6)