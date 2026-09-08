import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  pointerWithin, rectIntersection, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconCheck, IconFolder, IconGripVertical, IconPhoto, IconStar, IconVideo } from "@tabler/icons-react";
import { onMotionPreferenceChange, prefersReducedMotion } from "../motion/preferences";
import { motionTokens } from "../motion/tokens";
import type { Journey, JourneyMediaAsset } from "./types";
import "../styles/story-media-organizer.css";

type MediaRead = { status: "ready"; url: string } | { status: "loading" } | { status: "error"; message: string };
export type StoryMediaOrganizerProps = {
  media: readonly JourneyMediaAsset[];
  allMedia: readonly JourneyMediaAsset[];
  routePoints: Journey["routePoints"];
  reads: Record<string, MediaRead>;
  currentId: string | null;
  coverId: string | null;
  selectedIds: ReadonlySet<string>;
  selecting: boolean;
  disabled: boolean;
  onToggleSelect: (id: string) => void;
  onSelect: (index: number, source: HTMLButtonElement) => void;
  onRequestRead: (id: string) => void;
  onSetCover?: (id: string) => void;
  onReorder: (event: DragEndEvent) => void;
  onMove: (ids: readonly string[], targetId: string | null) => Promise<boolean>;
};

type Destination = { id: string | null; name: string; assets: JourneyMediaAsset[]; cover?: JourneyMediaAsset };
type FlightPhoto = { id: string; rect: DOMRect; src: string };
type MoveCapture = { photos: FlightPhoto[]; tiles: Map<string, DOMRect> };
const destinationKey = (id: string | null) => `story-destination:${id ?? "loose-pages"}`;

// Only visible image thumbnails need signed URLs. Videos remain file tiles here,
// so organizing a library never mounts additional playback transports.
function useThumbnailRead(
  element: RefObject<HTMLElement | null>, asset: JourneyMediaAsset | undefined,
  read: MediaRead | undefined, onRequestRead: (id: string) => void,
) {
  useEffect(() => {
    const node = element.current;
    if (!node || !asset || !asset.mimeType.startsWith("image/") || read) return;
    const root = node.closest<HTMLElement>(".story-media-organizer");
    let requested = false;
    const request = () => {
      if (requested) return;
      requested = true;
      onRequestRead(asset.id);
    };
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          request();
        }
      }, { root, rootMargin: "120px" });
      observer.observe(node);
      return () => observer.disconnect();
    }
    const check = () => {
      const rect = node.getBoundingClientRect();
      const bounds = root?.getBoundingClientRect();
      if (rect.width && rect.height && rect.bottom >= Math.max(0, bounds?.top ?? 0)
        && rect.top <= Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)) request();
    };
    check();
    root?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      root?.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [asset, element, onRequestRead, read]);
}

function Thumbnail({ asset, read }: { asset: JourneyMediaAsset; read?: MediaRead }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (asset.mimeType.startsWith("video/")) return <span className="story-media-organizer__placeholder"><IconVideo aria-hidden="true" /><span title={asset.fileName}>{asset.fileName}</span></span>;
  if (read?.status === "ready" && failedUrl !== read.url) return <img src={read.url} alt={asset.fileName} loading="lazy" decoding="async" draggable={false} onError={() => setFailedUrl(read.url)} />;
  return <span className="story-media-organizer__placeholder"><IconPhoto aria-hidden="true" /><span>{read?.status === "error" || read?.status === "ready" ? "暂不可用" : "载入中"}</span></span>;
}

function OrganizerTile({ asset, index, props, busy, register }: {
  asset: JourneyMediaAsset; index: number; props: StoryMediaOrganizerProps; busy: boolean;
  register: (id: string, node: HTMLButtonElement | null) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const selected = props.selectedIds.has(asset.id);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: asset.id, disabled: props.disabled || busy, data: { kind: "media", routePointId: asset.routePointId },
  });
  useThumbnailRead(buttonRef, asset, props.reads[asset.id], props.onRequestRead);
  const setButton = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    register(asset.id, node);
  }, [asset.id, register]);
  return <li ref={setNodeRef} className={`story-media-organizer__item${isDragging ? " is-dragging" : ""}`}
    style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button ref={setButton} type="button" className={`story-media-organizer__tile${selected ? " is-selected" : ""}`}
      disabled={props.disabled || busy} data-media-tile-index={index}
      aria-current={props.currentId === asset.id ? "true" : undefined}
      aria-pressed={props.selecting ? selected : undefined}
      aria-label={`${props.selecting ? "选择" : "查看"}第 ${index + 1} 项：${asset.fileName}${props.coverId === asset.id ? "，旅程封面" : ""}`}
      onPointerDown={listeners?.onPointerDown ? (event) => listeners.onPointerDown(event) : undefined}
      onClick={(event) => props.selecting ? props.onToggleSelect(asset.id) : props.onSelect(index, event.currentTarget)}>
      <Thumbnail asset={asset} read={props.reads[asset.id]} />
      {props.selecting && <span className="story-media-organizer__check">{selected && <IconCheck aria-hidden="true" />}</span>}
      {props.coverId === asset.id && <span className="story-media-organizer__cover-label">封面</span>}
      <small>{index + 1}</small>
    </button>
    <div className="story-media-organizer__tile-actions">
      <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners}
        disabled={props.disabled || busy} className="story-media-organizer__grip"
        aria-label={`拖动 ${asset.fileName}：同地点排序，或移到目标卡片`}><IconGripVertical aria-hidden="true" /></button>
      {props.onSetCover && props.coverId !== asset.id && <button type="button" disabled={props.disabled || busy}
        onClick={() => props.onSetCover?.(asset.id)} aria-label={`将 ${asset.fileName} 设为封面`}><IconStar aria-hidden="true" /></button>}
    </div>
  </li>;
}

function DestinationCard({ destination, props, moveCount, canDrop, busy, register, onMove }: {
  destination: Destination; props: StoryMediaOrganizerProps; moveCount: number; canDrop: boolean; busy: boolean;
  register: (id: string | null, node: HTMLButtonElement | null) => void; onMove: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: destinationKey(destination.id), disabled: props.disabled || busy || !canDrop,
    data: { kind: "destination", targetId: destination.id },
  });
  useThumbnailRead(ref, destination.cover, destination.cover ? props.reads[destination.cover.id] : undefined, props.onRequestRead);
  const setButton = useCallback((node: HTMLButtonElement | null) => {
    ref.current = node;
    setNodeRef(node);
    register(destination.id, node);
  }, [destination.id, register, setNodeRef]);
  return <button ref={setButton} type="button"
    className={`story-media-organizer__destination${isOver ? " is-over" : ""}`}
    disabled={props.disabled || busy || (moveCount === 0 && !canDrop)} onClick={onMove}
    aria-label={`${destination.name}，现有 ${destination.assets.length} 项${moveCount ? `，移入所选 ${moveCount} 项` : "，先选择其他位置的媒体"}`}>
    <span className="story-media-organizer__folder" aria-hidden="true">
      {destination.cover && <span className="story-media-organizer__folder-cover"><Thumbnail asset={destination.cover} read={props.reads[destination.cover.id]} /></span>}
      <IconFolder className="story-media-organizer__folder-icon" />
      <b>{destination.assets.length}</b>
    </span>
    <span className="story-media-organizer__destination-name">{destination.name}</span>
    <span className="story-media-organizer__destination-hint">{moveCount ? `移入 ${moveCount} 项` : "整理到这里"}</span>
  </button>;
}

export function StoryMediaOrganizer(props: StoryMediaOrganizerProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const latestMediaRef = useRef(props.allMedia);
  latestMediaRef.current = props.allMedia;
  const tileNodes = useRef(new Map<string, HTMLButtonElement>());
  const destinationNodes = useRef(new Map<string, HTMLButtonElement>());
  const animations = useRef(new Set<Animation>());
  const flightNodes = useRef(new Set<HTMLElement>());
  const frameRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const dragCaptureRef = useRef<MoveCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [dragIds, setDragIds] = useState<string[]>([]);
  const keyboardCoordinates: typeof sortableKeyboardCoordinates = (event, args) => {
    const active = args.context.active;
    const activeAsset = props.media.find((asset) => asset.id === String(active?.id));
    const count = activeAsset && props.selectedIds.has(activeAsset.id) ? props.selectedIds.size : 1;
    // Use the same eligible destinations as collision detection. Otherwise
    // keyboard movement can aim at another chapter that cannot accept a sort.
    const droppableRects = new Map([...args.context.droppableRects].filter(([id]) => {
      const data = args.context.droppableContainers.get(id)?.data.current;
      return data?.kind === "destination"
        || (count <= 1 && data?.kind === "media" && data.routePointId === activeAsset?.routePointId);
    }));
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects } });
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }));
  const selected = props.media.filter((asset) => props.selectedIds.has(asset.id));
  const destinations = useMemo<Destination[]>(() => [
    { id: null, name: "旅程散页" },
    ...props.routePoints.map((point, index) => ({ id: point.id, name: point.label.trim() || `地点 ${index + 1}` })),
  ].map((destination) => {
    const assets = props.allMedia.filter((asset) => asset.routePointId === destination.id);
    return { ...destination, assets, cover: assets.find((asset) => asset.id === props.coverId)
      ?? assets.find((asset) => asset.mimeType.startsWith("image/")) ?? assets[0] };
  }), [props.allMedia, props.coverId, props.routePoints]);
  const registerTile = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) tileNodes.current.set(id, node); else tileNodes.current.delete(id);
  }, []);
  const registerDestination = useCallback((id: string | null, node: HTMLButtonElement | null) => {
    if (node) destinationNodes.current.set(destinationKey(id), node); else destinationNodes.current.delete(destinationKey(id));
  }, []);

  const cancelPresentation = useCallback(() => {
    epochRef.current += 1;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
    flightNodes.current.forEach((node) => node.remove());
    flightNodes.current.clear();
  }, []);
  useEffect(() => {
    aliveRef.current = true;
    window.addEventListener("resize", cancelPresentation);
    const stopPreference = onMotionPreferenceChange((reduced) => { if (reduced) cancelPresentation(); });
    return () => {
      aliveRef.current = false;
      window.removeEventListener("resize", cancelPresentation);
      stopPreference();
      cancelPresentation();
    };
  }, [cancelPresentation]);

  const captureMove = (ids: readonly string[]): MoveCapture => {
    const photos: FlightPhoto[] = [];
    const tiles = new Map<string, DOMRect>();
    const bounds = rootRef.current?.getBoundingClientRect();
    tileNodes.current.forEach((node, id) => {
      const rect = node.getBoundingClientRect();
      if (!node.isConnected || !rect.width || !rect.height) return;
      if (rect.bottom < Math.max(0, bounds?.top ?? 0) || rect.top > Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight)) return;
      tiles.set(id, rect);
      if (!ids.includes(id) || photos.length >= 8) return;
      const image = node.querySelector("img");
      if (image?.complete && image.naturalWidth > 0) photos.push({ id, rect, src: image.currentSrc || image.src });
    });
    return { photos, tiles };
  };

  const trackAnimation = (animation: Animation, node?: HTMLElement) => {
    animations.current.add(animation);
    const finish = () => {
      animations.current.delete(animation);
      if (node) { flightNodes.current.delete(node); node.remove(); }
    };
    void animation.finished.then(finish, finish);
  };

  const presentMove = (capture: MoveCapture, targetId: string | null, count: number) => {
    if (prefersReducedMotion() || typeof Element.prototype.animate !== "function") return;
    const target = destinationNodes.current.get(destinationKey(targetId));
    if (!target?.isConnected) return;
    const end = target.getBoundingClientRect();
    const rootBounds = rootRef.current?.getBoundingClientRect();
    if (!end.width || end.bottom < Math.max(0, rootBounds?.top ?? 0)
      || end.top > Math.min(window.innerHeight, rootBounds?.bottom ?? window.innerHeight)) return;
    capture.tiles.forEach((before, id) => {
      const node = tileNodes.current.get(id);
      if (!node?.isConnected) return;
      const after = node.getBoundingClientRect();
      const x = before.left - after.left;
      const y = before.top - after.top;
      if (Math.abs(x) + Math.abs(y) > 1) trackAnimation(node.animate([
        { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" },
      ], { duration: motionTokens.tiers.ui, easing: motionTokens.easings.easeOutSoft }));
    });
    capture.photos.forEach((photo, index) => {
      const node = document.createElement("div");
      node.className = "story-media-organizer__flight";
      node.setAttribute("aria-hidden", "true");
      Object.assign(node.style, { left: `${photo.rect.left}px`, top: `${photo.rect.top}px`, width: `${photo.rect.width}px`, height: `${photo.rect.height}px` });
      const image = document.createElement("img");
      image.src = photo.src;
      image.alt = "";
      node.append(image);
      if (index === capture.photos.length - 1 && count > capture.photos.length) {
        const badge = document.createElement("b");
        badge.textContent = `${count} 项`;
        node.append(badge);
      }
      document.body.append(node);
      flightNodes.current.add(node);
      const x = end.left + end.width / 2 - photo.rect.left - photo.rect.width / 2;
      const y = end.top + Math.min(48, end.height / 2) - photo.rect.top - photo.rect.height / 2;
      const angle = index % 2 ? 5 : -5;
      const scale = Math.min(0.45, 42 / Math.max(photo.rect.width, photo.rect.height));
      trackAnimation(node.animate([
        { transform: "translate(0, 0) rotate(0deg) scale(1)", offset: 0 },
        { transform: `translate(0, -20px) rotate(${angle}deg) scale(0.94)`, offset: 0.22 },
        { transform: `translate(${x}px, ${y}px) rotate(${angle / 2}deg) scale(${scale})`, offset: 1 },
      ], { duration: motionTokens.tiers.content, delay: index * motionTokens.tiers.ui / 4,
        easing: motionTokens.easings.easeInOutSpatial, fill: "both" }), node);
    });
    const folder = target.querySelector<HTMLElement>(".story-media-organizer__folder");
    if (folder) trackAnimation(folder.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }], {
      duration: motionTokens.tiers.ui, delay: capture.photos.length ? motionTokens.tiers.content : 0,
      easing: motionTokens.easings.easeOutSoft,
    }));
  };

  const move = async (ids: readonly string[], targetId: string | null, captured?: MoveCapture | null) => {
    if (busyRef.current || props.disabled) return;
    const actualIds = ids.filter((id) => props.media.some((asset) => asset.id === id && asset.routePointId !== targetId));
    if (!actualIds.length) return;
    cancelPresentation();
    const epoch = epochRef.current;
    const before = captured ?? captureMove(actualIds);
    const capture = { ...before, photos: before.photos.filter((photo) => actualIds.includes(photo.id)) };
    busyRef.current = true;
    setMoveError("");
    setBusy(true);
    try {
      const succeeded = await props.onMove(actualIds, targetId);
      if (succeeded && aliveRef.current && epoch === epochRef.current) {
        // The parent owns assignments, covers, counts and undo. Read the new DOM
        // after its successful mutation has committed, then move the saved photos.
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          const reflected = actualIds.every((id) => latestMediaRef.current.some((asset) => asset.id === id && asset.routePointId === targetId));
          if (aliveRef.current && epoch === epochRef.current && reflected) presentMove(capture, targetId, actualIds.length);
        });
      }
    } catch (error) {
      // The normal false result is explained by the parent. Keep an unexpected
      // rejected adapter promise visible too, while leaving the photos in place.
      if (aliveRef.current) setMoveError(error instanceof Error ? error.message : "移动失败，请重试。");
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const collisionDetection: CollisionDetection = (args) => {
    const active = props.media.find((asset) => asset.id === String(args.active.id));
    const containers = args.droppableContainers.filter((container) => {
      const data = container.data.current;
      if (data?.kind === "destination") return true;
      return dragIds.length <= 1 && data?.kind === "media" && data.routePointId === active?.routePointId;
    });
    const filtered = { ...args, droppableContainers: containers };
    // Keyboard movement can pass a different chapter's tile. Such a position
    // must not resolve to a distant valid folder merely because it is closest.
    return args.pointerCoordinates ? pointerWithin(filtered) : rectIntersection(filtered);
  };
  const onDragStart = (event: DragStartEvent) => {
    cancelPresentation();
    const id = String(event.active.id);
    const ids = props.selectedIds.has(id) ? selected.map((asset) => asset.id) : [id];
    dragCaptureRef.current = captureMove(ids);
    setDragIds(ids);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const ids = dragIds;
    const capture = dragCaptureRef.current;
    dragCaptureRef.current = null;
    setDragIds([]);
    if (props.disabled || busyRef.current || !event.over) return;
    if (event.over.data.current?.kind === "destination") {
      void move(ids, event.over.data.current.targetId as string | null, capture);
    } else if (ids.length === 1) {
      props.onReorder(event);
    }
  };
  const dragged = props.media.filter((asset) => dragIds.includes(asset.id));

  return <section ref={rootRef} className="story-media-organizer" aria-label="媒体整理" aria-busy={busy}
    onScroll={cancelPresentation}>
    <p className="story-media-organizer__instruction" aria-live="polite">{moveError || (busy ? "正在整理所选媒体…" : selected.length
      ? `已选 ${selected.length} 项，点击下面的位置移入；也可以拖入卡片。`
      : props.selecting ? "点选要整理的媒体，再点击目标位置。单张可拖动排序。"
        : "点击上方“选择”开始多选，再点击目标位置。单张可拖动排序。")}</p>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={onDragStart}
      onDragEnd={onDragEnd} onDragCancel={() => { dragCaptureRef.current = null; setDragIds([]); }}>
      <div className="story-media-organizer__destinations" aria-label="移动到旅程位置">
        {destinations.map((destination) => <DestinationCard key={destinationKey(destination.id)} destination={destination}
          props={props} busy={busy} register={registerDestination}
          moveCount={selected.filter((asset) => asset.routePointId !== destination.id).length}
          canDrop={dragged.some((asset) => asset.routePointId !== destination.id)}
          onMove={() => { void move(selected.map((asset) => asset.id), destination.id); }} />)}
      </div>
      <SortableContext items={props.media.map((asset) => asset.id)} strategy={rectSortingStrategy}>
        <ul className="story-media-organizer__grid" aria-label={`当前范围媒体，共 ${props.media.length} 项`}>
          {props.media.map((asset, index) => <OrganizerTile key={asset.id} asset={asset} index={index} props={props}
            busy={busy} register={registerTile} />)}
        </ul>
      </SortableContext>
      {!props.media.length && <p className="story-media-organizer__empty">这里还没有媒体，其他位置的照片可移入这里。</p>}
      {typeof document !== "undefined" && createPortal(<DragOverlay dropAnimation={null} zIndex={12000}>
        {dragged.length > 0 && <div className="story-media-organizer__drag-stack" aria-hidden="true">
          {dragged.slice(0, 3).map((asset) => <div key={asset.id}><Thumbnail asset={asset} read={props.reads[asset.id]} /></div>)}
          <b>{dragged.length} 项</b>
        </div>}
      </DragOverlay>, document.body)}
    </DndContext>
  </section>;
}
