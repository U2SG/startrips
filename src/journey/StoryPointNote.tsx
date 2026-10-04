import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "../styles/story-point-note.css";

type Props = {
  /** The Route Point that owns the note. The block is keyed by it. */
  routePointId: string;
  /** Where the note sits: "Stop · child" for a grouped Route Point. */
  label: string;
  text: string;
};

/**
 * #595: a Route Point's note above the media that Route Point owns.
 *
 * The block is bounded by rendered height (a CSS line clamp), never by cutting
 * the text: the full note is always in the DOM. When the clamp hides part of
 * it, "展开全文" opens a sheet OVER the stage instead of growing the block, so
 * expanding and collapsing never move the stage, never reload or seek its
 * media, and never take a swipe from it. Both the block and the sheet live
 * outside the stage's pointer surface, so neither can start a stage swipe or
 * reach the stage's backdrop close.
 */
export function StoryPointNote({ routePointId, label, text }: Props) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const returnFocus = useRef(false);
  const sheetId = useId();

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (!expanded) return;
    // Escape closes the sheet before anything else hears it. Story's modal
    // focus owner listens on the document in the capture phase; the window
    // capture phase runs first, so the sheet - the top layer - wins.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      returnFocus.current = true;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  useEffect(() => {
    if (expanded) {
      closeRef.current?.focus({ preventScroll: true });
      return;
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      expandRef.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  const collapse = () => {
    returnFocus.current = true;
    setExpanded(false);
  };

  // Story's own media buttons complete a touch on pointerup, because inside
  // the Story sheet a finger's compatibility click is not guaranteed to arrive
  // (`mediaButtonInput` in JourneyStory). These two buttons follow the same
  // rule, and swallow the click that may still follow so it cannot act twice.
  const touchClickAt = useRef(0);
  const touchActivation = (activate: () => void) => ({
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      touchClickAt.current = performance.now();
      activate();
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail > 0 && performance.now() - touchClickAt.current < 1_000) {
        touchClickAt.current = 0;
        return;
      }
      activate();
    },
  });

  return (
    <>
      <section
        className="story-point-note"
        data-story-point-note={routePointId}
        data-story-point-note-clamped={clamped ? "true" : "false"}
        aria-label={label ? `${label} 的感想` : "途径点感想"}
      >
        <p ref={textRef} className="story-point-note__text">{text}</p>
        {clamped || expanded ? (
          <button
            ref={expandRef}
            type="button"
            className="story-point-note__expand"
            aria-expanded={expanded}
            aria-controls={sheetId}
            {...touchActivation(() => setExpanded(true))}
          >展开全文</button>
        ) : null}
      </section>
      {expanded ? (
        <div
          id={sheetId}
          className="story-point-note-sheet"
          role="dialog"
          aria-label={label ? `${label} 的完整感想` : "完整感想"}
          data-story-point-note-sheet={routePointId}
        >
          {label ? <p className="story-point-note-sheet__label">{label}</p> : null}
          <div className="story-point-note-sheet__body">
            <p className="story-point-note-sheet__text">{text}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="story-point-note-sheet__close"
            {...touchActivation(collapse)}
          >收起</button>
        </div>
      ) : null}
    </>
  );
}
