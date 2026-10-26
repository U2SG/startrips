type Owner = 'speech' | 'book' | 'preview';
const handlers = new Map<Owner, Set<() => void>>();
export function registerAudioFocus(owner: Owner, pause: () => void) {
  if (!handlers.has(owner)) handlers.set(owner, new Set());
  handlers.get(owner)!.add(pause);
  return () => { handlers.get(owner)?.delete(pause); };
}
export function claimAudioFocus(owner: Owner) { for (const [other, callbacks] of handlers) if (other !== owner) callbacks.forEach((pause) => pause()); }
