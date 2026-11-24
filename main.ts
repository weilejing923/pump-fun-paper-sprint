// probe-pyramid: a paper-trading bot for the make.fun pump.fun replay
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy
// lives in strategy.ts and the SDK shim is the kit's sdk/ts/agentfun-bot.ts,
// vendored byte for byte.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
