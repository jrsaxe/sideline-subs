const assert = require('assert');
const E = require('../engine.js');

const MIN = 60000;
function seeded(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); }
function roster(n = 13) { return Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, present: true })); }
function spread(g, r, t) {
  const ms = E.available(g, r).map((id) => E.playedMs(g, id, t));
  return { min: Math.min(...ms) / MIN, max: Math.max(...ms) / MIN };
}
function checkIntegrity(g, r) {
  const on = E.onFieldIds(g);
  assert.strictEqual(new Set(on).size, on.length, 'duplicate player on field');
  const open = g.stints.filter((s) => s.end == null);
  assert.strictEqual(open.length, on.length, 'open stints != on field');
  for (const s of open) assert.strictEqual(g.slots[s.slot], s.pid, 'stint/slot mismatch');
}
let pass = 0;
function test(name, fn) { fn(); pass++; console.log('ok -', name); }

// play a game: every `every` minutes suggest + apply all
function simulate({ n = 13, f = '7', every = 6, halfMin = 25, gkLock = false, partial = false, seed = 1 }) {
  const r = roster(n); const g = E.newGame(f); g.gkLock = gkLock;
  E.populate(g, r, 0, { rand: seeded(seed) }); g.phase = 'live';
  let t = 0;
  for (let half = 1; half <= 2; half++) {
    const end = half * halfMin * MIN;
    while (t + every * MIN <= end) {
      t += every * MIN;
      E.suggest(g, r, t);
      if (partial) {
        // subs trickle in one at a time 20s apart
        const slots = g.queue.map((q) => q.slot);
        slots.forEach((s, i) => E.applyRow(g, r, s, t + i * 20000));
        t += slots.length * 20000;
      } else E.applyAll(g, r, t);
      checkIntegrity(g, r);
    }
    t = end;
    if (half === 1) { g.phase = 'half'; E.populate(g, r, t, { rand: seeded(seed + 9), keepGK: gkLock }); g.phase = 'live'; checkIntegrity(g, r); }
  }
  return { g, r, t };
}

test('13 players 7v7 stays fair', () => {
  for (let seed = 1; seed < 20; seed++) {
    const { g, r, t } = simulate({ seed });
    const s = spread(g, r, t);
    assert.ok(s.max - s.min <= 6.1, `spread ${s.min}-${s.max} seed ${seed}`);
  }
});
test('partial Sub Made at different times keeps accurate minutes', () => {
  const { g, r, t } = simulate({ partial: true });
  const total = E.available(g, r).reduce((a, id) => a + E.playedMs(g, id, t), 0);
  assert.strictEqual(total, t * 7, 'total minutes must equal slots x time');
  const s = spread(g, r, t); assert.ok(s.max - s.min <= 7, JSON.stringify(s));
});
test('8v8 fair', () => {
  const { g, r, t } = simulate({ f: '8' });
  const s = spread(g, r, t); assert.ok(s.max - s.min <= 6.1, JSON.stringify(s));
});
test('GK lock: GK never subbed by suggestions, others balanced', () => {
  const r = roster(); const g = E.newGame('7'); g.gkLock = true;
  E.populate(g, r, 0, { rand: seeded(3) }); g.phase = 'live';
  const gk = g.slots.GK; let t = 0;
  for (let i = 0; i < 8; i++) { t += 6 * MIN; E.suggest(g, r, t); assert.ok(!g.queue.some((q) => q.slot === 'GK')); E.applyAll(g, r, t); }
  assert.strictEqual(g.slots.GK, gk);
  const others = E.available(g, r).filter((p) => p !== gk).map((p) => E.playedMs(g, p, t) / MIN);
  assert.ok(Math.max(...others) - Math.min(...others) <= 6.1, others.join(','));
});
test('suggest queues every bench player', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(4) }); g.phase = 'live';
  const res = E.suggest(g, r, 6 * MIN);
  assert.strictEqual(res.queued, 6); assert.strictEqual(g.queue.length, 6);
  // the 6 coming off are distinct field players, none of them the incoming
  assert.strictEqual(new Set(g.queue.map((q) => q.slot)).size, 6);
});
test('manual rows survive re-suggest', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(5) }); g.phase = 'live';
  const b = E.benchIds(g, r)[0];
  E.queueManual(g, r, b, 'GK');
  E.suggest(g, r, 6 * MIN);
  assert.ok(g.queue.some((q) => q.manual && q.inPid === b && q.slot === 'GK'));
  assert.strictEqual(g.queue.length, 6);
});
test('remove player mid-half -> slot gets queued fill, then filled', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(6) }); g.phase = 'live';
  const victim = g.slots.CM; E.removePlayer(g, r, victim, 10 * MIN); g.out.push(victim);
  E.normalizeQueue(g, r);
  assert.strictEqual(g.slots.CM, null);
  assert.ok(g.queue.some((q) => q.slot === 'CM'));
  E.applyAll(g, r, 11 * MIN); assert.ok(g.slots.CM != null); checkIntegrity(g, r);
  assert.ok(!E.available(g, r).includes(victim));
});
test('absent before game: lineup reflows directly', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(7) });
  const victim = g.slots.LB; r.find((p) => p.id === victim).present = false;
  E.removePlayer(g, r, victim, 0);
  assert.ok(g.slots.LB != null && g.slots.LB !== victim); checkIntegrity(g, r);
});
test('formation switch 7 -> 8 -> 7', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(8) }); g.phase = 'live';
  const st = g.slots.ST;
  E.setFormation(g, r, '8', 5 * MIN);
  assert.strictEqual(g.slots.LS, st); assert.strictEqual(g.slots.RS, null);
  assert.ok(g.queue.some((q) => q.slot === 'RS'));
  E.applyAll(g, r, 5 * MIN); checkIntegrity(g, r); assert.strictEqual(E.onFieldIds(g).length, 8);
  E.setFormation(g, r, '7', 10 * MIN); checkIntegrity(g, r); assert.strictEqual(E.onFieldIds(g).length, 7);
});
test('request with too few eligible: 7 present on field + 2 bench, GK locked, all just came on', () => {
  const r = roster(9); const g = E.newGame('7'); g.gkLock = true; E.populate(g, r, 0, { rand: seeded(9) }); g.phase = 'live';
  const res = E.suggest(g, r, 1 * MIN);
  assert.strictEqual(res.queued, 2);
  assert.ok(!g.queue.some((q) => q.slot === 'GK'));
});
test('small roster (only 7) -> nothing to suggest', () => {
  const r = roster(7); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(1) }); g.phase = 'live';
  assert.strictEqual(E.suggest(g, r, 6 * MIN).queued, 0);
});
test('swap positions keeps time continuous', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(2) }); g.phase = 'live';
  const a = g.slots.LB; E.swapSlots(g, 'LB', 'ST', 4 * MIN);
  assert.strictEqual(g.slots.ST, a); assert.strictEqual(E.playedMs(g, a, 10 * MIN), 10 * MIN);
  assert.strictEqual(E.currentStintMs(g, a, 10 * MIN), 10 * MIN); assert.strictEqual(E.stintCount(g, a), 1);
});
test('positions rotate across lines', () => {
  const { g, r, t } = simulate({ seed: 11 });
  const multi = E.available(g, r).filter((p) => Object.values(E.lineMs(g, p, t)).filter((v) => v > 0).length >= 2);
  assert.ok(multi.length >= 9, 'only ' + multi.length + ' players played 2+ lines');
});
test('queued position swap waits until Swap Made', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(12) }); g.phase = 'live';
  const lb = g.slots.LB, st = g.slots.ST;
  E.queueSwap(g, r, 'LB', 'ST');
  assert.strictEqual(g.slots.LB, lb, 'not swapped yet');
  assert.strictEqual(g.queue.length, 1);
  E.applyRow(g, r, 'LB', 4 * MIN);
  assert.strictEqual(g.slots.ST, lb); assert.strictEqual(g.slots.LB, st);
  assert.strictEqual(g.queue.length, 0); assert.strictEqual(g.lastSubAt, 0, 'swap is not a sub');
  checkIntegrity(g, r);
});
test('swap survives Suggest subs and blocks those spots; All Subs Made applies both', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(13) }); g.phase = 'live';
  const lb = g.slots.LB, rb = g.slots.RB;
  E.queueSwap(g, r, 'LB', 'RB');
  E.suggest(g, r, 6 * MIN);
  const subs = g.queue.filter((q) => !q.swap);
  assert.ok(g.queue.some((q) => q.swap));
  assert.ok(!subs.some((q) => q.slot === 'LB' || q.slot === 'RB'), 'subs must avoid swapped spots');
  assert.strictEqual(subs.length, 5, '5 field spots left for 6 bench players');
  E.applyAll(g, r, 6 * MIN);
  assert.strictEqual(g.slots.LB, rb); assert.strictEqual(g.slots.RB, lb);
  checkIntegrity(g, r);
});
test('swap row replaces conflicting sub row; sub row dropped if its player leaves', () => {
  const r = roster(); const g = E.newGame('7'); E.populate(g, r, 0, { rand: seeded(14) }); g.phase = 'live';
  E.queueManual(g, r, E.benchIds(g, r)[0], 'CM');
  E.queueSwap(g, r, 'CM', 'ST');
  assert.strictEqual(g.queue.length, 1); assert.ok(g.queue[0].swap);
  const st = g.slots.ST; E.removePlayer(g, r, st, MIN); g.out.push(st); E.normalizeQueue(g, r);
  assert.ok(!g.queue.some((q) => q.swap), 'swap with empty spot is dropped');
});
console.log(`\n${pass} passed`);
