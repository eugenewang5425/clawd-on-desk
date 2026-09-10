"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createHitUnresponsiveRecovery } = require("../src/hit-unresponsive-recovery");

function createLadder({
  forceCrashWorks = true,
  readyAt = null, // ms from now at which isReady() flips true; null = never
  crashLimit = 3,
  rebuildLimit = 2,
  nowMs = 1_000_000,
} = {}) {
  const calls = [];
  let now = nowMs;
  let timers = [];

  const advance = (ms) => {
    now += ms;
    const due = timers.filter((t) => !t.cleared && t.at <= now);
    for (const t of due) {
      t.cleared = true;
      t.cb();
    }
  };

  const recovery = createHitUnresponsiveRecovery({
    onRelease: () => calls.push(["release"]),
    reload: () => calls.push(["reload"]),
    forceCrash: () => {
      calls.push(["forceCrash"]);
      return forceCrashWorks;
    },
    rebuild: () => calls.push(["rebuild"]),
    isReady: () => {
      calls.push(["isReady"]);
      return readyAt !== null && now >= nowMs + readyAt;
    },
    now: () => now,
    setTimeoutFn: (cb, ms) => {
      const t = { cb, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeoutFn: (t) => { if (t) t.cleared = true; },
    crashLimit,
    rebuildLimit,
  });

  const names = () => calls.map((c) => c[0]);
  return { recovery, calls, names, advance };
}

describe("hit-unresponsive-recovery ladder", () => {
  it("requires all recovery primitives", () => {
    assert.throws(() => createHitUnresponsiveRecovery({}));
  });

  it("unresponsive #1 releases drag state once and reloads", () => {
    const { recovery, calls } = createLadder();
    recovery.onUnresponsive();
    assert.deepStrictEqual(calls, [["release"], ["reload"]]);
    recovery.dispose();
  });

  it("deadline with the reload still unfinished escalates to force-crash", () => {
    const { recovery, advance, names } = createLadder();
    recovery.onUnresponsive();
    advance(10_000);
    assert.deepStrictEqual(names(), ["release", "reload", "isReady", "forceCrash"]);
    recovery.dispose();
  });

  it("a ready window at deadline time ends the episode: next unresponsive reloads again", () => {
    const { recovery, advance, calls } = createLadder({ readyAt: 5_000 });
    recovery.onUnresponsive();
    advance(10_000);
    assert.ok(!calls.some((c) => c[0] === "forceCrash"), calls.join("; "));
    calls.length = 0;
    recovery.onUnresponsive();
    assert.deepStrictEqual(calls, [["release"], ["reload"]]);
  });

  it("a second unresponsive in the same episode skips the reload and force-crashes", () => {
    const { recovery, calls } = createLadder();
    recovery.onUnresponsive();
    calls.length = 0;
    recovery.onUnresponsive();
    assert.deepStrictEqual(calls, [["release"], ["forceCrash"]]);
    recovery.dispose();
  });

  it("a load-complete after a hang still escalates on the next unresponsive (reload cannot loop)", () => {
    const { recovery, calls } = createLadder();
    recovery.onUnresponsive();
    recovery.onDidFinishLoad(); // reloaded page loaded, then hung again
    calls.length = 0;
    recovery.onUnresponsive();
    assert.deepStrictEqual(
      calls,
      [["release"], ["forceCrash"]],
      "one reload per episode; a surviving hang escalates",
    );
    recovery.dispose();
  });

  it("crash cap reached in-window escalates to an input-window rebuild", () => {
    const { recovery, calls } = createLadder({ crashLimit: 2 });
    recovery.onUnresponsive(); // reload
    recovery.onUnresponsive(); // crash 1
    recovery.onUnresponsive(); // crash 2
    calls.length = 0;
    recovery.onUnresponsive(); // cap reached → rebuild
    assert.deepStrictEqual(calls, [["release"], ["rebuild"]]);
    recovery.dispose();
  });

  it("a rebuild resets the episode ladder: the next unresponsive reloads first again", () => {
    const { recovery, calls } = createLadder({ crashLimit: 1 });
    recovery.onUnresponsive(); // reload
    recovery.onUnresponsive(); // crash (cap 1/1 reached)
    recovery.onUnresponsive(); // rebuild
    calls.length = 0;
    recovery.onUnresponsive();
    assert.deepStrictEqual(calls, [["release"], ["reload"]]);
    recovery.dispose();
  });

  it("rebuild cap reached stands down without further window churn", () => {
    const { recovery, calls, names } = createLadder({ crashLimit: 1, rebuildLimit: 1 });
    // Episode 1: reload → crash (cap 1/1) → rebuild (cap 1/1)
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    assert.deepStrictEqual(
      names(),
      ["release", "reload", "release", "forceCrash", "release", "rebuild"],
      names().join("; "),
    );
    // Episode 2: the rebuild reset the per-episode ladder, so this starts with
    // a reload again. The next hang wants a crash — the crash cap (1/window)
    // is spent and the rebuild cap (1/window) is exhausted, so the ladder
    // records the crash attempt but stands down without touching the window.
    calls.length = 0;
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    assert.deepStrictEqual(names(), ["release", "reload", "release", "forceCrash"], names().join("; "));
    recovery.dispose();
  });

  it("rebuild cap is per-window: churn is allowed again once the window slides", () => {
    const { recovery, calls, names, advance } = createLadder({ crashLimit: 1, rebuildLimit: 1 });
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    recovery.onUnresponsive(); // rebuild 1
    calls.length = 0;
    advance(11 * 60_000);
    recovery.onUnresponsive(); // reload
    recovery.onUnresponsive(); // crash
    recovery.onUnresponsive(); // rebuild 2 — old timestamp pruned out of the window
    assert.deepStrictEqual(
      names(),
      ["release", "reload", "release", "forceCrash", "release", "rebuild"],
      names().join("; "),
    );
    recovery.dispose();
  });

  it("an unavailable force-crash falls through to a rebuild", () => {
    const { recovery, calls } = createLadder({ forceCrashWorks: false });
    recovery.onUnresponsive(); // reload
    calls.length = 0;
    recovery.onUnresponsive(); // wants crash, primitive refuses → rebuild
    assert.deepStrictEqual(calls, [["release"], ["forceCrash"], ["rebuild"]]);
    recovery.dispose();
  });

  it("releases drag state on every unresponsive entry, including escalations", () => {
    const { recovery, calls } = createLadder();
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    assert.strictEqual(calls.filter((c) => c[0] === "release").length, 3, calls.join("; "));
    recovery.dispose();
  });

  it("dispose cancels a pending deadline", () => {
    const { recovery, advance, calls } = createLadder();
    recovery.onUnresponsive();
    calls.length = 0;
    recovery.dispose();
    advance(60_000);
    assert.deepStrictEqual(calls, [], "disposed ladder must not fire");
  });
});
