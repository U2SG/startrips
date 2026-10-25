// src/components/Avatar.tsx — 彩色首字头像（上课头部 + 群聊 + 交接卡共用）
// v1.1：实色圆 + 白字 + 左上光泽，贴近 Apple Glass 设计稿。
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font } from '../theme';

export function Avatar({ name, color, size = 32 }: { name: string; color?: string; size?: number }) {
  const bg = color || '#6f7bd6';
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2, backgroundColor: bg,
      overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    }}>
      <LinearGradient
        colors={['rgba(255,255,255,0.42)', 'rgba(255,255,255,0)']}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Text style={{ fontFamily: font.bold, fontSize: size * 0.46, color: '#fff' }}>
        {Array.from(name)[0] || '?'}
      </Text>
    </View>
  );
}
