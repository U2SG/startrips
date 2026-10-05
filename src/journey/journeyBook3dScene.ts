import * as THREE from "three";
import { FlipBook } from "quick_flipbook";
import type { JourneyBookOrientation } from "./journeyBookLayout";
import {
  BOOK_CAMERA_TILT,
  BOOK_SHEET_SPACING,
  bookFrame,
  bookTableHeight,
  coverKeyLight,
  faceScreenRect,
  READING_KEY,
  stackSheets,
  type BookFrame,
  type FaceSide,
  type ScreenRect,
} from "./journeyBook3dModel";

/**
 * #393 3D Journey Book: the Three.js stage around Quick FlipBook
 * (https://github.com/bandinopla/quick_flipbook, BSD 2-Clause, Copyright (c)
 * 2024 bandinopla). Lighting, camera and material choices follow 3D Book 2 in
 * create-photo-flipbook-ui (MIT, Copyright (c) 2026 Haichao Li).
 *
 * The book lies on the XZ plane under an orthographic camera tilted toward the
 * reader (`BOOK_CAMERA_TILT`), so a settled page still maps to a plain
 * rectangle while the near edge shows the thickness of the page blocks. It
 * renders only while something moves.
 */
const MAX_PIXEL_RATIO = 2;
const SHADOW_MAP_SIZE = 1024;
const PAGE_SUBDIVISIONS = 16;
const FLIP_SECONDS = 0.78;
const FOCUS_RATE = 9;
const EDGE_LIFT = 0.055;
const PAPER_ROUGHNESS = 0.88;
const SETTLED_EPSILON = 1e-4;
/** A block's top sits this far under the top sheet of its stack. */
const BLOCK_TOP_GAP = BOOK_SHEET_SPACING * 0.4;
/** World height of one tile of the paper-edge stripes (fixed on screen). */
const EDGE_TILE_HEIGHT = 0.35;
/** How far the contact shadow spreads past the book (world units). */
const CONTACT_SPREAD = 0.07;
const CONTACT_LIFT = 0.0015;
/**
 * World height of one step (1/255) of the cover's height channel, per screen
 * pixel: three.js differentiates the bump map in screen space and normalises
 * the surface derivatives, so this is a slope, not a depth. The groove ramps
 * fall about 0.06 per texel, so 10 tilts their walls 30–50° at the cover's
 * on-screen sizes (desktop and phone) without the flat cloth moving at all.
 */
const COVER_BUMP_SCALE = 10;

/** Thin page edges seen on the near side of a page block, tiled vertically. */
function paperEdgeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 32;
  const context = canvas.getContext("2d")!;
  let seed = 0x51d3;
  for (let row = 0; row < canvas.height; row += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Alternate light page faces and slightly darker gaps, with a little jitter.
    const shade = (row % 2 === 0 ? 228 : 204) + (seed % 9) - 4;
    context.fillStyle = `rgb(${shade} ${shade - 3} ${shade - 10})`;
    context.fillRect(0, row, canvas.width, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** A soft dark footprint, `inset` of each side being the blurred falloff. */
function paintContactShadow(canvas: HTMLCanvasElement, insetX: number, insetY: number) {
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const blur = Math.min(insetX * canvas.width, insetY * canvas.height) * 0.6;
  // Draw the rectangle off canvas and keep only its blurred shadow.
  const offset = canvas.width * 4;
  context.shadowColor = "rgb(0 0 0 / 0.7)";
  context.shadowBlur = blur;
  context.shadowOffsetX = offset;
  context.fillStyle = "#000";
  const x = insetX * canvas.width;
  const y = insetY * canvas.height;
  context.fillRect(x - offset, y, canvas.width - 2 * x, canvas.height - 2 * y);
}

export class JourneyBook3dScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  private readonly book: FlipBook;
  private readonly table: THREE.Mesh;
  private readonly blank: THREE.MeshStandardMaterial;
  private readonly faceMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly key: THREE.DirectionalLight;
  private readonly reduced: boolean;
  private readonly dirtySheets = new Set<{ page: THREE.Mesh }>();
  private frame: number | null = null;
  private lastTime = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private orientation: JourneyBookOrientation = "landscape";
  private frameBox: BookFrame = { top: 1, bottom: -1, halfWidth: 1 };
  private readonly blocks: { left: THREE.Mesh; right: THREE.Mesh };
  private readonly edgeTextures: THREE.Texture[] = [];
  private readonly contact: THREE.Mesh;
  private readonly contactCanvas = document.createElement("canvas");
  private readonly contactTexture: THREE.CanvasTexture;
  private stacksKey = "";
  private contactKey = "";
  private focus = 0;
  private focusTarget = 0;
  /** The pointer owns progress while dragging; the book's own clock is paused. */
  private dragging = false;
  private edge: { base: number; direction: -1 | 1; amount: number; target: number } | null = null;
  private onFrameListener: ((progress: number, settled: boolean) => void) | null = null;
  readonly pageWidth: number;

  constructor(canvas: HTMLCanvasElement, pageWidth: number, reduced: boolean, background: string) {
    this.pageWidth = pageWidth;
    this.reduced = reduced;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(background);

    // Tilted toward the reader on the +Z side; screen right stays world +X.
    this.camera.position.set(0, 5 * Math.cos(BOOK_CAMERA_TILT), 5 * Math.sin(BOOK_CAMERA_TILT));
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight("#ffffff", "#2a2f2c", 1.05));
    // Posed every frame by `coverKeyLight`: raking on the closed front cover.
    const key = new THREE.DirectionalLight("#ffffff", READING_KEY.intensity);
    key.position.set(READING_KEY.x, READING_KEY.y, READING_KEY.z);
    this.key = key;
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

    this.table = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18),
      new THREE.MeshStandardMaterial({ color: background, roughness: 1, metalness: 0 }),
    );
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.y = bookTableHeight(0);
    this.table.receiveShadow = true;
    this.scene.add(this.table);

    this.blank = this.paperMaterial(null);
    this.book = new FlipBook({
      flipDuration: reduced ? 0.001 : FLIP_SECONDS,
      yBetweenPages: BOOK_SHEET_SPACING,
      pageSubdivisions: PAGE_SUBDIVISIONS,
    });
    this.book.scale.x = pageWidth;
    this.scene.add(this.book);

    // Page blocks and the contact shadow are children of the book, so they
    // share its `scale.x = pageWidth` and its closed-cover offset. Only the
    // near (+Z) face of a block is ever seen; it carries the paper edges.
    const top = new THREE.MeshStandardMaterial({ color: "#f2f0e8", roughness: 0.9, metalness: 0 });
    const side = new THREE.MeshStandardMaterial({ color: "#d9d4c6", roughness: 0.95, metalness: 0 });
    const block = () => {
      const texture = paperEdgeTexture();
      this.edgeTextures.push(texture);
      const edge = new THREE.MeshStandardMaterial({ color: "#ffffff", map: texture, roughness: 0.95, metalness: 0 });
      // BoxGeometry groups: +x, -x, +y, -y, +z, -z.
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [side, side, top, top, edge, side]);
      mesh.castShadow = true;
      mesh.visible = false;
      this.book.add(mesh);
      return mesh;
    };
    this.blocks = { left: block(), right: block() };
    this.blocks.left.position.x = -0.5;
    this.blocks.right.position.x = 0.5;

    this.contactCanvas.width = 256;
    this.contactCanvas.height = 128;
    this.contactTexture = new THREE.CanvasTexture(this.contactCanvas);
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.contactTexture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.visible = false;
    this.book.add(this.contact);
  }

  /**
   * Fit the page blocks and the contact shadow to the stacks at the current
   * progress. Runs only when a stack's sheet count changes, so a turn costs
   * two updates and a settled book none.
   */
  private updateStacks() {
    const sheets = this.sheets;
    const { left, right, inFlight } = stackSheets(this.book.progress, sheets);
    const key = `${sheets}:${left}:${right}`;
    if (key === this.stacksKey) return;
    this.stacksKey = key;
    // The top of the left stack is sheet `left - 1`, of the right stack the
    // first unturned sheet not in flight; each block runs down `count` sheets.
    this.fitBlock(this.blocks.left, 0, left, -BOOK_SHEET_SPACING * (sheets - left + 1));
    this.fitBlock(this.blocks.right, 1, right, -BOOK_SHEET_SPACING * (sheets - right));

    const from = left > 0 ? -1 : 0;
    const to = right > 0 || inFlight ? 1 : 0;
    const contactKey = `${from}:${to}`;
    if (to - from <= 0) {
      this.contact.visible = false;
      return;
    }
    // World footprint, then the plane grows by the spread on every side.
    const width = (to - from) * this.pageWidth + 2 * CONTACT_SPREAD;
    const depth = 1 + 2 * CONTACT_SPREAD;
    if (contactKey !== this.contactKey) {
      this.contactKey = contactKey;
      paintContactShadow(this.contactCanvas, CONTACT_SPREAD / width, CONTACT_SPREAD / depth);
      this.contactTexture.needsUpdate = true;
    }
    this.contact.scale.set(width / this.pageWidth, depth, 1);
    this.contact.position.set((from + to) / 2, bookTableHeight(sheets) + CONTACT_LIFT, 0);
    this.contact.visible = true;
  }

  private fitBlock(mesh: THREE.Mesh, edgeIndex: number, count: number, topSheet: number) {
    const height = count * BOOK_SHEET_SPACING - BLOCK_TOP_GAP;
    mesh.visible = count > 0 && height > 0;
    if (!mesh.visible) return;
    mesh.scale.y = height;
    mesh.position.y = topSheet - BLOCK_TOP_GAP - height / 2;
    this.edgeTextures[edgeIndex].repeat.set(1, height / EDGE_TILE_HEIGHT);
  }

  private paperMaterial(map: THREE.Texture | null): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: "#ffffff", map, roughness: PAPER_ROUGHNESS, metalness: 0 });
    material.shadowSide = THREE.DoubleSide;
    return material;
  }

  /** One material per face; textures are attached and released later. */
  setFaceCount(count: number) {
    for (const material of this.faceMaterials) material.dispose();
    this.faceMaterials.length = 0;
    for (let face = 0; face < count; face += 1) this.faceMaterials.push(this.paperMaterial(null));
    this.book.setPages([...this.faceMaterials]);
    this.table.position.y = bookTableHeight(this.sheets);
    this.stacksKey = "";
    this.contactKey = "";
    this.updateStacks();
    this.updateFrame();
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

  /**
   * Attach (or release, with null) the front cover's material map: height in
   * R (bump), roughness in G, metalness in B. three.js multiplies the scalars
   * by the map, so they are 1 while the map is attached.
   */
  setCoverMaps(texture: THREE.Texture | null) {
    const material = this.faceMaterials[0];
    if (!material || material.bumpMap === texture) return;
    const hadMaps = material.bumpMap !== null;
    material.bumpMap = texture;
    material.roughnessMap = texture;
    material.metalnessMap = texture;
    material.bumpScale = COVER_BUMP_SCALE;
    material.roughness = texture ? 1 : PAPER_ROUGHNESS;
    material.metalness = texture ? 1 : 0;
    if (hadMaps !== (texture !== null)) material.needsUpdate = true;
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
    this.orientation = orientation;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.updateFrame();
  }

  /** The frame depends on the stage, the orientation and the book's thickness. */
  private updateFrame() {
    this.frameBox = bookFrame(this.cssWidth / this.cssHeight, this.pageWidth, this.orientation, this.sheets);
    this.applyCamera();
    this.requestRender();
  }

  private applyCamera() {
    this.camera.left = this.focus - this.frameBox.halfWidth;
    this.camera.right = this.focus + this.frameBox.halfWidth;
    this.camera.top = this.frameBox.top;
    this.camera.bottom = this.frameBox.bottom;
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
    return this.cssHeight / (this.frameBox.top - this.frameBox.bottom);
  }

  /** Screen x (stage CSS px) of the spine, or of the closed book's centre. */
  get spineX() {
    return this.cssWidth / 2 - this.focus * this.pixelsPerUnit;
  }

  get pageWidthPx() {
    return this.pageWidth * this.pixelsPerUnit;
  }

  /** On-screen height of a flat page, foreshortened by the tilt. */
  get pageHeightPx() {
    return Math.cos(BOOK_CAMERA_TILT) * this.pixelsPerUnit;
  }

  /**
   * Where a settled face lies on the stage, in CSS px. Each side rests at its
   * own stack height, which the tilt turns into a vertical offset.
   */
  faceRect(side: FaceSide): ScreenRect {
    return faceScreenRect({
      side,
      spread: Math.max(0, Math.min(this.sheets, Math.round(this.book.progress))),
      sheets: this.sheets,
      frame: this.frameBox,
      pixelsPerUnit: this.pixelsPerUnit,
      spineX: this.spineX,
      pageWidth: this.pageWidth,
    });
  }

  get progress() {
    return this.book.progress;
  }

  get sheets() {
    return this.book.totalPages / 2;
  }

  isSettled() {
    // A turn's first frame can leave progress on the old spread; the book has
    // settled only once it rests on the spread it was sent to.
    return !this.dragging && this.edge === null
      && Math.abs(this.book.progress - Math.round(this.book.progress)) < SETTLED_EPSILON
      && Math.ceil(this.book.currentPage / 2) === Math.round(this.book.progress)
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
    this.updateStacks();
    const pose = coverKeyLight(this.book.progress, this.reduced);
    this.key.position.set(pose.x, pose.y, pose.z);
    this.key.intensity = pose.intensity;
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
    for (const texture of this.edgeTextures) texture.dispose();
    this.contactTexture.dispose();
    for (const material of this.faceMaterials) material.dispose();
    this.blank.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
