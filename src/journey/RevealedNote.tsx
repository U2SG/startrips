import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import "../styles/revealed-note.css";

/** Per-character stagger, capped so a long note never takes long to settle. */
const CHARACTER_STAGGER_MS = 34;
const REVEAL_SPAN_MAX_MS = 1600;
const CHARACTER_ENTER_MS = 520;

function characters(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function revealDelayMs(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.min(index * CHARACTER_STAGGER_MS, (REVEAL_SPAN_MAX_MS * index) / (count - 1)));
}

/**
 * #393: a note that enters over a picture one character at a time.
 *
 * Every character is laid out from the first frame and only its opacity and a
 * small lift animate, so the line length, the picture and the page height
 * never move while the note arrives. Once settled — by time, by `settled`, or
 * by a click — it renders as plain text, so a copy of the page (PageFlip
 * clones the turning page in portrait) does not replay it. Reduced Motion
 * shows the complete note at once. Assistive technology reads the whole
 * sentence, never the individual characters.
 */
export function RevealedNote({ text, settled = false, className, collapsible = true }: {
  text: string;
  /** Finish immediately, e.g. when the reader turns the page. */
  settled?: boolean;
  className?: string;
  collapsible?: boolean;
}) {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [done, setDone] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const parts = useMemo(() => characters(text), [text]);
  const complete = done || settled || reduced;

  useEffect(() => onMotionPreferenceChange(setReduced), []);
  // Once settled, a note stays settled: it never re-enters on the same page.
  useEffect(() => {
    if (settled) setDone(true);
  }, [settled]);
  useEffect(() => {
    if (complete) return;
    const total = revealDelayMs(parts.length - 1, parts.length) + CHARACTER_ENTER_MS;
    const timer = window.setTimeout(() => setDone(true), total);
    return () => window.clearTimeout(timer);
  }, [complete, parts.length]);

  return (
    <div
      className={`revealed-note${collapsed ? " is-collapsed" : ""}${className ? ` ${className}` : ""}`}
      data-revealed-note={complete ? "settled" : "entering"}
    >
      <p className="revealed-note__text" onClick={() => setDone(true)}>
        {complete ? text : <>
          <span className="revealed-note__sr">{text}</span>
          <span aria-hidden="true">
            {parts.map((part, index) => (
              <span
                key={index}
                className="revealed-note__char"
                style={{ "--reveal-delay": `${revealDelayMs(index, parts.length)}ms` } as CSSProperties}
              >{part}</span>
            ))}
          </span>
        </>}
      </p>
      {collapsible ? (
        <button
          type="button"
          className="revealed-note__toggle"
          aria-pressed={collapsed}
          onClick={() => { setDone(true); setCollapsed((value) => !value); }}
        >{collapsed ? "显示感想" : "收起感想"}</button>
      ) : null}
    </div>
  );
}
