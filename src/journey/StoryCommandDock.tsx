import { IconCommand } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { useKeyboardInset } from "./useKeyboardInset";

/**
 * The Story's own bottom dock on compact mobile. The Story is portaled over
 * the Atlas (#356), so the Atlas dock is underneath it; this one holds the
 * same one-sentence field at the bottom of the Story layer.
 *
 * The photo-first classic view gives the picture the whole sheet, so there
 * the dock folds into a pill that opens the field on tap and folds again once
 * the field is left with nothing in it.
 */
export function StoryCommandDock({ pill, children }: { pill: boolean; children: ReactNode }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  useKeyboardInset(element);

  useEffect(() => {
    if (!pill) setExpanded(false);
  }, [pill]);

  const folded = pill && !expanded;

  useEffect(() => {
    if (!expanded || !element) return;
    element.querySelector<HTMLInputElement>(".command-bar__input")?.focus({ preventScroll: true });
  }, [element, expanded]);

  // A press outside folds an idle pill. The field's own outside-press rule
  // puts its card away first, so the check waits a frame for that commit.
  useEffect(() => {
    if (!pill || !expanded || !element) return;
    let frame = 0;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!element.querySelector('[data-command-active="true"]')) setExpanded(false);
      });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.cancelAnimationFrame(frame);
    };
  }, [element, expanded, pill]);

  return (
    <div
      ref={setElement}
      className="story-command-dock"
      data-story-command-dock={folded ? "pill" : "bar"}
      // A sibling of the Story dialog: its Tab redirect leaves this alone.
      data-focus-trap-exempt="true"
    >
      {folded ? (
        <button
          type="button"
          className="story-command-dock__pill"
          aria-label="展开一句话操作"
          aria-expanded="false"
          onClick={() => setExpanded(true)}
        >
          <IconCommand size={16} stroke={1.35} aria-hidden="true" />
          一句话
        </button>
      ) : children}
    </div>
  );
}
