export async function ensureNotifyReady(): Promise<boolean> { return false; }
export async function scheduleDailyReminder(_worldId: string | null, _count?: number): Promise<void> {}
export async function sendTestNotification(): Promise<string | null> { return '请在 App 中设置复习提醒'; }
export async function cancelReminders(): Promise<void> {}
export async function rescheduleForActiveWorld(): Promise<void> {}
