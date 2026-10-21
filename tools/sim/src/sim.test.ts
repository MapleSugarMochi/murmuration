import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { actionArbitrary, actionsForSeed, runSimulation, type Action } from './sim.ts';

const RUNS = Number(process.env.SIM_RUNS ?? 300);

describe('convergence simulator', () => {
  it('converges for a fixed scripted scenario', () => {
    const script: Action[] = [
      { kind: 'edit', client: 0, a: 0, b: 0, c: 0 },
      { kind: 'flushClient', client: 0, a: 0, b: 0, c: 0 },
      { kind: 'toServer', client: 0, a: 0, b: 0, c: 0 },
      { kind: 'edit', client: 1, a: 5, b: 1, c: 2 },
      { kind: 'disconnect', client: 1, a: 0, b: 0, c: 0 },
      { kind: 'crashServer', client: 0, a: 0, b: 0, c: 0 },
    ];
    const stats = runSimulation(script, { clients: 2, checkEveryStep: true });
    expect(stats.crashes).toBe(1);
  });

  it(`converges for ${RUNS} random interleavings`, () => {
    fc.assert(
      fc.property(
        fc.array(actionArbitrary, { minLength: 50, maxLength: 400 }),
        fc.integer({ min: 2, max: 6 }),
        (actions, clients) => {
          runSimulation(actions, { clients, viewers: [clients - 1], checkEveryStep: true });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('is deterministic for a seed', () => {
    const a = runSimulation(actionsForSeed(42, 300), { clients: 4 });
    const b = runSimulation(actionsForSeed(42, 300), { clients: 4 });
    expect(a).toEqual(b);
  });
});
