"use strict";

// Cross-module regression for #997 / PR #998 review item 1:
// "renderer alive with a running heartbeat, only the mouse-up was lost".
//
// This wires the REAL pieces together — the actual hit-renderer.js in a VM,
// the real registerPetInteractionIpc, a real dragLocked cell and the real
// drag-lock watchdog — so the assertions cover both sides of the handshake
// (main-process dragLocked + renderer isDragging) instead of each module in
// isolation. The reviewer's failure case is exactly the gap between them:
// heartbeat alive ⇒ watchdog sees "live drag" forever, so the watchdog alone
// can never recover a lost mouse-up.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HIT_RENDERER = path.join(__dirname, "..", "src", "hit-renderer.js");
const SOURCE = fs.readFileSync(HIT_RENDERER, "utf8").replace(/\r\n/g, "\n");

const { registerPetInteractionIpc } = require("../src/pet-interaction-ipc");
const { createDragLockWatchdog } = require("../src/drag-lock-watchdog");

// ── Minimal renderer harness (mirrors test/hit-renderer.test.js) ──
class FakeArea {
  constructor() {
    this.style = {};
    this.classList = { add: () => {}, remove: () => {} };
    this.offsetWidth = 200;
    this.listeners = new Map();
  }
  addEventListener(event, cb) { this.listeners.set(event, cb); }
  setPointerCapture() {}
}

function createRenderer() {
  const apiCalls = [];
  const apiHandlers = {};
  const area = new FakeArea();
  const docListeners = new Map();
  const fakeDocument = {
    getElementById: (id) => (id === "hit-area" ? area : null),
    addEventListener: (event, cb) => { docListeners.set(event, cb); },
  };
  const timers = [];
  let timerId = 0;
  const context = {
    document: fakeDocument,
    window: {
      hitPlatform: { isMac: false, platform: "win32" },
      hitThemeConfig: { reactions: {} },
      hitAPI: {
        onThemeConfig: () => {},
        dragLock: (v) => apiCalls.push(["dragLock", v]),
        dragAlive: () => apiCalls.push(["dragAlive"]),
        dragMove: () => apiCalls.push(["dragMove"]),
        dragEnd: () => apiCalls.push(["dragEnd"]),
        showContextMenu: () => {},
        focusTerminal: () => {},
        exitMiniMode: () => {},
        showDashboard: () => {},
        revealSessionHud: () => {},
        startDragReaction: () => {},
        endDragReaction: () => apiCalls.push(["endDragReaction"]),
        playClickReaction: () => {},
        getPathForFile: () => "",
        dropPaths: () => {},
        onDropAccepted: () => {},
        onStateSync: (cb) => { apiHandlers.stateSync = cb; },
        onCancelReaction: (cb) => { apiHandlers.cancelReaction = cb; },
        onForceDragRelease: (cb) => { apiHandlers.forceDragRelease = cb; },
      },
      addEventListener: () => {},
    },
    setTimeout: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setInterval: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, interval: true, cleared: false };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => { if (t) t.cleared = true; },
    requestAnimationFrame: (cb) => context.setTimeout(cb, 16),
    cancelAnimationFrame: (t) => context.clearTimeout(t),
    console: { warn() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(SOURCE, context);
  apiHandlers.stateSync({ currentState: "idle", miniMode: false, dndEnabled: false });

  return {
    apiCalls,
    apiHandlers,
    context,
    pointerdown: (clientX = 100, clientY = 100) => {
      const cb = area.listeners.get("pointerdown");
      cb({ button: 0, pointerId: 1, clientX, clientY });
    },
    pointermove: (clientX, clientY, buttons) => {
      docListeners.get("pointermove")({ clientX, clientY, buttons });
    },
    pointerup: (clientX = 100) => {
      docListeners.get("pointerup")({ button: 0, ctrlKey: false, metaKey: false, clientX });
    },
    /**
     * Fire every live heartbeat interval once per simulated second AND advance
     * the shared clock, so "N heartbeats" really is N seconds of drag time.
     */
    tickHeartbeats: (times = 1) => {
      for (let i = 0; i < times; i++) {
        const t = timers.find((x) => x.interval && !x.cleared);
        if (!t) return false;
        if (context.__advanceClock) context.__advanceClock(1000);
        t.cb();
      }
      return true;
    },
    /** True while a drag is locally captured (isDragging observable via the lock it keeps). */
    hasLiveHeartbeat: () => timers.some((t) => t.interval && !t.cleared),
    last: (name) => apiCalls.filter((c) => c[0] === name).map((c) => c[1]),
  };
}

// ── Main side: real IPC registrar + real lock cell + real watchdog ──
class FakeIpcMain {
  constructor() { this.listeners = new Map(); }
  on(channel, listener) { this.listeners.set(channel, listener); }
  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "hit-web-contents" }, ...args);
  }
}

function createMainSide() {
  const renderer = createRenderer();
  const ipcMain = new FakeIpcMain();
  const state = {
    dragLocked: false,
    idlePaused: false,
    mouseOverPet: false,
    synced: 0,
    released: [],
    lastAliveAt: 0,
  };
  let now = 1_000_000;

  const runtime = registerPetInteractionIpc({
    ipcMain,
    showContextMenu: () => {},
    moveWindowForDrag: () => {},
    setIdlePaused: (v) => { state.idlePaused = !!v; },
    setLowPowerIdlePaused: () => {},
    isMiniTransitioning: () => false,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    sendToRenderer: () => {},
    settleVisual: () => true,
    recoverVisiblePetAfterRendererLoad: () => {},
    setDragLocked: (v) => { state.dragLocked = !!v; },
    setMouseOverPet: (v) => { state.mouseOverPet = !!v; },
    onDragAlive: () => { state.lastAliveAt = now; },
    cancelRoam: () => {},
    beginDragSnapshot: () => {},
    clearDragSnapshot: () => {},
    syncHitWin: () => { state.synced += 1; },
    syncDisplayedVisualGeometry: () => {},
    setAccessoryMirror: () => {},
    syncImeEditingPetDodge: () => {},
    isMiniMode: () => false,
    checkMiniModeSnap: () => {},
    hasPetWindow: () => true,
    getPetWindowBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getCurrentPixelSize: () => ({ width: 100, height: 100 }),
    computeDragEndBounds: (b) => b,
    applyPetWindowBounds: () => {},
    flushRuntimeStateToPrefs: () => {},
    reassertWinTopmost: () => {},
    scheduleHwndRecovery: () => {},
    repositionFloatingBubbles: () => {},
    exitMiniMode: () => {},
    getFocusableLocalHudSessionIds: () => [],
    focusLog: () => {},
    showDashboard: () => {},
    focusSession: () => {},
    revealSessionHud: () => {},
    statPath: async () => ({}),
    openTerminalAt: async () => ({ ok: true }),
    dropLog: () => {},
    isMacPlatform: false,
  });

  renderer.context.__advanceClock = (ms) => { now += ms; };

  const watchdog = createDragLockWatchdog({
    isDragLocked: () => state.dragLocked,
    getLastDragAliveAt: () => state.lastAliveAt,
    now: () => now,
    forceRelease: (reason) => {
      if (!state.dragLocked) return false;
      state.dragLocked = false;
      state.idlePaused = false;
      state.mouseOverPet = false;
      state.released.push(reason);
      // Same push main.js performs: an alive renderer drops its phantom drag.
      renderer.apiHandlers.forceDragRelease();
      return true;
    },
  });

  // Bridge the renderer's outbound apiCalls into the real IPC layer, exactly
  // like preload-hit.js does over ipcRenderer.send.
  const originalPush = renderer.apiCalls.push.bind(renderer.apiCalls);
  renderer.apiCalls.push = (...entries) => {
    for (const [name, arg] of entries) {
      if (name === "dragLock") ipcMain.send("drag-lock", arg);
      else if (name === "dragAlive") ipcMain.send("drag-alive");
      else if (name === "dragMove") ipcMain.send("drag-move");
      else if (name === "dragEnd") ipcMain.send("drag-end");
    }
    return originalPush(...entries);
  };

  return {
    renderer,
    ipcMain,
    runtime,
    watchdog,
    state,
    advance: (ms) => { now += ms; },
  };
}

describe("stranded drag-lock recovery across renderer + main (#997 / #998 review 1)", () => {
  it("a normal drag ends cleanly on both sides", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    assert.equal(h.state.dragLocked, true, "main locks on pointerdown");
    h.renderer.pointermove(120, 120, 1);
    h.renderer.pointerup(120);
    assert.equal(h.state.dragLocked, false, "main unlocks on pointerup");
    assert.equal(h.renderer.hasLiveHeartbeat(), false, "renderer stops heartbeating");
  });

  it("lost pointerup + continued hover releases both sides on the first buttons=0 move", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    h.renderer.pointermove(120, 120, 1);
    // The physical gesture ends here, but every DOM end signal is dropped.
    // The heartbeat keeps running — this is the reviewer's failure case.
    h.renderer.tickHeartbeats(3);
    assert.equal(h.state.dragLocked, true);
    assert.equal(h.renderer.hasLiveHeartbeat(), true);

    // The mouse is still over the pet; the OS delivers a hover move with no
    // button pressed. This is the only signal that survives a swallowed up.
    h.renderer.pointermove(140, 140, 0);

    assert.equal(h.state.dragLocked, false, "main must release the stranded lock");
    assert.equal(h.renderer.hasLiveHeartbeat(), false, "renderer must stop the heartbeat");
  });

  it("a genuine long press is never released by the buttons=0 detector", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    // 60s of held-still drag: heartbeat ticks, no moves at all.
    h.renderer.tickHeartbeats(60);
    assert.equal(h.watchdog.check(), "alive", "held-still drag must look alive");
    assert.equal(h.state.dragLocked, true, "long press must NOT be released");

    // Moves while still held keep it locked too.
    h.renderer.pointermove(101, 100, 1);
    assert.equal(h.state.dragLocked, true, "held moves keep the lock");
    h.renderer.pointerup(101);
    assert.equal(h.state.dragLocked, false);
  });

  it("the watchdog alone cannot recover a lost mouse-up while the heartbeat lives (reviewer's point)", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    // 60s pass with the heartbeat still ticking: the watchdog sees a live
    // drag the whole time, no matter how long the physical gesture ended ago.
    h.renderer.tickHeartbeats(60);
    assert.equal(
      h.watchdog.check(),
      "alive",
      "heartbeat says live drag — this is why buttons=0 detection is required",
    );
    assert.equal(h.state.dragLocked, true);
  });

  it("manual force-release pushes the renderer into a clean stop, then a fresh drag works", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    h.renderer.tickHeartbeats(2);
    // Main decides the lock is stranded (e.g. a healing action ran).
    h.renderer.apiHandlers.forceDragRelease();
    assert.equal(h.state.dragLocked, false);
    assert.equal(h.renderer.hasLiveHeartbeat(), false, "phantom capture dropped");

    // Next gesture starts from a clean slate on both sides.
    h.renderer.pointerdown(200, 200);
    assert.equal(h.state.dragLocked, true);
    h.renderer.pointerup(200);
    assert.equal(h.state.dragLocked, false);
  });

  it("a silently hung renderer is still caught by the watchdog", () => {
    const h = createMainSide();
    h.renderer.pointerdown(100, 100);
    // Renderer stops heartbeating entirely (hung event loop).
    h.advance(9_000);
    assert.equal(h.watchdog.check(), "released");
    assert.deepStrictEqual(h.state.released, ["watchdog-stale-heartbeat"]);
    assert.equal(h.state.dragLocked, false, "hung renderer must not hold the lock");
  });
});
