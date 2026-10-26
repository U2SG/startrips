// Startrips' HttpOnly cookie owns browser authentication.
export async function readToken(_origin: string): Promise<string> { return ''; }
export async function writeToken(_origin: string, _token: string): Promise<void> {}
export type OfflineUser = { id: string; name: string; email: string };
export async function readOfflineUser(_origin: string): Promise<OfflineUser | null> { return null; }
export async function writeOfflineUser(_origin: string, _user: OfflineUser | null): Promise<void> {}
