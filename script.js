(() => {
  const canvas = document.getElementById('rings');
  const ctx = canvas.getContext('2d', { alpha: false });

  // --- HiDPI resize ----------------------------------------------------------
  function resize() {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // --- Deterministic RNG -----------------------------------------------------
  function mulberry32(seed) {
    return function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(184211);

  function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  function smoothstep(t){ return t * t * (3 - 2 * t); }
  function lerp(a,b,t){ return a + (b-a) * t; }

  // --- Hint UI ---------------------------------------------------------------
  const hintEl = document.querySelector('.hint');
  function showHint(text, ms = 2600) {
    if (!hintEl) return;
    hintEl.querySelector('span').textContent = text;
    hintEl.classList.add('show');
    if (ms > 0) {
      clearTimeout(showHint._t);
      showHint._t = setTimeout(() => hintEl.classList.remove('show'), ms);
    }
  }

  // --- Geometry / layout -----------------------------------------------------
  const state = {
    cx: 0, cy: 0, maxVisibleRadius: 0,
    baseRadius: 56,
    ringGap: 40.8,

    // We precompute a full set of ring radii, but only draw N of them.
    rings: [], // [{r,born}]
    maxRings: 110,

    // Visible rings control (0 => 1 ring, 1 => 2 rings, etc.)
    visibleTarget: 0,
    visible: 0,

    // Scrub
    dragging: false,
    dragStartX: 0,
    visibleStart: 0,

    // Tap-based distortions (low-frequency bumps in angular space)
    taps: [], // {ang, amp, sigma, created}
  };

  function updateCenter() {
    state.cx = window.innerWidth * 0.44;   // down-left offset (logo stays centered)
    state.cy = window.innerHeight * 0.62;
    const maxR = Math.sqrt(window.innerWidth*window.innerWidth + window.innerHeight*window.innerHeight);
    state.maxVisibleRadius = maxR * 0.62;
  }
  updateCenter();
  window.addEventListener('resize', updateCenter, { passive: true });

  // --- Build ring radii ------------------------------------------------------
  function rebuildRings(now = performance.now()) {
    state.rings = [];
    let r = state.baseRadius;
    for (let i = 0; i < state.maxRings; i++) {
      state.rings.push({ r, born: now + i * 18 }); // slight stagger -> gentle fade
      r += state.ringGap;
    }
  }
  rebuildRings();

  // --- Organic trunk outline (cloud-like, low frequency) ---------------------
  // We create a small set of harmonics (sin/cos) to define the outer contour.
  // This yields "cloud" lobes rather than spiky noise.
  const harmonics = [];
  const H = 5; // keep LOW frequency
  for (let k = 1; k <= H; k++) {
    harmonics.push({
      k,
      a: (rnd() * 2 - 1),
      b: (rnd() * 2 - 1),
    });
  }

  function wrapAngle(a) {
    const twoPi = Math.PI * 2;
    a = (a + Math.PI) % twoPi;
    if (a < 0) a += twoPi;
    return a - Math.PI;
  }

  function gaussian(x, sigma) {
    return Math.exp(-0.5 * (x * x) / (sigma * sigma));
  }

  // Base shape field at angle a (radians): smooth, low-frequency, coherent
  function trunkField(a) {
    // normalize to [-1,1] roughly
    let s = 0;
    let norm = 0;
    for (const h of harmonics) {
      const k = h.k;
      // Weight higher harmonics less (strongly)
      const w = 1 / (k * k);
      s += w * (h.a * Math.sin(k * a) + h.b * Math.cos(k * a));
      norm += w;
    }
    s /= norm;

    // add very subtle extra smoothness by applying a cubic curve
    // (keeps lobes "cloudy" and prevents sharp transitions)
    return s * 0.85;
  }

  // Tap distortions: each tap adds a low-frequency bump in angle-space
  function tapField(a, now) {
    let s = 0;
    for (const t of state.taps) {
      // slow decay; keeps it "imprinted" but not permanent
      const d = wrapAngle(a - t.ang);
      s += t.amp * gaussian(d, t.sigma);
    }
    return s;
  }

  // Final radius multiplier at angle a:
  // a cloud-like trunk silhouette + tap influence; outer rings get a bit more impact.
  function ringVarField(a, ringIndex) {
    // Low-frequency, ring-specific variation that slightly changes spacing between rings.
    // Designed to be "cloudy" (no spiky edges).
    const twoPi = Math.PI * 2;

    // Deterministic phases derived from ringIndex (no extra RNG needed)
    const p1 = ((ringIndex * 1.37) % 1) * twoPi;
    const p2 = ((ringIndex * 0.73 + 0.19) % 1) * twoPi;
    const p3 = ((ringIndex * 0.41 + 0.57) % 1) * twoPi;

    // Strongly weight the lowest modes
    const s =
      1.00 * Math.sin(1 * a + p1) +
      0.55 * Math.cos(2 * a + p2) +
      0.25 * Math.sin(3 * a + p3);

    // Normalize-ish to about [-1,1]
    return s / 1.80;
  }

  // Final radius multiplier at angle a:
  // cloud-like trunk silhouette + tap influence + subtle per-ring variability (spacing changes)
  function radiusMultiplier(a, ringIndex, now) {
    const base = trunkField(a);
    const tap = tapField(a, now);

    // Overall intensity knobs:
    const baseRel = 0.18; // non-circular trunk outline
    const tapRel  = 0.10; // tap effect

    // New: per-ring low-frequency variation.
    // This mostly changes "ring spacing" locally around the circumference.
    // Keep it smaller than baseRel so rings remain recognizably related.
    const ringRel = 0.030; // ~3% radius variation

    // Outer rings can vary a touch more (real growth irregularity)
    const outerBoost = 1 + ringIndex * 0.0024;

    const ringVar = ringVarField(a, ringIndex);

    return 1 + outerBoost * (baseRel * base + tapRel * tap + ringRel * ringVar);
  }

  // --- Drawing ---------------------------------------------------------------
  function clear() {
    ctx.fillStyle = '#F7F5F2';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  function edgeOpacity(r) {
    const fadeStart = state.maxVisibleRadius * 0.86;
    const fadeEnd = state.maxVisibleRadius * 1.06;
    const t = (r - fadeStart) / (fadeEnd - fadeStart);
    const a = 1 - clamp01(t);
    return 0.10 + a * 0.62;
  }

  function birthOpacity(born, now) {
    const age = Math.max(0, now - born);
    return smoothstep(clamp01(age / 900));
  }

  function draw(now) {
    clear();

    // ease visible rings
    state.visible += (state.visibleTarget - state.visible) * 0.14;

    const visibleCount = Math.max(1, Math.min(state.maxRings, 1 + Math.floor(state.visible + 1e-6)));

    const N = 520; // lots of segments => smooth contour
    const twoPi = Math.PI * 2;

    // slight ovality to feel more trunk-like (still subtle)
    const ex = 1.06;
    const ey = 0.96;

    for (let i = 0; i < visibleCount; i++) {
      const ring = state.rings[i];
      const rBase = ring.r;
      if (rBase > state.maxVisibleRadius * 1.14) break;

      const alpha = edgeOpacity(rBase) * birthOpacity(ring.born, now);
      const useForest = (i % 6 === 0);

      ctx.strokeStyle = useForest
        ? `rgba(31, 58, 46, ${alpha})`
        : `rgba(70, 45, 28, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let j = 0; j <= N; j++) {
        const t = j / N;
        const a = t * twoPi;

        const mult = radiusMultiplier(a, i, now);
        const r = rBase * mult;

        const x = state.cx + Math.cos(a) * r * ex;
        const y = state.cy + Math.sin(a) * r * ey;

        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    requestAnimationFrame(draw);
  }

  // --- Interaction -----------------------------------------------------------
  function setVisibleFromDrag(dx) {
    const span = Math.max(260, window.innerWidth * 0.60);
    const delta = (dx / span) * 35; // how many rings per full swipe
    state.visibleTarget = Math.max(0, Math.min(state.maxRings - 1, state.visibleStart + delta));
  }

  function addTapAt(clientX, clientY) {
    // Convert tap position to angle around center.
    const x = clientX - state.cx;
    const y = clientY - state.cy;
    const ang = Math.atan2(y, x);

    // amplitude based on distance from center: closer = smaller, mid = bigger
    const d = Math.sqrt(x*x + y*y);
    const dNorm = clamp01(d / (Math.min(window.innerWidth, window.innerHeight) * 0.55));
    const amp = lerp(0.55, 1.25, dNorm);
    const sigma = lerp(0.22, 0.12, dNorm); // radians (~12° to 22°)

    state.taps.push({ ang, amp, sigma, created: performance.now() });
    if (state.taps.length > 18) state.taps.shift();
  }

  function onPointerDown(e) {
    // Tap detection (works on mobile where click may not fire)
    state._downX = e.clientX;
    state._downY = e.clientY;
    state._downAt = performance.now();
    state._moved = false;
    canvas.setPointerCapture(e.pointerId);
    state.dragging = true;
    state.dragStartX = e.clientX;
    state.visibleStart = state.visibleTarget;

    // Pause hint after first touch
    showHint('swipe left ↔ right to size — tap to shape', 2200);
  }

  function onPointerMove(e) {
    if (state._downAt) {
      const dx0 = e.clientX - state._downX;
      const dy0 = e.clientY - state._downY;
      if (!state._moved && (dx0*dx0 + dy0*dy0) > 12*12) state._moved = true;
    }
    if (!state.dragging) return;
    setVisibleFromDrag(e.clientX - state.dragStartX);
  }

  function onPointerUp(e) {
    state.dragging = false;

    // If it's a "tap" (tiny movement), add distortion bump
    const dx = Math.abs(e.clientX - state.dragStartX);
    /* tap detection handled by click */
  }

  // We'll implement taps using a separate click handler (more reliable across devices)

  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerup', (e) => {
    state.dragging = false;
    const dt = performance.now() - (state._downAt || performance.now());
    const wasTap = (dt < 450) && !state._moved;
    // If the user didn't drag (or only tiny movement), treat as tap distortion.
    if (wasTap) addTapAt(e.clientX, e.clientY);
    state._downAt = 0;
  }, { passive: true });
  canvas.addEventListener('pointercancel', (e) => { state.dragging = false; state._downAt = 0; }, { passive: true });

  // --- Start -----------------------------------------------------------------
  // Start with 1 ring (visibleTarget=0). Show the initial hint.
  showHint('swipe left ↔ right to reveal rings — tap to introduce subtle distortion', 3600);

  requestAnimationFrame(draw);
})();
