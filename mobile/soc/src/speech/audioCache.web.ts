// Browser media playback uses the provider's short-lived HTTPS URL.
// Native builds retain the on-disk cache for background playback.
export async function cacheAudio(url: string, _name: string): Promise<string> { return url; }
export function removeAudio(_uri: string) {}
