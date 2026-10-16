import { useLayoutEffect, type RefObject } from "react";
import { observeScrollEdges } from "./scrollEdges";
import "../styles/scroll-edges.css";

export function useScrollEdges(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    return observeScrollEdges(element);
  }, [ref, enabled]);
}
