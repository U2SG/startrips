import * as THREE from "three";
import { FlipBook } from "quick_flipbook";
import type { JourneyBookOrientation } from "./journeyBookLayout";
import { cameraHalfHeight } from "./journeyBook3dModel";

/**
 * #393 3D Journey Book: the Three.js stage around Quick FlipBook
 * (https://github.com/bandinopla/quick_flipbook, BSD 2-Clause, Copyright (c)
 * 2024 bandinopla). Lighting, camera and material choices follow 3D Book 2 in
 * create-photo-flipbook-ui (MIT, Copyright (c) 2026 Haichao Li).
 *
 * The book lies on the XZ plane under a straight-down orthographic camera, so
 * a settled page is flat on screen and maps to a plain rectangle. It renders
 * only while something moves.
 */
const MAX_PIXEL_RATIO = 2;
const SHADOW_MAP_SIZE = 1024;
const PAGE_SUBDIVISIONS = 16;
const FLIP_SECONDS = 0.78;
const FOCUS_RATE = 9;
const EDGE_LIFT = 0.055;
const SETTLED_EPSILON = 1e-4;

export type ScreenRect = { left: number; top: number; width: number; height: number };

export class JourneyBook3dScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  private readonly book: FlipBook;
  private readonly blank: THREE.MeshStandardMaterial;
  private readonly faceMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly dirtySheets = new Set<{ page: THREE.Mesh }>();
  private frame: number | null = null;
  private lastTime = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private halfHeight = 1;
  private focus = 0;
  private focusTarget = 0;
  /** The pointer owns progress while dragging; the book's own clock is paused. */
  private dragging = false;
  private edge: { base: number; direction: -1 | 1; amount: number; target: number } | null = null;
  private onFrameListener: ((progress: number, settled: boolean) => void) | null = null;
  readonly pageWidth: number;

  constructor(canvas: HTMLCanvasElement, pageWidth: number, reduced: boolean, background: string) {
    this.pageWidth = pageWidth;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(background);

    this.camera.position.set(0, 5, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight("#ffffff", "#2a2f2c", 1.05));
    const key = new THREE.DirectionalLight("#ffffff", 2.4);
    key.position.set(-2.8, 5.2, 2.7);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    Object.assign(key.shadow.camera, { near: 0.1, far: 14, left: -3, right: 3, top: 3, bottom: -3 });
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 3;
    this.scene.add(key);
    const rim = new THREE.PointLight("#ffffff", 0.45, 8, 2);
    rim.position.set(2.5, 1.8, -2.4);
    this.scene.add(rim);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18),
      new THREE.MeshStandardMaterial({ color: background, roughness: 1, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.035;
    table.receiveShadow = true;
    this.scene.add(table);

    this.blank = this.paperMaterial(null);
    this.book = new FlipBook({
      flipDuration: reduced ? 0.001 : FLIP_SECONDS,
      yBetweenPages: 0.0012,
      pageSubdivisions: PAGE_SUBDIVISIONS,
    });
    this.book.scale.x = pageWidth;
    this.scene.add(this.book);
  }

  private paperMaterial(map: THREE.Texture | null): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: "#ffffff", map, roughness: 0.88, metalness: 0 });
    material.shadowSide = THREE.DoubleSide;
    return material;
  }

  /** One material per face; textures are attached and released later. */
  setFaceCount(count: number) {
    for (const material of this.faceMaterials) material.dispose();
    this.faceMaterials.length = 0;
    for (let face = 0; face < count; face += 1) this.faceMaterials.push(this.paperMaterial(null));
    this.book.setPages([...this.faceMaterials]);
    // Quick FlipBook assigns supplied materials through a promise chain;
    // assigning them directly makes the book complete in this frame.
    let index = 0;
    for (const sheet of this.book) {
      sheet.setPageMaterial(this.faceMaterials[index * 2], 1);
      sheet.setPageMaterial(this.faceMaterials[index * 2 + 1] ?? this.blank, 0);
      sheet.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      this.memoize(sheet);
      index += 1;
    }
    for (const sheet of this.book) sheet.page.geometry.computeVertexNormals();
    this.requestRender();
  }

  /** Recompute normals only for sheets whose deformation changed. */
  private memoize(sheet: { flip: (progress: number, direction: number, intensity?: number) => void; page: THREE.Mesh }) {
    const flip = sheet.flip.bind(sheet);
    let previous = "";
    sheet.flip = (progress, direction, intensity = 1) => {
      const key = `${progress}:${direction}:${intensity}`;
      if (key === previous) return;
      previous = key;
      flip(progress, direction, intensity);
      this.dirtySheets.add(sheet);
    };
  }

  /** Attach (or release, with null) the texture painted for a face. */
  setFaceTexture(face: number, texture: THREE.Texture | null) {
    const material = this.faceMaterials[face];
    if (!material || material.map === texture) return;
    const hadMap = material.map !== null;
    material.map = texture;
    if (hadMap !== (texture !== null)) material.needsUpdate = true;
    this.requestRender();
  }

  /** A painted texture changed in place. */
  textureUpdated() {
    this.requestRender();
  }

  get maxAnisotropy() {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  get maxTextureSize() {
    return this.renderer.capabilities.maxTextureSize;
  }

  resize(width: number, height: number, orientation: JourneyBookOrientation) {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    const aspect = this.cssWidth / this.cssHeight;
    this.halfHeight = cameraHalfHeight(aspect, this.pageWidth, orientation);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.applyCamera();
    this.requestRender();
  }

  private applyCamera() {
    const aspect = this.cssWidth / this.cssHeight;
    this.camera.left = this.focus - this.halfHeight * aspect;
    this.camera.right = this.focus + this.halfHeight * aspect;
    this.camera.top = this.halfHeight;
    this.camera.bottom = -this.halfHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Pan to a world x (portrait reading moves between the two pages). */
  setFocus(x: number, immediate: boolean) {
    this.focusTarget = x;
    if (immediate) {
      this.focus = x;
      this.applyCamera();
    }
    this.requestRender();
  }

  get pixelsPerUnit() {
    return this.cssHeight / (2 * this.halfHeight);
  }

  /** Screen x (stage CSS px) of the spine, or of the closed book's centre. */
  get spineX() {
    return this.cssWidth / 2 - this.focus * this.pixelsPerUnit;
  }

  get pageWidthPx() {
    return this.pageWidth * this.pixelsPerUnit;
  }

  get pageHeightPx() {
    return this.pixelsPerUnit;
  }

  /** Where a settled face lies on the stage, in CSS px. */
  faceRect(side: "closed-front" | "closed-back" | "left" | "right"): ScreenRect {
    const width = this.pageWidthPx;
    const height = this.pageHeightPx;
    const top = this.cssHeight / 2 - height / 2;
    const spine = this.spineX;
    const left = side === "left" ? spine - width : side === "right" ? spine : spine - width / 2;
    return { left, top, width, height };
  }

  get progress() {
    return this.book.progress;
  }

  get sheets() {
    return this.book.totalPages / 2;
  }

  isSettled() {
    return !this.dragging && this.edge === null
      && Math.abs(this.book.progress - Math.round(this.book.progress)) < SETTLED_EPSILON
      && Math.abs(this.focus - this.focusTarget) < SETTLED_EPSILON;
  }

  /** Turn (animated) to a spread; many sheets riffle in one turn's time. */
  turnTo(spread: number) {
    this.clearEdge(true);
    this.book.currentPage = Math.max(0, Math.min(this.sheets, spread)) * 2;
    this.requestRender();
  }

  /** Place the book at a spread without animation. */
  jumpTo(spread: number) {
    this.clearEdge(true);
    this.book.progress = Math.max(0, Math.min(this.sheets, spread));
    this.requestRender();
  }

  beginDrag() {
    this.clearEdge(true);
    this.dragging = true;
  }

  /** Progress while the pointer holds the page. */
  dragTo(progress: number) {
    this.book.progress = progress;
    this.requestRender();
  }

  endDrag(targetSpread: number) {
    this.dragging = false;
    this.book.currentPage = targetSpread * 2;
    this.requestRender();
  }

  /** Desktop hover lift of the edge the pointer rests on; 0 lays it down. */
  hoverEdge(direction: -1 | 0 | 1) {
    if (direction === 0) {
      if (this.edge) this.edge.target = 0;
      this.requestRender();
      return;
    }
    const base = Math.round(this.book.progress);
    if (this.edge && this.edge.direction !== direction) this.clearEdge(true);
    if (!this.edge) {
      if (Math.abs(this.book.progress - base) > SETTLED_EPSILON) return;
      if ((direction === 1 && base >= this.sheets) || (direction === -1 && base <= 0)) return;
      this.edge = { base, direction, amount: 0, target: EDGE_LIFT };
    }
    this.edge.target = EDGE_LIFT;
    this.requestRender();
  }

  get hasEdge() {
    return this.edge !== null;
  }

  /** A drag that starts on a lifted edge takes over its pose. */
  takeEdge(): { direction: -1 | 1; fraction: number; base: number } | null {
    const edge = this.edge;
    if (!edge || edge.target === 0) return null;
    this.edge = null;
    return { direction: edge.direction, fraction: edge.amount, base: edge.base };
  }

  private clearEdge(immediate: boolean) {
    if (!this.edge) return;
    if (immediate) {
      this.book.progress = this.edge.base;
      this.edge = null;
    } else {
      this.edge.target = 0;
    }
  }

  private animateEdge(delta: number): boolean {
    const edge = this.edge;
    if (!edge) return false;
    edge.amount += (edge.target - edge.amount) * (1 - Math.exp(-(edge.target > edge.amount ? 18 : 14) * delta));
    if (Math.abs(edge.target - edge.amount) < 5e-4) edge.amount = edge.target;
    if (edge.target === 0 && edge.amount === 0) {
      this.book.progress = edge.base;
      this.edge = null;
      return false;
    }
    this.book.progress = edge.base + edge.direction * edge.amount;
    if (edge.target === 0) {
      // The engine bends by the direction progress moves; while the lift lays
      // back down that would curl the page the wrong way, so keep its bend.
      const progress = this.book.progress;
      const fraction = progress - Math.floor(progress);
      const intensity = progress < 1 ? fraction
        : progress >= this.sheets ? 0
          : progress >= this.sheets - 1 ? 1 - fraction : 1;
      let index = 0;
      const target = edge.direction === 1 ? edge.base : edge.base - 1;
      for (const sheet of this.book) {
        if (index === target) {
          sheet.flip(edge.direction === 1 ? edge.amount : 1 - edge.amount, edge.direction, intensity);
          break;
        }
        index += 1;
      }
    }
    return edge.amount !== edge.target;
  }

  onFrame(listener: ((progress: number, settled: boolean) => void) | null) {
    this.onFrameListener = listener;
  }

  requestRender() {
    if (this.frame !== null) return;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.animate);
  }

  private animate = (time: number) => {
    this.frame = null;
    const delta = Math.min((time - this.lastTime) / 1000, 0.04);
    this.lastTime = time;
    const before = this.book.progress;
    if (!this.dragging) this.book.animate(delta);
    const edgeMoving = this.animateEdge(delta);
    const focusMoving = Math.abs(this.focus - this.focusTarget) >= SETTLED_EPSILON;
    if (focusMoving) {
      this.focus += (this.focusTarget - this.focus) * (1 - Math.exp(-FOCUS_RATE * delta));
      if (Math.abs(this.focus - this.focusTarget) < SETTLED_EPSILON) this.focus = this.focusTarget;
      this.applyCamera();
    }
    for (const sheet of this.dirtySheets) sheet.page.geometry.computeVertexNormals();
    this.dirtySheets.clear();
    this.renderer.render(this.scene, this.camera);
    const turning = !this.dragging && Math.abs(before - this.book.progress) > 1e-7;
    this.onFrameListener?.(this.book.progress, this.isSettled());
    if (turning || edgeMoving || focusMoving) this.frame = requestAnimationFrame(this.animate);
  };

  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.onFrameListener = null;
    // Dispose everything still in the scene (including the sheets) before the
    // book detaches its sheets, which it does without disposing them.
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      }
    });
    this.book.dispose();
    for (const material of this.faceMaterials) material.dispose();
    this.blank.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
