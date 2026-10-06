// Startrips goat show: pure timeline engine (no DOM).
//
// A faithful TypeScript port of the approved prototype engine
// (docs/plans/goat-proto/goat-show-engine.js). Behaviour is numerically
// identical; goatShowEngine.test.ts pins it to the prototype's golden frames.
// The choreography is built once, on first use, so importing the header does
// not pay for it at boot.
import { GOAT_SHOW_ART as DATA, type GoatShowLegKey } from "./goatShowArt";

export type Vec = [number, number];
type Segments = [number, number, number];
type Frame = "world" | "trips";
type Anchor = { f: Frame; p: Vec; a: number; n: Vec };
type Stance = Record<GoatShowLegKey, Anchor>;
type BodyPose = { A: Vec; p: number; face: number };
export type GoatPose = BodyPose & { neck: number; head: number; ears: number; tail: number };
export type GoatShowStar = { p: Vec; s: number; r: number };
export type GoatShowTrips = { th: number; sink: number; notch: number };
export type GoatShowState = {
  t: number;
  goat: GoatPose;
  legs: Record<GoatShowLegKey, Segments>;
  star: GoatShowStar;
  trips: GoatShowTrips;
  letters: Array<{ dy: number; r: number }>;
};
export type GoatShowAttrs = Record<string, string>;

export const DUR = 8900;

type Engine = {
  frame: (t: number) => GoatShowState;
  attrs: (st: GoatShowState) => GoatShowAttrs;
  svg: (kind: string, st: GoatShowState, vb: string, extraAttr?: string, clipId?: string) => string;
};

function createGoatShow(): Engine {
  // ---------- math ----------
  const D2R = Math.PI / 180;
  function rotV(v: Vec, deg: number): Vec { const r = deg * D2R, c = Math.cos(r), s = Math.sin(r); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; }
  function add(a: Vec, b: Vec): Vec { return [a[0] + b[0], a[1] + b[1]]; }
  function sub(a: Vec, b: Vec): Vec { return [a[0] - b[0], a[1] - b[1]]; }
  function mul(a: Vec, k: number): Vec { return [a[0] * k, a[1] * k]; }
  function mid(a: Vec, b: Vec): Vec { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function len(v: Vec) { return Math.hypot(v[0], v[1]); }
  function ang(v: Vec) { return Math.atan2(v[1], v[0]) / D2R; }
  function dir(deg: number): Vec { return [Math.cos(deg * D2R), Math.sin(deg * D2R)]; }
  function lerp(a: number, b: number, u: number) { return a + (b - a) * u; }
  function lerp2(a: Vec, b: Vec, u: number): Vec { return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)]; }
  function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }
  function eio(u: number) { u = clamp(u, 0, 1); return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function eout(u: number) { u = clamp(u, 0, 1); const v = 1 - u; return 1 - v * v * v; }
  function ein2(u: number) { u = clamp(u, 0, 1); return u * u; }
  function norm180(a: number) { while (a > 90) a -= 180; while (a <= -90) a += 180; return a; }
  function r3(n: number) { return Math.round(n * 1000) / 1000; }

  // Monotone cubic track (Fritsch-Carlson); flat at both ends and at every local extremum.
  function track(keys: Array<[number, number]>): (t: number) => number {
    keys = keys.slice().sort((a, b) => a[0] - b[0]).filter((k, i, all) => i === all.length - 1 || all[i + 1][0] !== k[0]);
    const n = keys.length, T: number[] = [], V: number[] = [], m: number[] = [], d: number[] = [];
    let i: number;
    for (i = 0; i < n; i++) { T.push(keys[i][0]); V.push(keys[i][1]); }
    if (n === 1) return () => V[0];
    for (i = 0; i < n - 1; i++) d.push((V[i + 1] - V[i]) / (T[i + 1] - T[i]));
    m[0] = 0; m[n - 1] = 0;
    for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
    }
    return (t: number) => {
      if (t <= T[0]) return V[0];
      if (t >= T[n - 1]) return V[n - 1];
      let j = 0; while (t > T[j + 1]) j++;
      const h = T[j + 1] - T[j], s = (t - T[j]) / h, s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * V[j] + (s3 - 2 * s2 + s) * h * m[j] + (-2 * s3 + 3 * s2) * V[j + 1] + (s3 - s2) * h * m[j + 1];
    };
  }

  // ---------- glyphs ----------
  const LETTERS: Array<{ ox: number; d: string }> = [];
  {
    const re = /<g transform="translate\(([\d.]+) 0\)"><path d="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(DATA.letters))) LETTERS.push({ ox: +m[1], d: m[2] });
  }
  function flatten(d: string, ox: number): Vec[][] {
    const tok = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [], polys: Vec[][] = [];
    let cur: Vec[] = [], x = 0, y = 0, sx = 0, sy = 0, i = 0, cmd = "";
    function num() { return +tok[i++]; }
    function push(px: number, py: number) { cur.push([px + ox, py]); }
    while (i < tok.length) {
      if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
      if (cmd === "M") { x = num(); y = num(); sx = x; sy = y; cur = []; polys.push(cur); push(x, y); cmd = "L"; }
      else if (cmd === "L") { x = num(); y = num(); push(x, y); }
      else if (cmd === "H") { x = num(); push(x, y); }
      else if (cmd === "V") { y = num(); push(x, y); }
      else if (cmd === "C") {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
        for (let k = 1; k <= 10; k++) {
          const u = k / 10, v = 1 - u;
          push(v * v * v * x + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3);
        }
        x = x3; y = y3;
      } else if (cmd === "Q") {
        const qx = num(), qy = num(), ex = num(), ey = num();
        for (let q = 1; q <= 8; q++) { const w = q / 8, z = 1 - w; push(z * z * x + 2 * z * w * qx + w * w * ex, z * z * y + 2 * z * w * qy + w * w * ey); }
        x = ex; y = ey;
      } else if (cmd === "Z" || cmd === "z") { x = sx; y = sy; cmd = ""; }
      else throw new Error("path command " + cmd);
    }
    return polys;
  }
  let TRIPS_POLYS: Vec[][] = [];
  for (let li = 4; li < 9; li++) TRIPS_POLYS = TRIPS_POLYS.concat(flatten(LETTERS[li].d, LETTERS[li].ox));
  function probeTop(polys: Vec[][], x: number) {
    let best = Infinity;
    polys.forEach((p) => {
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
        const yy = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
        if (yy < best) best = yy;
      }
    });
    return best;
  }

  // ---------- the "trips" word: a rigid board that tips about a point on the baseline ----------
  const PIVOT: Vec = [405, 0];
  const STEM_FACE_X = 288.592; // left edge of the t stem; it becomes the top of the column at 90 degrees
  // Up: the goat's weight tips the word into a column. Down: once it wears the halo it weighs nothing, so the
  // column lowers it to the ground like a lift, and the word comes back up flat underneath it.
  const SWAP = 5420; // below the baseline, out of sight, the word is swapped from standing to lying flat
  const TH_UP = track([[0, 0], [1395, 0], [1500, 4], [1800, 12], [2100, 26], [2400, 44], [2650, 64], [2800, 80], [2950, 92],
    [3080, 88.6], [3230, 90.8], [3370, 90]]);
  function TH(t: number) { return t < SWAP ? TH_UP(t) : 0; }
  function SINK(t: number) {
    if (t < 4400) return 0;
    if (t < 5300) return 116 * eio((t - 4400) / 900);
    if (t < SWAP) return 116 + 24 * ein2((t - 5300) / (SWAP - 5300));
    if (t < 6050) return 100 * (1 - eout((t - SWAP) / (6050 - SWAP)));
    if (t < 6330) return -1.6 * Math.sin((t - 6050) / 280 * Math.PI);
    return 0;
  }
  function tripsToWorld(p: Vec, t: number): Vec { const r = rotV(sub(p, PIVOT), TH(t)); return [r[0] + PIVOT[0], r[1] + PIVOT[1] + SINK(t)]; }

  // Anchors: a point plus the local surface angle in a frame ("world" or "trips").
  function onGround(x: number): Anchor { return { f: "world", p: [x, 0], a: 0, n: [0, -1] }; }
  function onTop(x: number): Anchor {
    const y = probeTop(TRIPS_POLYS, x), yr = probeTop(TRIPS_POLYS, x + 2), yl = probeTop(TRIPS_POLYS, x - 2);
    const s = isFinite(yr) && isFinite(yl) ? ang([4, yr - yl]) : 0;
    return { f: "trips", p: [x, y], a: clamp(s, -25, 25), n: [0, -1] };
  }
  function onFace(yl: number): Anchor { return { f: "trips", p: [STEM_FACE_X, yl], a: -90, n: [-1, 0] }; }
  function anchorWorld(an: { f: Frame; p: Vec; a: number }, t: number): { p: Vec; a: number } {
    if (an.f === "world") return { p: an.p, a: an.a };
    return { p: tripsToWorld(an.p, t), a: norm180(an.a + TH(t)) };
  }

  // ---------- goat rig ----------
  type LegRig = { hip: Vec; knee: Vec; fet: Vec; hoof: Vec; L1: number; L2: number; L3: number; r1: number; r2: number; r3: number; front: boolean };
  const LEG_KEYS: GoatShowLegKey[] = ["fn", "ff", "hn", "hf"];
  function rig(k: GoatShowLegKey, hip: Vec, knee: Vec, fet: Vec, hoof: Vec): LegRig {
    return {
      hip, knee, fet, hoof,
      L1: len(sub(knee, hip)), L2: len(sub(fet, knee)), L3: len(sub(hoof, fet)),
      r1: ang(sub(knee, hip)), r2: ang(sub(fet, knee)), r3: ang(sub(hoof, fet)),
      front: k.charAt(0) === "f",
    };
  }
  const LEG: Record<GoatShowLegKey, LegRig> = {
    fn: rig("fn", [700, -57.5], [697.5614, -35.412], [692.982, -12.65], [693.2, 0]),
    ff: rig("ff", [700, -57.5], [702.6998, -35.4], [702.982, -12.65], [703.2, 0]),
    hn: rig("hn", [740.3, -54.5], [746.4008, -34.3788], [745.482, -13.15], [746.2, 0]),
    hf: rig("hf", [740.3, -55.5], [741.2185, -34.3775], [735.482, -13.15], [736.2, 0]),
  };
  const A_LOCAL: Vec = [719.7, 0];
  const PV: Record<"neck" | "head" | "ears" | "tail", Vec> = { neck: [703, -56], head: [686, -86], ears: [692, -86], tail: [750, -56] };
  const MUZZLE: Vec = [658, -89], HALO: Vec = [690, -126];

  function toWorld(pose: BodyPose, pl: Vec): Vec { let v = sub(pl, A_LOCAL); v = [v[0] * pose.face, v[1]]; return add(rotV(v, pose.p), pose.A); }
  function toLocal(pose: BodyPose, pw: Vec): Vec { const v = rotV(sub(pw, pose.A), -pose.p); const f = pose.face < 0 ? -1 : 1; return add([v[0] * f, v[1]], A_LOCAL); }
  function headToWorld(pose: GoatPose, q: Vec) { return toWorld(pose, rotAbout(rotAbout(q, PV.head, pose.head), PV.neck, pose.neck)); }
  function rotAbout(q: Vec, c: Vec, deg: number) { return add(rotV(sub(q, c), deg), c); }

  function ik(key: GoatShowLegKey, Hl: Vec, aLocal: number): { s: Segments; reach: number } {
    const g = LEG[key], s3 = g.r3 + aLocal;
    const F = sub(Hl, mul(dir(s3), g.L3)), dv = sub(F, g.hip), d = len(dv);
    const dc = clamp(d, Math.abs(g.L1 - g.L2) + .5, (g.L1 + g.L2) * .9995);
    const cb = clamp((g.L1 * g.L1 + dc * dc - g.L2 * g.L2) / (2 * g.L1 * dc), -1, 1);
    const s1 = ang(dv) - Math.acos(cb) / D2R;
    const K = add(g.hip, mul(dir(s1), g.L1)), Fe = add(g.hip, mul(dv, dc / d));
    return { s: [s1, ang(sub(Fe, K)), s3], reach: d / (g.L1 + g.L2) };
  }
  function ikAnchor(key: GoatShowLegKey, pose: BodyPose, an: { f: Frame; p: Vec; a: number }, t: number) {
    const w = anchorWorld(an, t), f = pose.face < 0 ? -1 : 1;
    return ik(key, toLocal(pose, w.p), norm180(f * (w.a - pose.p)));
  }
  function lerpS(a: Segments, b: Segments, u: number): Segments { return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)]; }
  function segRot(key: GoatShowLegKey, s: Segments): Segments {
    const g = LEG[key], a0 = s[0] - g.r1, a01 = s[1] - g.r2, a012 = s[2] - g.r3;
    return [a0, a01 - a0, a012 - a01];
  }

  // Free-leg poses as absolute segment angles in goat space (90 = straight down, 180 = forward, 0 = back).
  const POSE: Record<string, Segments> = {
    tuckF: [118, 168, 58], reachF: [110, 116, 104], dangleF: [100, 110, 98], pronkF: [104, 112, 96], glideF: [114, 150, 72],
    trailH: [55, 60, 62], tuckH: [120, 64, 116], reachH: [92, 98, 92], dangleH: [86, 100, 100], pronkH: [82, 96, 98], glideH: [72, 82, 86],
  };
  function far(s: Segments, k: GoatShowLegKey): Segments { return k === "ff" || k === "hf" ? [s[0] - 4, s[1] - 6, s[2] + 4] : s; }

  // ---------- goat body ----------
  function stancePose(W: Record<GoatShowLegKey, Vec>, c: number, po: number, f: number, follow?: number): BodyPose {
    const F = mid(W.fn, W.ff), H = mid(W.hn, W.hf);
    const slope = Math.atan2(-f * (F[1] - H[1]), -f * (F[0] - H[0])) / D2R;
    const p = slope * (follow == null ? .95 : follow) + f * po;
    const down: Vec = [-Math.sin(p * D2R), Math.cos(p * D2R)];
    return { A: add(mid(F, H), mul(down, c)), p, face: f };
  }
  function anchorsWorld(S: Stance, t: number) {
    const W = {} as Record<GoatShowLegKey, Vec>;
    LEG_KEYS.forEach((k) => { W[k] = anchorWorld(S[k], t).p; });
    return W;
  }
  function reachOf(pose: BodyPose, S: Stance, t: number, keys: GoatShowLegKey[]) {
    let r = 0; keys.forEach((k) => { r = Math.max(r, ikAnchor(k, pose, S[k], t).reach); }); return r;
  }
  function solveExt(S: Stance, t: number, po: number, f: number, keys: GoatShowLegKey[], target: number) {
    const W = anchorsWorld(S, t);
    let lo = -40, hi = 20;
    for (let i = 0; i < 30; i++) {
      const c = (lo + hi) / 2;
      if (reachOf(stancePose(W, c, po, f), S, t, keys) > target) lo = c; else hi = c;
    }
    return stancePose(W, (lo + hi) / 2, po, f);
  }
  function blendPose(a: BodyPose, b: BodyPose, u: number): BodyPose { return { A: lerp2(a.A, b.A, u), p: lerp(a.p, b.p, u), face: lerp(a.face, b.face, u) }; }

  type BodyFn = (t: number) => BodyPose;
  type PlantSeg = { t0: number; t1: number; type: "plant"; an: Anchor };
  type FkSeg = { t0: number; t1: number; type: "fk"; pose: (t: number) => Segments; inMs: number; outMs: number; prev: Anchor | null; next: Anchor };
  type StepSeg = { t0: number; t1: number; type: "step"; from: Anchor; to: Anchor; lift: number };
  type LegSeg = PlantSeg | FkSeg | StepSeg;
  type KeyName = "neck" | "head" | "ears" | "tail";

  const BODY: Array<{ t0: number; t1: number; fn: BodyFn }> = [];
  const LEGS: Record<GoatShowLegKey, LegSeg[]> = { fn: [], ff: [], hn: [], hf: [] };
  const KEYS: Record<KeyName, Array<[number, number]>> = { neck: [], head: [], ears: [], tail: [] };
  function key(name: KeyName, t: number, v: number) { KEYS[name].push([t, v]); }
  function body(t0: number, t1: number, fn: BodyFn) { BODY.push({ t0, t1, fn }); }
  function poseAt(t: number): BodyPose {
    for (let i = 0; i < BODY.length; i++) if (t < BODY[i].t1 || i === BODY.length - 1) return BODY[i].fn(Math.max(t, BODY[i].t0));
    throw new Error("goat show: no body segment");
  }
  function plant(k: GoatShowLegKey, an: Anchor, t0: number) { LEGS[k].push({ t0, t1: Infinity, type: "plant", an }); }
  function free(k: GoatShowLegKey, t0: number, t1: number, poseFn: (t: number) => Segments, inMs: number, outMs: number, next: Anchor) {
    const L = LEGS[k], prev = L.length ? L[L.length - 1] : null;
    if (prev) prev.t1 = t0;
    L.push({ t0, t1, type: "fk", pose: poseFn, inMs, outMs, prev: prev && prev.type === "plant" ? prev.an : null, next });
    if (next) plant(k, next, t1);
  }

  // The drawn legs are almost straight at rest, so the goat stands a touch lower while it performs.
  const BASEC = track([[0, 0], [300, 2.5], [8400, 2.5], [8850, 0]]);
  function live(S: Stance, cT: (t: number) => number, poT: (t: number) => number, f: number, follow?: number): BodyFn {
    return (t) => stancePose(anchorsWorld(S, t), cT(t) + BASEC(t), poT(t), f, follow);
  }

  type HopOptions = {
    from: Stance; to: Stance; face?: number; faceTo?: number; pre?: BodyFn; c0?: number; po0?: number;
    tC: number; tLF: number; tLH: number; tDF: number; tDH: number; tS: number;
    h: number; crouch: number; rear: number; dive: number; absorb: number;
  };
  // A bound from one set of footholds to another: crouch, front lifts, hind push, flight, front lands, hind lands, absorb.
  function hop(o: HopOptions) {
    const f = o.face || 1, f2 = o.faceTo || f;
    const P1 = solveExt(o.from, o.tLH, o.rear, f, ["hn", "hf"], .975);
    const P2 = solveExt(o.to, o.tDF, o.dive, f2, ["fn", "ff"], .965);
    const ta = o.tLH + .15 * (o.tDF - o.tLH), tb = o.tDF - 100; // a twisting leap turns while all four hooves are up
    const crouchT = track([[o.tC, o.c0 || 0], [o.tLF, o.crouch]]);
    const liveFrom = live(o.from, crouchT, track([[o.tC, o.po0 || 0], [o.tLF, o.rear * .4]]), f);
    const pre = o.pre;
    body(o.tC, o.tLF, !pre ? liveFrom : (t) => {
      const p = liveFrom(t); return t < o.tC + 120 ? blendPose(pre(t), p, eio((t - o.tC) / 120)) : p;
    });
    body(o.tLF, o.tLH, (t) => blendPose(liveFrom(o.tLF), P1, eout((t - o.tLF) / (o.tLH - o.tLF))));
    body(o.tLH, o.tDF, (t) => {
      const u = (t - o.tLH) / (o.tDF - o.tLH), A = lerp2(P1.A, P2.A, u);
      const fc = f === f2 || t < ta ? f : t > tb ? f2 : lerp(f, f2, eio((t - ta) / (tb - ta)));
      return { A: [A[0], A[1] - 4 * o.h * u * (1 - u)], p: lerp(P1.p, P2.p, eio(u)), face: fc };
    });
    const cAbs = track([[o.tDH, 0], [o.tDH + 90, o.absorb], [o.tS, 0]]);
    const poAbs = track([[o.tDH, 0], [o.tDH + 110, -1.5], [o.tS, 0]]);
    const liveTo = live(o.to, cAbs, poAbs, f2);
    body(o.tDF, o.tDH, (t) => blendPose(P2, liveTo(o.tDH), eio((t - o.tDF) / (o.tDH - o.tDF))));
    body(o.tDH, o.tS, liveTo);
    const air = o.tDF - o.tLF;
    (["fn", "ff"] as const).forEach((k) => {
      const lag = k === "ff" ? 25 : 0;
      free(k, o.tLF + lag, o.tDF, (t) => {
        const u = (t - o.tLF) / air;
        const s = u < .45 ? lerpS(POSE.tuckF, POSE.tuckF, 1) : lerpS(POSE.tuckF, POSE.reachF, eio((u - .45) / .55));
        return far(s, k);
      }, 70, 90, o.to[k]);
    });
    const airH = o.tDH - o.tLH;
    (["hn", "hf"] as const).forEach((k) => {
      const lag = k === "hf" ? 12 : 0;
      free(k, o.tLH + lag, o.tDH, (t) => {
        const u = (t - o.tLH) / airH;
        const s = u < .3 ? lerpS(POSE.trailH, POSE.tuckH, eio(u / .3)) : u < .6 ? POSE.tuckH : lerpS(POSE.tuckH, POSE.reachH, eio((u - .6) / .4));
        return far(s, k);
      }, 40, 90, o.to[k]);
    });
    // head, ears and tail answer every bound
    key("neck", o.tLF - 40, -5); key("neck", (o.tLH + o.tDF) / 2, 5); key("neck", o.tDH + 60, -7); key("neck", o.tS, 0);
    key("head", o.tLF - 40, -4); key("head", (o.tLH + o.tDF) / 2, 4); key("head", o.tDH + 60, -5); key("head", o.tS, 0);
    key("ears", o.tLF, 6); key("ears", (o.tLH + o.tDF) / 2, 16); key("ears", o.tDH + 40, -8); key("ears", o.tS, 0);
    key("tail", o.tLH, -16); key("tail", o.tDF, -6); key("tail", o.tDH + 70, 8); key("tail", o.tS, 0);
    return { P1, P2, end: o.tS };
  }

  type HopTurnOptions = { from: Stance; to: Stance; f0: number; f1: number; c0?: number; tC: number; tL: number; tD: number; tS: number; h: number; crouch: number; absorb: number };
  // Turn around with a small hop in place: crouch, all four hooves leave together, turn in the air, land.
  function hopTurn(o: HopTurnOptions) {
    const cT = track([[o.tC, o.c0 || 0], [o.tL, o.crouch]]);
    const stand = live(o.from, cT, () => 0, o.f0);
    body(o.tC, o.tL, stand);
    const P1 = solveExt(o.from, o.tL + 40, 0, o.f0, LEG_KEYS, .975), P2 = solveExt(o.to, o.tD, 0, o.f1, LEG_KEYS, .965);
    body(o.tL, o.tL + 40, (t) => blendPose(stand(o.tL), P1, eout((t - o.tL) / 40)));
    const a = o.tL + 60, b = o.tD - 60;
    body(o.tL + 40, o.tD, (t) => {
      const u = (t - o.tL - 40) / (o.tD - o.tL - 40), A = lerp2(P1.A, P2.A, u);
      const fc = t < a ? o.f0 : t > b ? o.f1 : lerp(o.f0, o.f1, eio((t - a) / (b - a)));
      return { A: [A[0], A[1] - 4 * o.h * u * (1 - u)], p: lerp(P1.p, P2.p, u), face: fc };
    });
    const cA = track([[o.tD, 0], [o.tD + 90, o.absorb], [o.tS, 0]]);
    const land = live(o.to, cA, () => 0, o.f1);
    body(o.tD, o.tD + 60, (t) => blendPose(P2, land(o.tD + 60), eio((t - o.tD) / 60)));
    body(o.tD + 60, o.tS, land);
    LEG_KEYS.forEach((k) => {
      free(k, o.tL + (LEG[k].front ? 0 : 25), o.tD, () => far(LEG[k].front ? POSE.pronkF : POSE.pronkH, k), 40, 55, o.to[k]);
    });
    key("neck", o.tL - 30, -4); key("neck", (o.tL + o.tD) / 2, 4); key("neck", o.tD + 50, -5); key("neck", o.tS, 0);
    key("head", o.tL - 30, -3); key("head", (o.tL + o.tD) / 2, 3); key("head", o.tD + 50, -3); key("head", o.tS, 0);
    key("ears", (o.tL + o.tD) / 2, 12); key("ears", o.tD + 50, -6); key("ears", o.tS, 0);
    key("tail", o.tL, -12); key("tail", o.tD + 60, 6); key("tail", o.tS, 0);
    return { end: o.tS };
  }
  function replant(k: GoatShowLegKey, an: Anchor, t: number) { const L = LEGS[k]; L[L.length - 1].t1 = t; plant(k, an, t); }

  function step(k: GoatShowLegKey, t0: number, t1: number, to: Anchor, lift: number) {
    const L = LEGS[k], prev = L[L.length - 1] as PlantSeg;
    prev.t1 = t0;
    L.push({ t0, t1, type: "step", from: prev.an, to, lift });
    plant(k, to, t1);
  }
  // A foothold on the word's top, nudged off gaps and steep flanks.
  function footOnTop(x: number, dirX: number) {
    for (let d = 0; d <= 30; d++) {
      const c = d <= 12 ? [x + dirX * d, x - dirX * d] : [x + dirX * d]; // prefer the direction of travel
      for (let j = 0; j < c.length; j++) { const an = onTop(c[j]); if (isFinite(an.p[1]) && an.p[1] < -74 && Math.abs(an.a) < 30) return an; }
    }
    return onTop(x);
  }
  type TrotOptions = {
    from: Stance; face?: number; t0: number; t1: number; s0: number; s1: number; T: number; duty: number; lift: number; low?: number;
    phase: Record<GoatShowLegKey, number>;
  };
  // Trot up the word's top (diagonal pairs, at least two hooves down at all times). The body rides a smooth
  // line over the letter tops; every hoof is planted under its hip at mid-stance and swung by IK between holds.
  function trot(o: TrotOptions) {
    const S = track([[o.t0, o.s0], [o.t0 + 160, o.s0 + (o.s1 - o.s0) * .06], [o.t1 - 120, o.s1 - (o.s1 - o.s0) * .05], [o.t1, o.s1]]);
    const f = o.face || 1, dirX = o.s1 < o.s0 ? -1 : 1;
    const OFF: Record<GoatShowLegKey, number> = { fn: -26.5 * f, ff: -16.5 * f, hf: 16.5 * f, hn: 26.5 * f }, Y = -79.2;
    function walkPose(t: number) {
      const s = S(t), W = {} as Record<GoatShowLegKey, Vec>, u = (t - o.t0) / o.T;
      LEG_KEYS.forEach((k) => { W[k] = tripsToWorld([s + OFF[k], Y], t); });
      return stancePose(W, BASEC(t) + (o.low || 0) + 1.2 * Math.pow(Math.sin(2 * Math.PI * u), 2), 0, f);
    }
    const prevPose = live(o.from, () => 0, () => 0, f);
    body(o.t0, o.t1, (t) => {
      const p = walkPose(t); return t < o.t0 + 160 ? blendPose(prevPose(t), p, eio((t - o.t0) / 160)) : p;
    });
    const last = {} as Stance;
    LEG_KEYS.forEach((k) => {
      let cur = o.from[k];
      for (let n = 0; n < 40; n++) {
        const st0 = o.t0 + (n + o.phase[k]) * o.T, sw0 = st0 - (1 - o.duty) * o.T;
        if (sw0 < o.t0 + 20) continue;
        if (sw0 >= o.t1 - 40) break;
        const land = Math.min(st0, o.t1), tm = clamp(st0 + o.duty * o.T / 2, o.t0, o.t1);
        const an = footOnTop(S(tm) + OFF[k], dirX);
        step(k, Math.max(sw0, o.t0), land, an, o.lift);
        cur = an;
      }
      last[k] = cur;
    });
    return { end: o.t1, anchors: last, pose: walkPose };
  }

  // ---------- footholds ----------
  const HOME_L: Stance = { fn: onGround(693.2), ff: onGround(703.2), hn: onGround(746.2), hf: onGround(736.2) };
  const ON_PS: Stance = { fn: onTop(502), ff: onTop(510), hf: onTop(556), hn: onTop(565) };
  const ON_TOP: Stance = { fn: onFace(-36), ff: onFace(-42), hf: onFace(-56), hn: onFace(-62) };
  LEG_KEYS.forEach((k) => { plant(k, HOME_L[k], 0); });

  // ---------- choreography ----------
  // 0.00 look up at the star, 0.65 gather
  const c0 = track([[0, 0], [650, 0], [900, 9]]), po0 = track([[0, 0], [400, 1.2], [650, 0], [900, 2]]);
  body(0, 650, live(HOME_L, c0, po0, 1));
  key("neck", 0, 0); key("neck", 260, 9); key("neck", 520, 10); key("neck", 650, 3);
  key("head", 0, 0); key("head", 260, 11); key("head", 520, 12); key("head", 650, 2);
  key("ears", 0, 0); key("ears", 180, -16); key("ears", 330, 5); key("ears", 460, -4); key("ears", 600, 0);
  key("tail", 0, 0); key("tail", 220, -14); key("tail", 360, 4); key("tail", 600, 0);

  // 0.65 leap onto the s (front hooves on the bowl of the p)
  hop({ from: HOME_L, to: ON_PS, tC: 650, tLF: 900, tLH: 975, tDF: 1330, tDH: 1395, tS: 1520, h: 22, crouch: 5, rear: 10, dive: -5, absorb: 5 });

  // 1.52 the word tips under it; it trots up the steepening tops toward the t
  const tr = trot({ from: ON_PS, t0: 1520, t1: 2620, s0: 533.25, s1: 361, T: 260, duty: .58, lift: 6, low: 4.5,
    phase: { fn: 0, hf: .04, ff: .55, hn: .59 } });
  for (let nt = 1600; nt < 2600; nt += 150) {
    const odd = ((nt - 1600) / 150) % 2;
    key("neck", nt, odd ? -2 : -7); key("head", nt, odd ? -1 : -4); key("ears", nt, odd ? 3 : -3); key("tail", nt, odd ? -6 : 2);
  }

  // 2.62 one bound up onto the end of the word as it stands up
  hop({ from: tr.anchors, pre: tr.pose, to: ON_TOP, c0: 4, tC: 2620, tLF: 2680, tLH: 2740, tDF: 2950, tDH: 3000, tS: 3010, h: 20, crouch: 5, rear: 9, dive: -4, absorb: 5 });

  // 3.01 perched on the column: ride the wobble, then lean out and boop the star
  const cPerch = track([[3010, 0], [3090, 5], [3230, 1.5], [3330, 0], [3620, 4], [3750, 4.5], [3900, 0], [4300, 0], [4500, 1.5], [5300, 1.5]]);
  const poPerch = track([[3010, 0], [3100, -2], [3220, 1.6], [3320, 0], [3620, -7], [3750, -8.5], [3880, 3], [4100, 0], [4300, 0]]);
  const perch = live(ON_TOP, cPerch, poPerch, 1);
  body(3010, 5300, perch);
  key("neck", 3080, -6); key("neck", 3230, 4); key("neck", 3360, -2); key("neck", 3500, -18); key("neck", 3680, -30);
  key("neck", 3750, -31); key("neck", 3830, -12); key("neck", 3990, 12); key("neck", 4200, 18); key("neck", 4420, 6);
  key("head", 3080, -4); key("head", 3230, 3); key("head", 3360, -1); key("head", 3500, -10); key("head", 3680, -20);
  key("head", 3750, -22); key("head", 3830, -4); key("head", 3990, 18); key("head", 4200, 22); key("head", 4420, 8);
  key("ears", 3060, -10); key("ears", 3200, 4); key("ears", 3500, -16); key("ears", 3760, 20); key("ears", 3900, -10); key("ears", 4100, 0);
  key("tail", 3070, -4); key("tail", 3600, -2); key("tail", 3770, -22); key("tail", 3900, 8); key("tail", 4050, -10); key("tail", 4250, 0);

  // 4.40 wearing the halo it weighs nothing: the column lowers it to the ground like a lift
  const GROUND_MID: Stance = { fn: onGround(441), ff: onGround(447), hf: onGround(461), hn: onGround(467) };
  const ON_P_L: Stance = { fn: onTop(441), ff: onTop(447), hf: onTop(461), hn: onTop(467) };
  const ON_P_R: Stance = { fn: onTop(467), ff: onTop(461), hf: onTop(447), hn: onTop(441) };
  const LIFT_AT = (() => { // the moment the rising p stem reaches the hooves
    let lo = SWAP, hi = 6050;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (SINK(m) > -ON_P_L.fn.p[1]) lo = m; else hi = m; }
    return (lo + hi) / 2;
  })();
  LEG_KEYS.forEach((k) => { replant(k, GROUND_MID[k], 5300); replant(k, ON_P_L[k], LIFT_AT); });
  const cMid = track([[5300, 1.5], [LIFT_AT, 1.5], [LIFT_AT + 70, 4], [LIFT_AT + 260, .5], [6250, .5], [6380, 2.5], [6600, .5], [6700, 0]]);
  const poMid = track([[5300, 0], [6180, 0], [6370, -7], [6450, -6], [6640, 0]]);
  body(5300, LIFT_AT, live(GROUND_MID, cMid, poMid, 1));
  body(LIFT_AT, 6700, live(ON_P_L, cMid, poMid, 1));
  key("neck", 4700, -6); key("neck", 5000, -10); key("neck", 5300, -4); key("neck", 5600, 6); key("neck", 5900, 2);
  key("neck", 6150, -8); key("neck", 6250, -18); key("neck", 6380, -34); key("neck", 6450, -30); key("neck", 6620, -6); key("neck", 6700, 0);
  key("head", 4700, -4); key("head", 5000, -8); key("head", 5300, -2); key("head", 5600, 4); key("head", 5900, 0);
  key("head", 6150, -6); key("head", 6250, -10); key("head", 6380, -24); key("head", 6450, -20); key("head", 6620, -2); key("head", 6700, 0);
  key("ears", 4500, -14); key("ears", 4800, 4); key("ears", 5200, -6); key("ears", 5500, 0); key("ears", 5800, -12);
  key("ears", 6050, 6); key("ears", 6200, 0); key("ears", 6390, -16); key("ears", 6560, 8); key("ears", 6700, 0);
  key("tail", 4600, -8); key("tail", 5000, 4); key("tail", 5300, 0); key("tail", 5850, -14); key("tail", 6100, 6); key("tail", 6300, 0);
  key("tail", 6560, -14); key("tail", 6680, 4);

  // 6.70 turn for home, trot down the tops to the s, and a twisting leap back into the lockup
  hopTurn({ from: ON_P_L, to: ON_P_R, f0: 1, f1: -1, tC: 6700, tL: 6820, tD: 7040, tS: 7160, h: 12, crouch: 4, absorb: 4 });
  const tr2 = trot({ from: ON_P_R, face: -1, t0: 7160, t1: 7760, s0: 454, s1: 545, T: 220, duty: .58, lift: 6, low: 5.5,
    phase: { fn: 0, hf: .04, ff: .55, hn: .59 } });
  for (let nt2 = 7240; nt2 < 7720; nt2 += 110) {
    const odd2 = ((nt2 - 7240) / 110) % 2;
    key("neck", nt2, odd2 ? -2 : -6); key("head", nt2, odd2 ? -1 : -4); key("ears", nt2, odd2 ? 3 : -3); key("tail", nt2, odd2 ? -6 : 2);
  }
  hop({ from: tr2.anchors, pre: tr2.pose, to: HOME_L, face: -1, faceTo: 1, c0: 5.5, tC: 7760, tLF: 7830, tLH: 7890,
    tDF: 8190, tDH: 8250, tS: 8420, h: 18, crouch: 5, rear: 8, dive: -5, absorb: 5 });
  const cEnd = track([[8420, 0], [8500, 1.5], [8750, 0]]);
  body(8420, 1e9, live(HOME_L, cEnd, () => 0, 1));
  key("neck", 8520, 3); key("neck", 8900, 0); key("head", 8520, 2); key("head", 8900, 0);
  key("ears", 8480, -8); key("ears", 8680, 4); key("ears", 8900, 0);
  key("tail", 8480, -16); key("tail", 8620, 8); key("tail", 8760, -4); key("tail", 8900, 0);

  const NECK = track(KEYS.neck), HEAD = track(KEYS.head), EARS = track(KEYS.ears), TAIL = track(KEYS.tail);

  function goatAt(t: number): GoatPose {
    const pose = poseAt(t);
    return Object.assign(pose, { neck: NECK(t), head: HEAD(t), ears: EARS(t), tail: TAIL(t) });
  }
  function legSeg(k: GoatShowLegKey, t: number) {
    const L = LEGS[k];
    for (let i = 0; i < L.length; i++) if (t < L[i].t1) return L[i];
    return L[L.length - 1];
  }
  function legS(k: GoatShowLegKey, pose: BodyPose, t: number): Segments {
    const sg = legSeg(k, t);
    if (sg.type === "plant") return ikAnchor(k, pose, sg.an, t).s;
    if (sg.type === "step") {
      const u = clamp((t - sg.t0) / (sg.t1 - sg.t0), 0, 1), b = Math.sin(Math.PI * u), ue = eio(u);
      const pl = add(lerp2(sg.from.p, sg.to.p, ue), mul(sg.to.n, sg.lift * b));
      const flex = LEG[k].front ? -38 * b : 26 * b;
      return ikAnchor(k, pose, { f: sg.to.f, p: pl, a: lerp(sg.from.a, sg.to.a, ue) + flex }, t).s;
    }
    let s = sg.pose(t);
    if (sg.prev && t - sg.t0 < sg.inMs) s = lerpS(ikAnchor(k, pose, sg.prev, t).s, s, eio((t - sg.t0) / sg.inMs));
    if (sg.next && sg.t1 - t < sg.outMs) s = lerpS(s, ikAnchor(k, pose, sg.next, t).s, eio(1 - (sg.t1 - t) / sg.outMs));
    return s;
  }

  // ---------- the star ----------
  const IDOT: Vec = [417.408, -105.264];
  const boopAt = 3750, popEnd = 4150, tossAt = 6400, tossEnd = 6720;
  let BOOP: Vec | null = null;
  function boopPoint(): Vec { if (!BOOP) BOOP = add(headToWorld(goatAt(boopAt), MUZZLE), [-6, -1]); return BOOP; }
  function haloAt(t: number) { const g = goatAt(t); return add(headToWorld(g, HALO), [0, 1.5 * Math.sin(t / 700)]); }
  const SX = track([[1400, IDOT[0]], [1750, 360], [2000, 318], [2550, 302], [3300, 300]]);
  const SY = track([[1400, IDOT[1]], [1750, -150], [2000, -180], [2550, -188], [2900, -182], [3300, -187]]);
  function arc(a: Vec, b: Vec, h: number, u: number): Vec { const p = lerp2(a, b, u); return [p[0], p[1] - 4 * h * u * (1 - u)]; }
  function starAt(t: number): GoatShowStar {
    if (t < 1400) {
      const tw = t > 300 && t < 760 ? Math.sin((t - 300) / 460 * Math.PI) : 0;
      return { p: IDOT, s: 1 + .28 * tw, r: 24 * tw };
    }
    if (t < 3300) {
      const bob = t > 2550 ? 3 * Math.sin((t - 2550) / 520 * Math.PI) : 0;
      return { p: [SX(t), SY(t) + bob], s: 1, r: 70 * eio((t - 1400) / 900) + (t > 2550 ? 8 * Math.sin((t - 2550) / 640 * Math.PI) : 0) };
    }
    if (t < boopAt) return { p: lerp2([SX(3300), SY(3300)], boopPoint(), eio((t - 3300) / (boopAt - 3300))), s: 1, r: 70 - 70 * eio((t - 3300) / 450) };
    if (t < popEnd) {
      const u = (t - boopAt) / (popEnd - boopAt), ue = eout(u);
      let p = arc(boopPoint(), haloAt(popEnd), 34, ue);
      p = lerp2(p, haloAt(t), eio((u - .7) / .3));
      return { p, s: lerp(1, .62, eio(u)) * (u < .15 ? 1 - .2 * Math.sin(u / .15 * Math.PI) : 1), r: 330 * ue };
    }
    if (t < tossAt) {
      const pulse = t > 4200 && t < 4720 ? Math.sin((t - 4200) / 520 * Math.PI) : 0;
      return { p: haloAt(t), s: .62 + .14 * pulse, r: 330 + 10 * Math.sin(t / 900) };
    }
    if (t < tossEnd) {
      const v = (t - tossAt) / (tossEnd - tossAt), ve = eio(v);
      return { p: arc(haloAt(tossAt), IDOT, 10, ve), s: lerp(.62, 1.22, ve), r: 330 + 10 * Math.sin(tossAt / 900) + 390 * eout(v) };
    }
    const w = clamp((t - tossEnd) / 420, 0, 1), rr = 330 + 10 * Math.sin(tossAt / 900) + 390;
    return { p: IDOT, s: 1.22 - .22 * eout(w), r: lerp(rr, 720, eout(w)) };
  }

  function letterBob(_i: number, _t: number) { return { dy: 0, r: 0 }; }

  // ---------- frame state ----------
  function frame(t: number): GoatShowState {
    t = clamp(t, 0, DUR);
    const g = goatAt(t), legs = {} as Record<GoatShowLegKey, Segments>;
    LEG_KEYS.forEach((k) => { legs[k] = segRot(k, legS(k, g, t)); });
    const th = TH(t), sink = SINK(t), moving = Math.min(1, Math.abs(th) / 1.5 + sink / 1.5);
    return {
      t, goat: g, legs, star: starAt(t),
      trips: { th, sink, notch: 50 * (1 - moving) },
      letters: [0, 1, 2, 3].map((i) => letterBob(i, t)),
    };
  }

  // ---------- markup ----------
  function rotAt(deg: number, pv: Vec) { return "rotate(" + r3(deg) + " " + pv[0] + " " + pv[1] + ")"; }
  function attrs(st: GoatShowState): GoatShowAttrs {
    const g = st.goat, a: GoatShowAttrs = {};
    a.root = "translate(" + r3(g.A[0]) + " " + r3(g.A[1]) + ") rotate(" + r3(g.p) + ") scale(" + r3(g.face) + " 1) translate(" + (-A_LOCAL[0]) + " 0)";
    a.tail = rotAt(g.tail, PV.tail); a.neck = rotAt(g.neck, PV.neck); a.head = rotAt(g.head, PV.head);
    a["ear-far"] = rotAt(g.ears, PV.ears); a["ear-near"] = rotAt(g.ears, PV.ears);
    LEG_KEYS.forEach((k) => {
      const L = LEG[k], r = st.legs[k];
      a[k + "-hip"] = rotAt(r[0], L.hip); a[k + "-knee"] = rotAt(r[1], L.knee); a[k + "-fet"] = rotAt(r[2], L.fet);
    });
    a.star = "translate(" + r3(st.star.p[0]) + " " + r3(st.star.p[1]) + ") rotate(" + r3(st.star.r) + ") scale(" + r3(st.star.s) + ")";
    a.trips = "translate(0 " + r3(st.trips.sink) + ") " + rotAt(st.trips.th, PIVOT);
    st.letters.forEach((b, i) => {
      const l = LETTERS[i];
      a["L" + i] = "translate(" + l.ox + " " + r3(b.dy) + ") rotate(" + r3(b.r) + " 36 0)";
    });
    return a;
  }
  function legMarkup(k: GoatShowLegKey, x: GoatShowAttrs) {
    const L = DATA.legs[k], sub = L.limb.match(/M[^M]*/g) ?? [], farLeg = k === "ff" || k === "hf";
    return (farLeg ? '<g opacity=".72">' : "<g>") +
      '<g data-part="' + k + '-hip" transform="' + x[k + "-hip"] + '"><path class="goat-fill" d="' + sub[0] + sub[3] + '"/>' +
      '<g data-part="' + k + '-knee" transform="' + x[k + "-knee"] + '"><path class="goat-fill" d="' + sub[1] + sub[4] + '"/>' +
      '<g data-part="' + k + '-fet" transform="' + x[k + "-fet"] + '"><path class="goat-fill" d="' + sub[2] + '"/>' +
      '<path class="goat-fill" d="' + L.hoof + '"/>' + (L.split || "") + "</g></g></g></g>";
  }
  // `clipId` is a product addition: the prototype derived it from `kind`, which
  // is only unique per page there. The product passes one id per instance.
  function svg(kind: string, st: GoatShowState, vb: string, extraAttr?: string, clipId?: string) {
    const x = attrs(st), h = DATA.head, id = clipId ?? "gclip-" + kind;
    const letters = LETTERS.map((l, i) => (
      i < 4 ? '<g data-part="L' + i + '" transform="' + x["L" + i] + '"><path d="' + l.d + '"/></g>'
        : '<g transform="translate(' + l.ox + ' 0)"><path d="' + l.d + '"/></g>'
    ));
    return '<svg class="wm ' + kind + '" viewBox="' + vb + '" ' + (extraAttr || "") + ' aria-hidden="true" focusable="false">' +
      '<defs><clipPath id="' + id + '" clipPathUnits="userSpaceOnUse"><rect x="-400" y="-2000" width="2000" height="2000"/>' +
      '<rect data-part="notch" x="436" y="-1" width="50" height="' + r3(st.trips.notch) + '"/></clipPath></defs>' +
      '<g fill="currentColor">' + letters.slice(0, 4).join("") +
        '<g clip-path="url(#' + id + ')"><g data-part="trips" transform="' + x.trips + '">' + letters.slice(4).join("") + "</g></g>" +
        '<g data-part="star" transform="' + x.star + '"><path d="' + DATA.star + '"/></g>' +
      "</g>" +
      '<g data-part="root" transform="' + x.root + '">' +
        '<g data-part="tail" transform="' + x.tail + '"><path class="goat-fill" d="' + DATA.tail + '"/></g>' +
        legMarkup("hf", x) + legMarkup("ff", x) +
        '<path class="goat-fill" d="' + DATA.body + '"/>' +
        legMarkup("hn", x) + legMarkup("fn", x) +
        '<g data-part="neck" transform="' + x.neck + '"><path class="goat-fill" d="' + DATA.neck + '"/>' +
          '<g data-part="head" transform="' + x.head + '">' + h.hornFar + '<g data-part="ear-far" transform="' + x["ear-far"] + '">' + h.earFar + "</g>" +
            h.skull + h.muzzle + h.frontMuzzle + h.beard + h.hornNear +
            '<g data-part="ear-near" transform="' + x["ear-near"] + '">' + h.earNear + "</g>" + h.eyeNear + h.eyeFar + h.nostril +
          "</g>" +
        "</g>" +
      "</g></svg>";
  }

  return { frame, attrs, svg };
}

let engine: Engine | null = null;
function getEngine() {
  if (!engine) engine = createGoatShow();
  return engine;
}

/** The pose of every part at `t` ms (clamped to 0..DUR). */
export function frame(t: number): GoatShowState { return getEngine().frame(t); }
/** The `transform` attribute of every `[data-part]` element for a frame state. */
export function attrs(st: GoatShowState): GoatShowAttrs { return getEngine().attrs(st); }
/** The complete overlay SVG markup for a frame state, built once per mount. */
export function svg(kind: string, st: GoatShowState, vb: string, extraAttr?: string, clipId?: string): string {
  return getEngine().svg(kind, st, vb, extraAttr, clipId);
}
