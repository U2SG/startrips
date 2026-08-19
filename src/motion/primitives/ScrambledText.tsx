import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../preferences";

const SCRAMBLE_CHARS = (
  "アイウエオカキクケコサシスセソタチツテト"
  + "ナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"
  + "!<>-_\\/[]{}—=+*^?#"
);

type ScrambledTextProps = {
  text: string;
  duration?: number;
  className?: string;
  as?: "span" | "h2" | "h3" | "p";
};

/**
 * ML-12 Scrambled Reveal.
 *
 * Scrambles a short heading with kana/symbol noise and settles left to
 * right into the final text. Runs once per `text` change; reduced-motion
 * users get the plain text immediately. The rendered node is a plain span
 * (or the requested tag) so surrounding typography styles keep applying.
 */
export function ScrambledText({
  text,
  duration = 560,
  className,
  as: Tag = "span",
}: ScrambledTextProps) {
  const [display, setDisplay] = useState(text);
  const latestText = useRef(text);
  latestText.current = text;

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(text);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const resolved = Math.floor(progress * text.length);
      if (resolved >= text.length) {
        setDisplay(text);
        return;
      }
      let next = "";
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === " ") {
          next += " ";
        } else if (index < resolved) {
          next += char;
        } else {
          next += SCRAMBLE_CHARS[
            Math.floor(Math.random() * SCRAMBLE_CHARS.length)
          ];
        }
      }
      setDisplay(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, text]);

  return <Tag className={className}>{display}</Tag>;
}
