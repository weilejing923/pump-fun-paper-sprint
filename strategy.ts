// Probe-and-pyramid paper trader for the pump.fun bonding-curve replay.
//
// Idea (from the dev window's own statistics, not from a baseline):
//   * Most coins dump: median coin is +13% at its best and -17% by the end, so a
//     plain buy-and-hold or a symmetric TP/SL system loses to the ~2.5% round-trip
//     curve fees. The money is in the tail: 35 of 1222 dev coins completed
//     (max +300% to +1300% from early prices) and 117 ever ran +100%.
//   * So: buy a *tiny* probe on many young coins, lose at most ~15% of the probe
//     on the 85% that dump, and only add size to the ones that actually run.
//     Adds are pyramided into strength only, and winners are ridden with a
//     trailing stop (plus a completion ride: a curve near 85 SOL real reserve
//     is about to complete, so the time exit does not apply to it).
//   * Entry is early (first tens of slots after creation) and filtered: the
//     creator must not have sold, at least a few distinct non-creator buyers
//     must be in, net flow must be positive, and the creator's own buy must
//     not be outsized. No filter predicts a runner well on its own (best
//     single filter, >=5 early buyers, only lifts P(+100%) from 13% to 19%),
//     so the probe is kept small and the pyramid does the selecting.
//
// Deterministic by construction: a pure function of the batches the harness
// sends. No clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream, so two executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a probe may still be decided. */
  maxAge: number;
  /** Distinct non-creator buyers seen before a probe. */
  minBuyers: number;
  /** Trades seen before a probe. */
  minTrades: number;
  /** Net SOL (buys minus sells) seen before a probe. */
  minNetSol: number;
  /** Creator's own buy in the create slot, at most (SOL). */
  maxDevBuySol: number;
  /** Real SOL reserve window at probe time. */
  minRqSol: number;
  maxRqSol: number;
  /** Price now over the create price, at most (a coin that already pumped is skipped). */
  maxRunup: number;
  /** Probe size (SOL). */
  probeSol: number;
  /** Add size (SOL) when the position is up addUp1. */
  add1Sol: number;
  /** Add size (SOL) when the position is up addUp2. */
  add2Sol: number;
  /** Add size (SOL) when the position is up addUp3. */
  add3Sol: number;
  /** Add thresholds (value over cost). */
  addUp1: number;
  addUp2: number;
  addUp3: number;
  /** Most SOL committed to one position in total. */
  maxStakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hard stop: sell all when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Then sell all when value falls trail below its peak. */
  trail: number;
  /** Exit after this many slots held (unless riding to completion). */
  maxHold: number;
  /** Real SOL at/above which the time exit does not apply (completion is near). */
  rideRqSol: number;
  /** Exit at once when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be probed again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most probe positions open at once (the rest of caps.max_open_positions is headroom). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run must end with >=20 coins traded. When the bot's
   * own coins lag targetCoins scaled by the share of paceSecs elapsed (block
   * time since the first batch), it opens tiny probe round trips until back
   * on pace. */
  targetCoins: number;
  paceSecs: number;
  paceProbeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 20,
  minBuyers: 3,
  minTrades: 3,
  minNetSol: 0,
  maxDevBuySol: 2.5,
  minRqSol: 0.1,
  maxRqSol: 30,
  maxRunup: 0.5,
  probeSol: 0.01,
  add1Sol: 0.05,
  add2Sol: 0.4,
  add3Sol: 0.6,
  addUp1: 0.3,
  addUp2: 0.5,
  addUp3: 3,
  maxStakeSol: 1.2,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.08,
  trailArm: 0.5,
  trail: 0.3,
  maxHold: 10000,
  rideRqSol: 60,
  exitOnDevSell: true,
  bigSellSol: 1000,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 3.0,
  targetCoins: 25,
  paceSecs: 14400,
  paceProbeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  adds: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = 60;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, devBuy: 0, devSold: false, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy && e.slot === t.created) t.devBuy += sol;
            else if (!e.is_buy) t.devSold = true;
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRqSol;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want = 0;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (t.created === null || now - t.created > p.maxAge) continue;
          if (t.devSold || t.devBuy > p.maxDevBuySol) continue;
          if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
          if (t.createPrice > 0 && price / t.createPrice - 1 > p.maxRunup) continue;
          // Early tape: distinct non-creator buyers, net inflow.
          const buyers = new Set<string>();
          let net = 0;
          let n = 0;
          for (const tr of t.trades) {
            n++;
            if (tr.buy) {
              net += tr.sol;
              if (tr.user !== t.creator) buyers.add(tr.user);
            } else net -= tr.sol;
          }
          if (n < p.minTrades || buyers.size < p.minBuyers || net < p.minNetSol) continue;
          want = p.probeSol;
        } else {
          // Pyramid into strength only: position up, and not yet at max stake.
          if (h.exiting || !h.filled || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          const cost = Number(pos.cost_lamports) / LAMPORTS;
          const up = h.lastValue / cost - 1;
          let add = 0;
          if (h.adds === 0 && up >= p.addUp1) add = p.add1Sol;
          else if (h.adds === 1 && up >= p.addUp2) add = p.add2Sol;
          else if (h.adds === 2 && up >= p.addUp3) add = p.add3Sol;
          if (add <= 0) continue;
          if (rqSol > p.maxRqSol * 3) continue;
          want = Math.min(add, p.maxStakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, adds: 0, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe when the bot's coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.paceProbeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.paceProbeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.paceProbeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.paceProbeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
