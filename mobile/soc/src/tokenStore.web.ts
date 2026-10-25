// Startrips' HttpOnly cookie owns browser authentication.
export async function readToken(_origin: string): Promise<string> { return ''; }
export async function writeToken(_origin: string, _token: string): Promise<void> {}
