export type PresetId = 'ink-bloom' | 'guided-ribbon' | 'brush-sweep' | 'fiber-soak' | 'mist-veil';
export type Point = [number, number];
export type ImageSource = string | Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap;
export interface FlowOptions {
  container: HTMLElement | string;
  from?: ImageSource; to?: ImageSource;
  /** Inject `import * as THREE from 'three'` to use Three.js. Omit for native WebGL2. */
  THREE?: unknown;
  preset?: PresetId; duration?: number; strength?: number; feather?: number;
  distortion?: number; angle?: number; origin?: Point; path?: Point[]; seed?: number;
  fit?: 'contain' | 'cover'; background?: string; respectReducedMotion?: boolean;
  maxDpr?: number; maxPixels?: number; maxTextureSize?: number; fallback?: boolean;
}
export interface FlowConfig {
  schema: 'startrips.reveal-flow/v1'; version: string; preset: PresetId;
  duration: number; strength: number; feather: number; distortion: number; angle: number;
  origin: Point; path: Point[]; seed: number; fit: 'contain' | 'cover'; background: string;
  respectReducedMotion: boolean; maxDpr: number; maxPixels: number; maxTextureSize: number;
}
export interface Preset {
  id: PresetId; name: string; index: number; duration: number; strength: number;
  feather: number; distortion: number; angle: number; description: string;
}
export declare const PRESETS: Readonly<Record<PresetId, Preset>>;
export declare const FLOW_VERSION: string;
export declare class RevealFlow extends EventTarget {
  constructor(options: FlowOptions);
  readonly ready: Promise<RevealFlow>;
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  readonly backendName: string;
  readonly imageInfo: {from:{width:number;height:number};to:{width:number;height:number}} | null;
  readonly options: FlowOptions & FlowConfig;
  readonly playing: boolean;
  readonly progress: number;
  readonly disposed: boolean;
  readonly warning?: string;
  setImages(from: ImageSource, to: ImageSource): Promise<boolean>;
  configure(changes: Partial<Omit<FlowOptions,'container'|'from'|'to'|'THREE'>>): this;
  setPreset(preset: PresetId): this;
  setOrigin(point: Point): this;
  setPath(path: Point[]): this;
  prepare(): Promise<void>;
  /** Resolves when preparation finishes and playback starts, NOT when it ends. Use the complete event. */
  play(options?: {origin?:Point;reverse?:boolean;from?:number}): Promise<void>;
  pause(): this;
  resume(): Promise<void>;
  reverse(): Promise<void>;
  reset(): this;
  seek(progress: number): this;
  resize(): void;
  render(): void;
  toJSON(): FlowConfig;
  applyConfig(config: FlowConfig): this;
  snapshot(type?: string, quality?: number): Promise<Blob>;
  dispose(): void;
}
