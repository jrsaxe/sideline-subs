/* Sub engine — pure logic, no DOM. Works in the browser (window.Engine) and Node (require). */
(function (root) {
  'use strict';

  const FORMATIONS = {
    '7': {
      label: '7v7 · GK-2-3-1',
      slots: [
        { id: 'GK', line: 'GK', x: 50, y: 88 },
        { id: 'LB', line: 'D', x: 28, y: 69 },
        { id: 'RB', line: 'D', x: 72, y: 69 },
        { id: 'LM', line: 'M', x: 16, y: 45 },
        { id: 'CM', line: 'M', x: 50, y: 48 },
        { id: 'RM', line: 'M', x: 84, y: 45 },
        { id: 'ST', line: 'F', x: 50, y: 20 },
      ],
    },
    '8': {
      label: '8v8 · GK-2-3-2',
      slots: [
        { id: 'GK', line: 'GK', x: 50, y: 88 },
        { id: 'LB', line: 'D', x: 28, y: 69 },
        { id: 'RB', line: 'D', x: 72, y: 69 },
        { id: 'LM', line: 'M', x: 16, y: 45 },
        { id: 'CM', line: 'M', x: 50, y: 48 },
        { id: 'RM', line: 'M', x: 84, y: 45 },
        { id: 'LS', line: 'F', x: 32, y: 20 },
        { id: 'RS', line: 'F', x: 68, y: 20 },
      ],
    },
  };
  const LINES = ['GK', 'D', 'M', 'F'];

  const slotDefs = (f) => FORMATIONS[f].slots;
  const slotDef = (f, id) => slotDefs(f).find((s) => s.id === id);

  // ---------- game construction ----------
  function newGame(formation) {
    const slots = {};
    slotDefs(formation).forEach((s) => (slots[s.id] = null));
    return {
      formation,
      phase: 'pre', // pre | live | half | final
      half: 1,
      clock: { acc: 0, since: null }, // game ms, real-time anchor
      halfStarts: [0],
      slots,
      stints: [], // {pid, slot, line, start, end}
      queue: [], // {inPid, slot, manual}
      out: [], // pids out for the game (injured / left)
      gkLock: false,
      lastSubAt: 0,
      date: new Date().toISOString(),
    };
  }

  function gameMs(game, nowReal) {
    return game.clock.acc + (game.clock.since != null ? Math.max(0, nowReal - game.clock.since) : 0);
  }

  // ---------- queries ----------
  function onFieldIds(game) {
    return Object.values(game.slots).filter((p) => p != null);
  }
  function slotOf(game, pid) {
    for (const k in game.slots) if (game.slots[k] === pid) return k;
    return null;
  }
  function available(game, roster) {
    return roster.filter((p) => p.present && !game.out.includes(p.id)).map((p) => p.id);
  }
  function benchIds(game, roster) {
    const on = new Set(onFieldIds(game));
    return available(game, roster).filter((id) => !on.has(id));
  }
  function playedMs(game, pid, t) {
    let ms = 0;
    for (const s of game.stints) if (s.pid === pid) ms += Math.max(0, (s.end != null ? s.end : t) - s.start);
    return ms;
  }
  function lineMs(game, pid, t) {
    const r = { GK: 0, D: 0, M: 0, F: 0 };
    for (const s of game.stints) if (s.pid === pid) r[s.line] += (s.end != null ? s.end : t) - s.start;
    return r;
  }
  function stintCount(game, pid) {
    const seen = new Set();
    // consecutive stints from a position swap count as one stint on the field
    let n = 0;
    const mine = game.stints.filter((s) => s.pid === pid && s.end !== s.start).sort((a, b) => a.start - b.start);
    let lastEnd = null;
    for (const s of mine) {
      if (lastEnd === null || s.start !== lastEnd) n++;
      lastEnd = s.end;
    }
    void seen;
    return n;
  }
  // how long the current on-field stretch has lasted (position swaps don't reset it)
  function currentStintMs(game, pid, t) {
    const mine = game.stints.filter((s) => s.pid === pid).sort((a, b) => a.start - b.start);
    const open = mine.find((s) => s.end == null);
    if (!open) return 0;
    let start = open.start;
    for (let i = mine.length - 1; i >= 0; i--) {
      const s = mine[i];
      if (s.end != null && s.end === start) start = s.start;
    }
    return t - start;
  }
  // how long a bench player has been sitting (since game start if never played)
  function benchMs(game, pid, t) {
    let lastEnd = 0;
    for (const s of game.stints) if (s.pid === pid && s.end != null && s.end > lastEnd) lastEnd = s.end;
    return t - lastEnd;
  }
  function fairShareMs(game, roster, t) {
    const n = available(game, roster).length;
    if (!n) return 0;
    return (t * Math.min(n, slotDefs(game.formation).length)) / n;
  }

  // ---------- mutations (all take game time t) ----------
  function endStint(game, pid, t) {
    for (const s of game.stints) if (s.pid === pid && s.end == null) s.end = t;
  }
  function startStint(game, pid, slot, t) {
    game.stints.push({ pid, slot, line: slotDef(game.formation, slot).line, start: t, end: null });
  }
  function prune(game) {
    game.stints = game.stints.filter((s) => s.end == null || s.end > s.start);
  }
  // put bench player pid into slot; current occupant goes to bench
  function placeAt(game, slot, pid, t) {
    const occ = game.slots[slot];
    if (occ != null) endStint(game, occ, t);
    const from = slotOf(game, pid);
    if (from) {
      endStint(game, pid, t);
      game.slots[from] = null;
    }
    game.slots[slot] = pid;
    if (pid != null) startStint(game, pid, slot, t);
    prune(game);
  }
  function benchSlot(game, slot, t) {
    const occ = game.slots[slot];
    if (occ != null) endStint(game, occ, t);
    game.slots[slot] = null;
    prune(game);
  }
  function swapSlots(game, a, b, t) {
    const pa = game.slots[a];
    const pb = game.slots[b];
    if (pa != null) endStint(game, pa, t);
    if (pb != null) endStint(game, pb, t);
    game.slots[a] = pb;
    game.slots[b] = pa;
    if (pb != null) startStint(game, pb, a, t);
    if (pa != null) startStint(game, pa, b, t);
    // queued subs follow the slot, not the player — that's what the coach sees on the pitch
    prune(game);
  }

  // drop queue rows that no longer make sense
  function normalizeQueue(game, roster) {
    const bench = new Set(benchIds(game, roster));
    const seenSlot = new Set();
    const seenIn = new Set();
    game.queue = game.queue.filter((r) => {
      if (!(r.slot in game.slots)) return false;
      if (!bench.has(r.inPid)) return false;
      if (seenSlot.has(r.slot) || seenIn.has(r.inPid)) return false;
      seenSlot.add(r.slot);
      seenIn.add(r.inPid);
      return true;
    });
  }

  function queueManual(game, roster, inPid, slot) {
    game.queue = game.queue.filter((r) => r.slot !== slot && r.inPid !== inPid);
    game.queue.push({ inPid, slot, manual: true });
    normalizeQueue(game, roster);
  }
  function unqueue(game, slot) {
    game.queue = game.queue.filter((r) => r.slot !== slot);
  }
  function applyRow(game, roster, slot, t) {
    normalizeQueue(game, roster);
    const row = game.queue.find((r) => r.slot === slot);
    if (!row) return false;
    placeAt(game, row.slot, row.inPid, t);
    game.queue = game.queue.filter((r) => r !== row);
    game.lastSubAt = t;
    normalizeQueue(game, roster);
    return true;
  }
  function applyAll(game, roster, t) {
    normalizeQueue(game, roster);
    const rows = game.queue.slice();
    // everyone queued in comes on; everyone they replace comes off — same instant
    for (const r of rows) placeAt(game, r.slot, r.inPid, t);
    game.queue = [];
    if (rows.length) game.lastSubAt = t;
    return rows.length;
  }

  // ---------- history helpers ----------
  function historyLineMs(history, pid, n) {
    const r = { GK: 0, D: 0, M: 0, F: 0 };
    (history || []).slice(-(n || 6)).forEach((g) => {
      const l = g.lineMs && g.lineMs[pid];
      if (l) LINES.forEach((k) => (r[k] += l[k] || 0));
    });
    return r;
  }
  function startedLast(history, pid) {
    const g = (history || [])[(history || []).length - 1];
    return !!(g && g.starters && g.starters.includes(pid));
  }

  // ---------- assignment: players -> slots minimizing repeat-line cost ----------
  // cost(i, s): small number = good fit. Exact via bitmask DP (n <= 8).
  function assign(players, slots, costFn) {
    const n = players.length;
    const m = slots.length;
    if (!n) return [];
    // dp over players in order, mask of used slots
    const memo = new Map();
    function best(i, mask) {
      if (i === n) return { c: 0, pick: [] };
      const key = i * 1024 + mask;
      if (memo.has(key)) return memo.get(key);
      let res = { c: Infinity, pick: [] };
      for (let s = 0; s < m; s++) {
        if (mask & (1 << s)) continue;
        const sub = best(i + 1, mask | (1 << s));
        const c = costFn(players[i], slots[s]) + sub.c;
        if (c < res.c) res = { c, pick: [s].concat(sub.pick) };
      }
      memo.set(key, res);
      return res;
    }
    const r = best(0, 0);
    return r.pick.map((s, i) => ({ pid: players[i], slot: slots[s] }));
  }

  function rotationCost(game, history, t, rand) {
    return (pid, slotId) => {
      const line = slotDef(game.formation, slotId).line;
      const now = lineMs(game, pid, t)[line] / 60000; // minutes on this line this game
      const past = historyLineMs(history, pid)[line] / 60000; // recent games
      return now * 1.0 + past * 0.15 + (rand ? rand() * 0.5 : 0);
    };
  }

  function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- populate (lineup mode: pre-game / halftime) ----------
  function populate(game, roster, t, opts) {
    opts = opts || {};
    const rand = opts.rand || Math.random;
    const history = opts.history || [];
    const keepGK = opts.keepGK && game.slots.GK != null ? game.slots.GK : null;
    const ids = shuffled(available(game, roster), rand);
    const slotIds = slotDefs(game.formation).map((s) => s.id);
    let order;
    if (t === 0) {
      // first lineup: girls who sat at the start last game start this time; then least recent minutes
      const hist = (pid) => {
        const l = historyLineMs(history, pid, 3);
        return l.GK + l.D + l.M + l.F;
      };
      order = ids.sort((a, b) => startedLast(history, a) - startedLast(history, b) || hist(a) - hist(b));
    } else {
      order = ids.sort((a, b) => playedMs(game, a, t) - playedMs(game, b, t));
    }
    let freeSlots = slotIds;
    let starters = order;
    if (keepGK != null) {
      starters = order.filter((p) => p !== keepGK);
      freeSlots = slotIds.filter((s) => s !== 'GK');
    }
    starters = starters.slice(0, freeSlots.length);
    // clear field
    for (const s of slotIds) if (!(keepGK != null && s === 'GK')) benchSlot(game, s, t);
    game.queue = [];
    const picks = assign(starters, freeSlots, rotationCost(game, history, t, rand));
    for (const p of picks) placeAt(game, p.slot, p.pid, t);
    return picks;
  }

  // fill empty slots from the bench (direct) — used in lineup mode
  function fillEmptyDirect(game, roster, t) {
    const empty = Object.keys(game.slots).filter((s) => game.slots[s] == null);
    const bench = benchIds(game, roster).sort((a, b) => playedMs(game, a, t) - playedMs(game, b, t));
    const n = Math.min(empty.length, bench.length);
    if (!n) return;
    const picks = assign(bench.slice(0, n), empty, rotationCost(game, [], t));
    for (const p of picks) placeAt(game, p.slot, p.pid, t);
  }

  // ---------- suggest subs (live) ----------
  function suggest(game, roster, t, opts) {
    opts = opts || {};
    const minStint = opts.minStintMs != null ? opts.minStintMs : 3 * 60000;
    const history = opts.history || [];
    normalizeQueue(game, roster);
    const manual = game.queue.filter((r) => r.manual);
    const takenSlots = new Set(manual.map((r) => r.slot));
    const takenIn = new Set(manual.map((r) => r.inPid));

    const bench = benchIds(game, roster)
      .filter((p) => !takenIn.has(p))
      .sort((a, b) => playedMs(game, a, t) - playedMs(game, b, t) || benchMs(game, b, t) - benchMs(game, a, t));

    const emptySlots = Object.keys(game.slots).filter((s) => game.slots[s] == null && !takenSlots.has(s));
    const outSlots = Object.keys(game.slots)
      .filter((s) => game.slots[s] != null && !takenSlots.has(s) && !(game.gkLock && s === 'GK'))
      .sort((a, b) => {
        const pa = game.slots[a];
        const pb = game.slots[b];
        const ra = currentStintMs(game, pa, t) < minStint ? 1 : 0;
        const rb = currentStintMs(game, pb, t) < minStint ? 1 : 0;
        return (
          ra - rb ||
          playedMs(game, pb, t) - playedMs(game, pa, t) ||
          currentStintMs(game, pb, t) - currentStintMs(game, pa, t)
        );
      });

    const vacate = emptySlots.concat(outSlots).slice(0, bench.length);
    const incoming = bench.slice(0, vacate.length);
    const picks = assign(incoming, vacate, rotationCost(game, history, t));
    game.queue = manual.concat(picks.map((p) => ({ inPid: p.pid, slot: p.slot, manual: false })));
    return { queued: picks.length, leftOnBench: bench.slice(vacate.length) };
  }

  // in live mode, queue the best bench players into any empty slots (keeps other rows)
  function queueFillEmpty(game, roster, t) {
    normalizeQueue(game, roster);
    const takenSlots = new Set(game.queue.map((r) => r.slot));
    const takenIn = new Set(game.queue.map((r) => r.inPid));
    const empty = Object.keys(game.slots).filter((s) => game.slots[s] == null && !takenSlots.has(s));
    const bench = benchIds(game, roster)
      .filter((p) => !takenIn.has(p))
      .sort((a, b) => playedMs(game, a, t) - playedMs(game, b, t));
    const n = Math.min(empty.length, bench.length);
    if (!n) return 0;
    const picks = assign(bench.slice(0, n), empty, rotationCost(game, [], t));
    picks.forEach((p) => game.queue.push({ inPid: p.pid, slot: p.slot, manual: false }));
    return n;
  }

  // player can't continue / leaves / marked absent
  function removePlayer(game, roster, pid, t) {
    const s = slotOf(game, pid);
    if (s) benchSlot(game, s, t);
    game.queue = game.queue.filter((r) => r.inPid !== pid);
    reflow(game, roster, t);
  }
  function reflow(game, roster, t) {
    normalizeQueue(game, roster);
    if (game.phase === 'live') queueFillEmpty(game, roster, t);
    else if (game.phase !== 'final') fillEmptyDirect(game, roster, t);
  }

  function setFormation(game, roster, f, t) {
    if (f === game.formation) return;
    const old = game.slots;
    const next = {};
    slotDefs(f).forEach((s) => (next[s.id] = null));
    const moves = []; // [pid, newSlot]
    for (const k in old) {
      const pid = old[k];
      if (pid == null) continue;
      if (k in next) moves.push([pid, k, k]);
    }
    if (f === '8' && old.ST != null) moves.push([old.ST, 'ST', 'LS']);
    if (f === '7') {
      const ls = old.LS;
      const rs = old.RS;
      const cands = [ls, rs].filter((p) => p != null).sort((a, b) => playedMs(game, a, t) - playedMs(game, b, t));
      if (cands.length) moves.push([cands[0], cands[0] === ls ? 'LS' : 'RS', 'ST']);
    }
    // close all stints, reopen in new layout
    for (const k in old) if (old[k] != null) endStint(game, old[k], t);
    game.formation = f;
    game.slots = next;
    for (const [pid, , ns] of moves) {
      game.slots[ns] = pid;
      startStint(game, pid, ns, t);
    }
    prune(game);
    game.queue = game.queue.filter((r) => r.slot in next);
    reflow(game, roster, t);
  }

  // ---------- clock / phases ----------
  function startClock(game, nowReal) {
    if (game.clock.since == null) game.clock.since = nowReal;
  }
  function pauseClock(game, nowReal) {
    if (game.clock.since != null) {
      game.clock.acc += Math.max(0, nowReal - game.clock.since);
      game.clock.since = null;
    }
  }
  function halfClockMs(game, nowReal) {
    return gameMs(game, nowReal) - game.halfStarts[game.halfStarts.length - 1];
  }

  function summary(game, roster, t) {
    const ids = roster.map((p) => p.id);
    const minutes = {};
    const lines = {};
    ids.forEach((id) => {
      const ms = playedMs(game, id, t);
      if (ms > 0) {
        minutes[id] = ms;
        lines[id] = lineMs(game, id, t);
      }
    });
    const starters = game.stints.filter((s) => s.start === 0).map((s) => s.pid);
    return { date: game.date, formation: game.formation, totalMs: t, minutes, lineMs: lines, starters };
  }

  const E = {
    FORMATIONS, LINES, slotDefs, slotDef, newGame, gameMs, halfClockMs, onFieldIds, slotOf, available, benchIds,
    playedMs, lineMs, stintCount, currentStintMs, benchMs, fairShareMs, placeAt, benchSlot, swapSlots,
    normalizeQueue, queueManual, unqueue, applyRow, applyAll, populate, fillEmptyDirect, suggest, queueFillEmpty,
    removePlayer, reflow, setFormation, startClock, pauseClock, summary, assign,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  else root.Engine = E;
})(typeof self !== 'undefined' ? self : this);
