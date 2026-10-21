import { parseArgs } from 'node:util';
import { actionsForSeed, runSimulation } from './sim.ts';

/**
 * Usage: pnpm sim [--seeds 10000] [--from 1] [--steps 400] [--clients 2..8]
 * Runs one simulation per seed and prints the first failing seed.
 */
const { values } = parseArgs({
  options: {
    seeds: { type: 'string', default: '1000' },
    from: { type: 'string', default: '1' },
    steps: { type: 'string', default: '400' },
    check: { type: 'boolean', default: false },
  },
});

const seeds = Number(values.seeds);
const from = Number(values.from);
const steps = Number(values.steps);
const started = performance.now();
let ops = 0;

for (let seed = from; seed < from + seeds; seed++) {
  const clients = 2 + (seed % 7);
  try {
    const stats = runSimulation(actionsForSeed(seed, steps), {
      clients,
      viewers: seed % 3 === 0 ? [clients - 1] : [],
      checkEveryStep: values.check,
    });
    ops += stats.seq;
  } catch (err) {
    console.error(`seed ${seed} (${clients} clients, ${steps} steps) failed:`);
    console.error(err);
    process.exit(1);
  }
  if ((seed - from + 1) % 1000 === 0) console.log(`${seed - from + 1} seeds ok`);
}

const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log(`all ${seeds} seeds converged (${ops} batches committed) in ${secs}s`);
