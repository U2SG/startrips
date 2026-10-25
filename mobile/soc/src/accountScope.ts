let identity = '';
let generation = 0;
export function activateAccountScope(next: string) {
  if (identity !== next) { identity = next; generation += 1; }
}
export function accountGeneration() { return generation; }
export function sessionGuard() {
  const captured = generation;
  if (!identity) throw new Error('请先登录');
  return () => { if (!identity || captured !== generation) throw new Error('账号已切换，请重新打开这节课'); };
}
