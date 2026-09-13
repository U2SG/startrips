import { useEffect, useRef, type CSSProperties } from "react";
import { getStartripsSignatureClip, type StartripsSignatureClipName, type StartripsSignaturePose } from "./startripsSignatureTimeline";
import { createStartripsSignatureRuntime } from "./startripsSignatureRuntime";

const WORDMARK_ASSET = "/brand/startrips-v12-wordmark.svg";
const VIEWBOX = "0 -125 780 176";
const LISTENER_COUNT = 4;

function getStartripsSignatureDuration(clip: StartripsSignatureClipName) {
  return getStartripsSignatureClip(clip).durationMs;
}

function useHref(id: string) {
  return `${WORDMARK_ASSET}#${id}`;
}

function transform(target: Element | null, value: string) {
  if (target) target.setAttribute("transform", value);
}

function applyPose(root: HTMLElement, pose: StartripsSignaturePose) {
  transform(root.querySelector('[data-signature-part="goat-root"]'), `translate(${pose.rootX.toFixed(3)} ${pose.rootY.toFixed(3)})`);
  transform(root.querySelector('[data-signature-part="body"]'), `translate(0 ${pose.bodyY.toFixed(3)})`);
  transform(root.querySelector('[data-signature-part="head"]'), `rotate(${pose.headRotateDeg.toFixed(3)} 682 -88)`);
  transform(root.querySelector('[data-signature-part="eye"]'), `translate(${pose.eyeX.toFixed(3)} ${pose.eyeY.toFixed(3)})`);
  transform(root.querySelector('[data-signature-part="star"]'), `translate(${pose.starX.toFixed(3)} ${pose.starY.toFixed(3)}) scale(${pose.starScale.toFixed(4)})`);
  transform(root.querySelector('[data-signature-part="leg-fn"]'), `translate(0 ${pose.legFnY.toFixed(3)}) rotate(${pose.legFnRotateDeg.toFixed(3)} 696 -35)`);
  transform(root.querySelector('[data-signature-part="leg-ff"]'), `translate(0 ${pose.legFfY.toFixed(3)}) rotate(${pose.legFfRotateDeg.toFixed(3)} 702 -35)`);
  transform(root.querySelector('[data-signature-part="leg-hn"]'), `translate(0 ${pose.legHnY.toFixed(3)}) rotate(${pose.legHnRotateDeg.toFixed(3)} 746 -34)`);
  transform(root.querySelector('[data-signature-part="leg-hf"]'), `translate(0 ${pose.legHfY.toFixed(3)}) rotate(${pose.legHfRotateDeg.toFixed(3)} 741 -34)`);
}

export function StartripsSignatureMotion({
  clip = "loading",
  size = 52,
  className = "",
  title = "Startrips",
}: {
  clip?: StartripsSignatureClipName;
  size?: number;
  className?: string;
  title?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inViewport = true;
    let visible = !document.hidden;

    const runtime = createStartripsSignatureRuntime({
      clip,
      reduced: media.matches,
      scheduler: {
        now: () => performance.now(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
      },
      onPose: (pose) => applyPose(root, pose),
      onState: (state) => {
        root.dataset.signatureStatus = state.status;
        root.dataset.signatureDriverCount = String(state.driverCount);
        root.dataset.signatureListenerCount = String(LISTENER_COUNT);
        root.dataset.signatureCycle = String(state.cycle);
        root.dataset.signatureElapsedMs = state.elapsedMs.toFixed(1);
        root.dataset.signatureClipDurationMs = String(getStartripsSignatureDuration(clip));
      },
    });

    const syncSuspension = () => runtime.setSuspended(!visible || !inViewport);
    const interrupt = () => runtime.interrupt();
    const visibility = () => {
      visible = !document.hidden;
      syncSuspension();
    };
    const reduced = () => runtime.setReduced(media.matches);
    const observer = new IntersectionObserver((entries) => {
      inViewport = entries[0]?.isIntersecting ?? true;
      syncSuspension();
    }, { threshold: 0.01 });

    observer.observe(root);
    window.addEventListener("pointerdown", interrupt, { capture: true });
    window.addEventListener("keydown", interrupt, { capture: true });
    document.addEventListener("visibilitychange", visibility);
    media.addEventListener("change", reduced);

    root.dataset.signatureNodeCount = String(root.querySelectorAll("*").length);
    syncSuspension();
    runtime.start();

    return () => {
      runtime.dispose();
      observer.disconnect();
      window.removeEventListener("pointerdown", interrupt, { capture: true });
      window.removeEventListener("keydown", interrupt, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", reduced);
    };
  }, [clip]);

  return (
    <span
      ref={rootRef}
      className={`startrips-signature-motion ${className}`}
      role="img"
      aria-label={title}
      data-brand-version="12"
      data-signature-clip={clip}
      style={{ "--startrips-signature-size": `${size}px` } as CSSProperties}
    >
      <svg className="startrips-signature-motion__svg" viewBox={VIEWBOX} aria-hidden="true" focusable="false">
        <g data-signature-part="letters"><use href={useHref("letters")} /></g>
        <g data-signature-part="star"><use href={useHref("star")} /></g>
        <g data-signature-part="goat-root">
          <use href={useHref("tail")} />
          <g data-signature-part="leg-hf"><use href={useHref("leg-hf")} /></g>
          <g data-signature-part="leg-ff"><use href={useHref("leg-ff")} /></g>
          <g data-signature-part="body"><use href={useHref("body")} /></g>
          <g data-signature-part="leg-hn"><use href={useHref("leg-hn")} /></g>
          <g data-signature-part="leg-fn"><use href={useHref("leg-fn")} /></g>
          <use href={useHref("neck")} />
          <g data-signature-part="head">
            <use href={useHref("hornFar")} /><use href={useHref("earFar")} />
            <use href={useHref("skull")} /><use href={useHref("muzzle")} /><use href={useHref("frontMuzzle")} />
            <use href={useHref("beard")} /><use href={useHref("hornNear")} /><use href={useHref("earNear")} />
            <g data-signature-part="eye"><use href={useHref("eyeNear")} /><use href={useHref("eyeFar")} /></g>
            <use href={useHref("nostril")} />
          </g>
        </g>
      </svg>
    </span>
  );
}
