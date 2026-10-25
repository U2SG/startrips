// src/components/TabIcon.tsx — 零依赖几何图标（用 View 拼）
import React from 'react';
import { View } from 'react-native';

export type TabName = '教材' | '上课' | '群聊' | '闪卡' | '设置';

export function TabIcon({ name, color }: { name: TabName; color: string }) {
  switch (name) {
    case '教材': // 书：左脊加粗的矩形
      return <View style={{ width: 16, height: 19, borderWidth: 2, borderColor: color, borderLeftWidth: 5, borderRadius: 3 }} />;
    case '上课': // 对话气泡：左下尖角
      return <View style={{ width: 20, height: 16, borderWidth: 2, borderColor: color, borderRadius: 7, borderBottomLeftRadius: 1 }} />;
    case '群聊': // 两个交叠的圆
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: color, marginRight: -4 }} />
          <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: color }} />
        </View>
      );
    case '闪卡': // 两张错位叠卡
      return (
        <View style={{ width: 20, height: 20 }}>
          <View style={{ position: 'absolute', top: 0, left: 5, width: 13, height: 16, borderWidth: 2, borderColor: color, borderRadius: 3 }} />
          <View style={{ position: 'absolute', top: 3, left: 0, width: 13, height: 16, borderWidth: 2, borderColor: color, borderRadius: 3 }} />
        </View>
      );
    case '设置': // 两条带滑钮的横线
      return (
        <View style={{ gap: 4 }}>
          <View style={{ width: 18, height: 2, backgroundColor: color, alignItems: 'flex-end' }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginTop: -2.5, marginRight: 3 }} />
          </View>
          <View style={{ width: 18, height: 2, backgroundColor: color, alignItems: 'flex-start' }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginTop: -2.5, marginLeft: 3 }} />
          </View>
        </View>
      );
  }
}
