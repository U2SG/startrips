import { useEffect, useRef, useState, type PointerEvent, type RefObject, type TouchEvent } from "react";

/**
 * Two-detent Journey detail sheet shared by Web Mobile V2 and the iPhone
 * scene (Apple Maps style). Medium is the original half-height sheet with the
 * globe and route still visible; large leaves a thin globe strip and is the
 * only state whose content scrolls. Swiping down steps large → medium → close.
 */
export type MobileSheetDetent = "medium" | "large";
export type MobileSheetMove = MobileSheetDetent | "close" | null;

export const MOBILE_SHEET_EXPAND_DISTANCE = 48;
export const MOBILE_SHEET_DISMISS_DISTANCE = 64;

const GRAB_REGION = ".mobile-v2__sheet-handle, .mobile-v2__sheet-heading";

/** A vertical swipe of `deltaY` px (positive = down) ending on the sheet. */
export function resolveMobileSheetSwipe(detent: MobileSheetDetent, deltaY: number, contentAtTop: boolean): MobileSheetMove {
  if (deltaY <= -MOBILE_SHEET_EXPAND_DISTANCE) return detent === "medium" ? "large" : null;
  if (deltaY > MOBILE_SHEET_DISMISS_DISTANCE) {
    if (detent === "medium") return "close";
    // In large, a downward swipe inside scrolled content is a scroll, not a collapse.
    return contentAtTop ? "medium" : null;
  }
  return null;
}

/** Tapping the handle (or Escape-free collapse) steps one detent down. */
export function stepDownMobileSheet(detent: MobileSheetDetent): Exclude<MobileSheetMove, null> {
  return detent === "large" ? "medium" : "close";
}

export function useMobileSheetDetents(sheet: RefObject<HTMLElement | null>, onClose: () => void, resetKey: unknown) {
  const [detent, setDetent] = useState<MobileSheetDetent>("medium");
  const start = useRef<{ y: number; atTop: boolean } | null>(null);
  const moved = useRef(false);

  // Every newly opened (or retargeted) sheet starts at medium.
  useEffect(() => { setDetent("medium"); }, [resetKey]);
  // Medium never scrolls; collapsing must show the sheet's top again.
  useEffect(() => {
    if (detent === "medium" && sheet.current) sheet.current.scrollTop = 0;
  }, [detent, sheet]);

  const apply = (move: MobileSheetMove) => {
    if (move === "close") onClose();
    else if (move) setDetent(move);
  };
  const begin = (y: number, target: EventTarget | null) => {
    const grabbed = target instanceof Element && target.closest(GRAB_REGION) !== null;
    start.current = { y, atTop: grabbed || (sheet.current?.scrollTop ?? 0) <= 0 };
    moved.current = false;
  };
  const finish = (y: number) => {
    const origin = start.current;
    start.current = null;
    if (!origin) return;
    const move = resolveMobileSheetSwipe(detent, y - origin.y, origin.atTop);
    if (move) { moved.current = true; apply(move); }
  };

  /** Spread on the sheet `<section>`: touch swipes anywhere, mouse/pen drags on the grab region. */
  const sheetProps = {
    "data-detent": detent,
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      if (event.touches.length !== 1) { start.current = null; return; }
      begin(event.touches[0].clientY, event.target);
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      if (event.touches.length !== 0 || event.changedTouches.length !== 1) { start.current = null; return; }
      finish(event.changedTouches[0].clientY);
    },
    onTouchCancel: () => { start.current = null; },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch" || !event.isPrimary) return;
      if (!(event.target instanceof Element) || !event.target.closest(GRAB_REGION)) return;
      begin(event.clientY, event.target);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      finish(event.clientY);
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") start.current = null;
    },
  };

  /** Handle tap: one detent down, but not right after a drag that already moved the sheet. */
  const onHandleClick = () => {
    if (moved.current) { moved.current = false; return; }
    apply(stepDownMobileSheet(detent));
  };
  const toggle = () => setDetent(detent === "large" ? "medium" : "large");

  return { detent, sheetProps, onHandleClick, toggle };
}

/**
 * The grabber plus a screen-reader / keyboard toggle, so expanding and
 * collapsing never depend on a gesture alone.
 */
export function MobileSheetGrabber({ detent, onHandleClick, toggle }: {
  detent: MobileSheetDetent;
  onHandleClick: () => void;
  toggle: () => void;
}) {
  const large = detent === "large";
  return <>
    <button className="mobile-v2__sheet-handle" type="button"
      aria-label={large ? "向下滑动或点击收起旅程详情" : "向下滑动或点击关闭旅程详情"}
      onClick={onHandleClick}><span aria-hidden="true" /></button>
    <button className="mobile-v2__sheet-detent-toggle" type="button"
      aria-expanded={large} onClick={toggle}>{large ? "收起旅程详情" : "展开旅程详情"}</button>
  </>;
}
