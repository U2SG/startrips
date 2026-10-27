import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { font, tnum, useTheme } from '../theme';
import { Track } from './BookPlayer';
import { shelf } from './offline';
import { completePages, type DownloadedBook } from './offlineStore';
import { getBook, getDownload, reset, subscribeDownload } from './runtime';

export function availablePages(book: DownloadedBook) {
  return completePages(book).map(([, page]) => page);
}
export function OfflineLibrary({ onClose, onOpen }: { onClose(): void; onOpen(book: DownloadedBook): void }) {
  const { ink } = useTheme();
  const [books, setBooks] = useState<DownloadedBook[] | null>(null);
  const [error, setError] = useState('');
  const download = useSyncExternalStore(subscribeDownload, getDownload);
  const [removing, setRemoving] = useState(false);
  const refresh = () => shelf().list().then((items) => setBooks([...items])).catch((e: Error) => setError(e.message));
  useEffect(() => { void refresh(); }, [download.active]);
  const row = { minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' as const };
  return <View style={{ flex: 1, backgroundColor: ink.canvas }} testID="offline-library">
    <View style={{ minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onClose} style={row}><Text style={{ color: ink.fg, fontSize: 24 }}>‹</Text></Pressable>
      <Text style={{ color: ink.fg, fontFamily: font.bold, fontSize: 22 }}>离线书库</Text>
    </View>
    {error ? <Text accessibilityRole="alert" style={{ color: ink.red, padding: 16 }}>{error}</Text> : null}
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {!books ? <ActivityIndicator color={ink.accent} /> : !books.length ? <Text style={{ color: ink.muted }}>还没有下载的教材</Text> : null}
      {books?.map((book) => {
        const pages = new Set(availablePages(book).map((page) => page.page));
        const closed = !pages.size || removing;
        // The open target and 删除 are siblings, so deleting can never open the book.
        return <View key={book.id} style={{ backgroundColor: ink.raised, borderRadius: 16, flexDirection: 'row', alignItems: 'center' }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`离线听：${book.textbook.title}`} accessibilityHint={`已下载 ${pages.size} / ${book.textbook.numPages} 页`}
            disabled={closed} aria-disabled={closed} onPress={() => onOpen(book)}
            style={({ pressed }) => ({ flex: 1, minHeight: 72, padding: 16, gap: 10, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: pages.size ? ink.fg : ink.muted, fontFamily: font.med, fontSize: 17 }}>{book.textbook.title}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Track ratio={book.textbook.numPages ? pages.size / book.textbook.numPages : 0} height={2} style={{ flex: 1 }} />
              <Text style={{ color: ink.muted, fontSize: 12, ...tnum }}>{pages.size}/{book.textbook.numPages}</Text>
            </View>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`删除下载：${book.textbook.title}`} disabled={download.active || removing} aria-disabled={download.active || removing} style={row} onPress={() => {
            setRemoving(true); setError('');
            const active = getBook();
            if (active?.worldId === book.worldId && active.textbook.id === book.textbook.id) reset();
            void shelf().remove(book.id).then(refresh).catch((e: Error) => setError(e.message)).finally(() => setRemoving(false));
          }}><Text style={{ color: ink.red }}>删除</Text></Pressable>
        </View>;
      })}
    </ScrollView>
  </View>;
}
