/** Five reusable rendering recipes. No image coordinates or subject names are baked in. */
export const PRESETS = Object.freeze({
  'ink-bloom': { id: 'ink-bloom', name: '触点墨晕', index: 0, duration: 3400, strength: 0.85, feather: 0.036, distortion: 0.2, angle: -12,
    description: '从触点形成不规则湿边，浓淡交叠，向外渗开。' },
  'guided-ribbon': { id: 'guided-ribbon', name: '循迹流染', index: 1, duration: 4200, strength: 0.7, feather: 0.03, distortion: 0.15, angle: -12,
    description: '沿可编辑路径行进，再由路径向两侧晕开；不做主体识别。' },
  'brush-sweep': { id: 'brush-sweep', name: '飞白笔触', index: 2, duration: 3400, strength: 0.85, feather: 0.014, distortion: 0, angle: -12,
    description: '多笔先后掠过，保留刷毛间隙、飞白与不齐的收笔。' },
  'fiber-soak': { id: 'fiber-soak', name: '纸纤维渗透', index: 3, duration: 4400, strength: 0.9, feather: 0.021, distortion: 0.12, angle: -12,
    description: '在程序化纤维介质里计算传播到达时间，形成分叉的湿润前沿。' },
  'mist-veil': { id: 'mist-veil', name: '雾绡退散', index: 4, duration: 4000, strength: 0.75, feather: 0.12, distortion: 0.4, angle: -12,
    description: '宽而柔和的半透明雾幕分层退去，过渡轻于墨晕。' }
});
export const DEFAULT_PATH = Object.freeze([[0.08,0.68],[0.26,0.6],[0.44,0.53],[0.61,0.42],[0.78,0.33],[0.92,0.24]]);
export const FLOW_VERSION = '1.0.0';
export function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
export function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}
export function validatePoint(point, name = 'point') {
  if (!Array.isArray(point) || point.length !== 2) throw new TypeError(`${name} must be [x, y].`);
  return [clamp(finite(point[0], name)), clamp(finite(point[1], name))];
}
export function validatePath(path) {
  if (!Array.isArray(path) || path.length < 2 || path.length > 16) throw new RangeError('path requires 2–16 normalized points.');
  const points = path.map((p,i) => validatePoint(p, `path[${i}]`));
  const length = points.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-points[i][0],p[1]-points[i][1]),0);
  if (length < 0.001) throw new RangeError('The path must have non-zero length.');
  return points;
}
export function validateOptions(input = {}, previous = {}) {
  const id = input.preset ?? previous.preset ?? 'ink-bloom';
  if (!Object.hasOwn(PRESETS, id)) throw new RangeError(`Unknown flow: ${id}`);
  const base = {...PRESETS[id], origin:[0.5,0.5], path: DEFAULT_PATH.map(p=>[...p]), seed: 17,
    fit:'contain', background:'#101917', respectReducedMotion:true, maxDpr:1.5,
    maxPixels:1600000, maxTextureSize:2048, ...previous, ...input, preset:id};
  const ranges = { duration:[100,60000],strength:[0,2],feather:[0.003,0.22],distortion:[0,2],angle:[-180,180],
    maxDpr:[0.5,3],maxPixels:[64000,16777216],maxTextureSize:[64,8192] };
  for (const [key,[lo,hi]] of Object.entries(ranges)) base[key] = clamp(finite(base[key],key),lo,hi);
  base.seed = Math.floor(finite(base.seed,'seed')) >>> 0;
  base.origin = validatePoint(base.origin, 'origin');
  base.path = validatePath(base.path);
  if (!['contain','cover'].includes(base.fit)) throw new RangeError('fit must be contain or cover.');
  if (!/^#[0-9a-fA-F]{6}$/.test(base.background)) throw new TypeError('background must use #RRGGBB.');
  base.respectReducedMotion = Boolean(base.respectReducedMotion);
  return base;
}
