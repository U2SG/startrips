// src/haptics.ts — 触感反馈（expo-haptics 已装；不要触感就删本文件与调用）
import * as Haptics from 'expo-haptics';

export const haptic = {
  ok: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  bad: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}),
};
