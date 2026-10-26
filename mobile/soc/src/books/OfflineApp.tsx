import React, { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OfflineLibrary } from './OfflineLibrary';
import { BookPlayer } from './BookPlayer';
import { openOffline } from './runtime';
import type { DownloadedBook } from './offlineStore';

/** Cached identity opens only local downloads; it never creates an online session. */
export function OfflineApp({ onClose }: { onClose(): void }) {
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<DownloadedBook | null>(null);
  async function open(book: DownloadedBook) {
    setTarget(book); setExpanded(true); setBusy(true); setError('');
    try { await openOffline(book); }
    catch (e) { setError(e instanceof Error ? e.message : '离线听书打开失败'); }
    finally { setBusy(false); }
  }
  return <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
    <OfflineLibrary onClose={onClose} onOpen={(book) => void open(book)} />
    <BookPlayer expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} busy={busy} error={error} retry={() => { if (target) void open(target); }} />
  </View>;
}
