// #482: the mixed-aspect aperture gate used to require the requestAnimationFrame
// sampler to observe every role transition (`aperture.boundaries < 12`). CI
// scheduling jitter can skip the exact frame a transition lands on, so that count
// is a proxy for "the seam happened", not evidence of it. These helpers grade the
// same property from the settled identity each navigation actually reached, which
// the QA lane already awaits per transition. Sampling still owns jump detection.

export function apertureSeamId(step, from, to) {
  return `${step}:${from}->${to}`;
}

// A seam per consecutive pair of the media indices the navigation plan visits.
export function expectedApertureSeams(visited) {
  return visited.slice(1).map((to, index) => apertureSeamId(index + 1, visited[index], to));
}

// Each seam records the jump count observed when it settled, so the jumps the
// sampler pushed between two settlements belong to the seam that closed the
// window. Attribution happens here rather than in the sampler so the in-page
// threshold expression stays untouched. A seam whose watermark could not be read
// leaves its window unattributed; every raw jump still appears exactly once.
export function attributeApertureJumps(seams, jumps) {
  const attributed = [];
  let cursor = 0;
  for (const { seam, jumpWatermark } of seams) {
    if (typeof jumpWatermark !== "number") continue;
    for (; cursor < jumpWatermark && cursor < jumps.length; cursor += 1) attributed.push({ seam, ...jumps[cursor] });
  }
  for (; cursor < jumps.length; cursor += 1) attributed.push({ seam: null, ...jumps[cursor] });
  return attributed;
}

// A seam that was never reached fails, and is named. A real jump fails and keeps
// its seam id next to its delta/elapsed evidence. Sample density does not enter
// the verdict: a sparsely sampled run whose seams all settled and whose clip-path
// deltas stayed continuous is a pass.
export function gradeApertureContinuity({ expectedSeams, reachedSeams, jumps }) {
  const reached = new Set(reachedSeams);
  const expected = new Set(expectedSeams);
  const unreachedSeams = expectedSeams.filter((seam) => !reached.has(seam));
  // Diagnostic only: a settled seam outside the plan means the run navigated
  // somewhere else, which already shows up as its planned seam being unreached.
  const unexpectedSeams = reachedSeams.filter((seam) => !expected.has(seam));
  return {
    expectedSeams,
    reachedSeams,
    unreachedSeams,
    unexpectedSeams,
    jumps,
    failed: unreachedSeams.length > 0 || jumps.length > 0,
  };
}
