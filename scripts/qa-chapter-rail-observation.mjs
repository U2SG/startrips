/** Grade a left-to-right rail by containment, not a font-dependent scroll count. */
export function gradeChapterRailReveal({ railWidth, scrollLeft, activeLeft, activeRight }) {
  const valid = [railWidth, scrollLeft, activeLeft, activeRight].every(Number.isFinite)
    && railWidth > 0 && scrollLeft >= 0 && activeRight > activeLeft;
  if (!valid) return { failed: true, requiresScroll: null, visible: false };
  const tolerance = 2;
  const unscrolledRight = activeRight + scrollLeft;
  const requiresScroll = unscrolledRight > railWidth + tolerance;
  const visible = activeLeft >= -tolerance && activeRight <= railWidth + tolerance;
  return { failed: !visible || (requiresScroll && scrollLeft <= 0), requiresScroll, visible };
}
