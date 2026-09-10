"use strict";

// ── Bounded recovery for a hung hitWin renderer (#998 review P1) ──
//
// "unresponsive" fires when the input renderer stops servicing its event
// loop. A plain webContents.reload() does not reliably complete against a
// hard hang (verified independently on Electron 41.10.4: ~19s later the
// renderer was still on its first load), and a reload that does complete can
// hang again immediately. Recovery therefore escalates on real hang signals,
// with a sliding-window cap on the two destructive primitives:
//
//   unresponsive #1            → release drag state + reload + arm deadline
//   deadline, reload unfinished→ forcefullyCrashRenderer() (turns the hang
//                                into render-process-gone, which main's crash
//                                path already reloads with a fresh process)
//   unresponsive again before
//   a healthy load             → reload only ever gets ONE try per episode;
//                                escalate straight to force-crash
//   crash cap reached in-window→ rebuild the input window outright
//
// A completed load refreshes the episode — but if the reloaded page hangs
// again without ever finishing a load, the next unresponsive still sees
// reloadUsed=true and escalates, so a reload that silently no-ops can never
// loop. Rebuilds are additionally capped within the window; once both caps
// are exhausted the ladder logs and stands down — the drag-lock watchdog and
// the manual healing actions remain as backstops.

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_CRASH_LIMIT = 3;
const DEFAULT_REBUILD_LIMIT = 2;
const DEFAULT_WINDOW_MS = 10 * 60_000;

function createHitUnresponsiveRecovery(options = {}) {
  const onRelease = options.onRelease;
  const reload = options.reload;
  const forceCrash = options.forceCrash;
  const rebuild = options.rebuild;
  const isReady = options.isReady;
  for (const [name, fn] of [
    ["onRelease", onRelease],
    ["reload", reload],
    ["forceCrash", forceCrash],
    ["rebuild", rebuild],
    ["isReady", isReady],
  ]) {
    if (typeof fn !== "function") throw new Error(`createHitUnresponsiveRecovery requires ${name}`);
  }
  const now = options.now || (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn || ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = options.clearTimeoutFn || ((t) => clearTimeout(t));
  const log = typeof options.log === "function" ? options.log : () => {};
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : DEFAULT_DEADLINE_MS;
  const crashLimit = Number.isFinite(options.crashLimit) ? options.crashLimit : DEFAULT_CRASH_LIMIT;
  const rebuildLimit = Number.isFinite(options.rebuildLimit) ? options.rebuildLimit : DEFAULT_REBUILD_LIMIT;
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : DEFAULT_WINDOW_MS;

  let deadlineTimer = null;
  // One reload per hang episode: a hang that survives a load-complete means
  // this episode's reload already ran and did not stick.
  let reloadUsed = false;
  let crashTimestamps = [];
  let rebuildTimestamps = [];

  function prune(timestamps) {
    const ts = Number(now());
    return timestamps.filter((t) => t >= ts - windowMs);
  }

  function clearDeadline() {
    if (deadlineTimer === null) return;
    clearTimeoutFn(deadlineTimer);
    deadlineTimer = null;
  }

  function armDeadline() {
    clearDeadline();
    deadlineTimer = setTimeoutFn(onDeadline, deadlineMs);
  }

  function standDown(reason) {
    clearDeadline();
    log(`hitWin recovery standing down: ${reason}`);
  }

  function attemptRebuild(reason) {
    clearDeadline();
    rebuildTimestamps = prune(rebuildTimestamps);
    if (rebuildTimestamps.length >= rebuildLimit) {
      standDown(`rebuild limit reached (${rebuildLimit} in ${windowMs}ms): ${reason}`);
      return;
    }
    rebuildTimestamps.push(Number(now()));
    log(`hitWin recovery rebuilding input window: ${reason}`);
    reloadUsed = false;
    crashTimestamps = [];
    rebuild();
  }

  function attemptForceCrash(reason) {
    clearDeadline();
    crashTimestamps = prune(crashTimestamps);
    if (crashTimestamps.length >= crashLimit) {
      attemptRebuild(`force-crash limit reached (${crashLimit} in ${windowMs}ms): ${reason}`);
      return;
    }
    log(`hitWin recovery forcefully crashing renderer: ${reason}`);
    if (!forceCrash()) {
      attemptRebuild(`force-crash unavailable: ${reason}`);
      return;
    }
    crashTimestamps.push(Number(now()));
    armDeadline();
  }

  function onDeadline() {
    deadlineTimer = null;
    if (isReady()) {
      // Fresh renderer, healthy load: the episode is over.
      reloadUsed = false;
      return;
    }
    attemptForceCrash("reload did not complete before the deadline");
  }

  function onUnresponsive() {
    // Every entry releases stranded drag state first: a hung renderer cannot
    // finish the pointerup handshake, and the ladder may take a while (or
    // rebuild the window) before input works again.
    onRelease();
    if (!reloadUsed) {
      reloadUsed = true;
      log("hitWin unresponsive — releasing drag state and reloading");
      reload();
      armDeadline();
      return;
    }
    attemptForceCrash("unresponsive again in the same episode");
  }

  function onDidFinishLoad() {
    // A load completed — but that is not proof of health: the freshly loaded
    // page can hang immediately. reloadUsed deliberately stays set so the
    // next unresponsive escalates instead of reloading into another hang.
    clearDeadline();
  }

  function resetEpisode() {
    reloadUsed = false;
    crashTimestamps = [];
    clearDeadline();
  }

  function dispose() {
    clearDeadline();
  }

  return {
    onUnresponsive,
    onDidFinishLoad,
    dispose,
    // Test/diagnostic surface.
    _state: () => ({ reloadUsed, crashTimestamps: [...crashTimestamps], rebuildTimestamps: [...rebuildTimestamps] }),
  };
}

module.exports = {
  createHitUnresponsiveRecovery,
  DEFAULT_DEADLINE_MS,
  DEFAULT_CRASH_LIMIT,
  DEFAULT_REBUILD_LIMIT,
  DEFAULT_WINDOW_MS,
};
