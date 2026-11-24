# probe-pyramid

A paper-trading bot for the make.fun bounty
**Pump.fun Paper Sprint: Any Bot Can Win**
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`).

The grader runs `node /bot/main.ts`. The strategy lives in `strategy.ts`;
`vendor/agentfun-bot.ts` is the kit's `sdk/ts/agentfun-bot.ts`, vendored
byte for byte. No network, no clock, no randomness — the bot is a pure
function of the batches the harness sends, so two runs produce
byte-identical action logs.

## Why this design

The dev window's own statistics say most pump.fun coins dump: of 1,222
coins, the median coin's best price is only +13% above its early price and
its final price is -17%. Only 35 coins completed their curve, and 117 ever
ran +100%. A plain buy-and-hold or a symmetric take-profit / stop-loss
system loses to the ~2.5% round-trip curve fees (1.25% each way plus
105,000 lamports of transaction fees per order).

So the strategy is a lottery with cheap tickets and a big payoff:

1. **Probe small, early, and often.** A 0.01 SOL probe (the minimum
   round trip) on a young coin (created within the last 20 slots) that
   already has at least 3 trades, at least 3 distinct non-creator buyers,
   positive net inflow, a creator who has not sold, and a creator buy of
   at most 2.5 SOL. Real reserve must be between 0.1 and 30 SOL and the
   price must not already have run up more than 50% from creation.
2. **Cut losers fast.** Hard stop at -8% of cost, exit if the creator
   sells, and a 10,000-slot time exit (unless the curve is near
   completion at >= 60 SOL real reserve, in which case it is ridden).
3. **Pyramid into strength only.** When a position is up +30%, add
   0.05 SOL; up +50%, add 0.4 SOL; up +300%, add 0.6 SOL, up to 1.2 SOL
   committed per coin. Losers never get more money.
4. **Ride winners with a trailing stop.** Once a position is up +50%,
   sell everything if it falls 30% from its peak.
5. **Eligibility guardrail.** If the bot's own traded coins fall behind
   a pace of 25 coins over the first 4 hours, it opens tiny 0.01 SOL
   probe round trips (buy, then sell in the next batch) until it is back
   on pace, so the >= 20 distinct coins requirement is met even in a
   quiet window.

## Local results

Official kit grading, `node cli/makefun.mjs grade-local --driver process`
(real harness `harness@fde9618…`, dev dataset `b661ceee…`):

| Net PnL | Coins | Round trips | Fills | Win rate | Max drawdown | Ranked |
|---|---|---|---|---|---|---|
| **+0.9055 SOL** | 257 | 257 | 533 | 7.0% | 4.69% | yes |

`result_sha256 7f672c973c9b2a3128b6d8651dfe6b1f00a08d12bd022be5c943a0e96e954dca`,
`action_log_sha256 c5a5f50d37828d3c42d2a016d369b5bcd4313f88ac4dfcf9c709e85a9274b7e6`
— identical across two runs (deterministic, L1 reproduced).
`prize_eligible` is false only because no transcript bundle was attached
(`no_transcripts`, `cost_unpriced`); that is a submission artifact, not a
trading result, and is supplied at submit time.

Offline pilot-sim cross-check (full 24h dev dataset, patched to load all
three parts):

| | Net PnL | Coins | Round trips | Wins | Max drawdown |
|---|---|---|---|---|---|
| Full dev data | **+0.9196 SOL** | 255 | 255 | 19 | 4.6% |
| Part 0 (~8h) | -0.0223 SOL | 101 | 101 | 9 | 2.7% |
| Part 1 (~8h) | -0.1585 SOL | 98 | 98 | 6 | 1.9% |
| Part 2 (~8h) | +1.0961 SOL | 60 | 60 | 4 | 1.5% |

The profit is concentrated in one moonshot (best single trip +1.168 SOL);
the other two parts lose only -0.02 and -0.16 SOL. That is the nature of
this market: the edge is catching a rare 3–13x runner with size while
keeping the cost of every failed probe at ~0.002 SOL. The same parameter
set was swept over 100+ combinations; every variant in the probe/pyramid
family was positive on the full dev set (+0.30 to +0.92 SOL), so the
result is not a single lucky parameter cell.

For comparison, the kit's own baselines on the same offline sim lose
money: momentum -9.38 SOL (part 0), reversion -1.78 SOL (part 0),
sniper -0.49 SOL (full data).

## Files

- `main.ts` — entry point; runs the strategy through the SDK shim.
- `strategy.ts` — the whole strategy, parameters in `DEFAULT_PARAMS`.
- `vendor/agentfun-bot.ts` — the kit's SDK shim, unchanged.
- `tools/sim.ts` — the kit pilot's offline simulator, patched to load all
  three dataset parts (the pilot originals only load part-00000).
- `LICENSE` — MIT.
