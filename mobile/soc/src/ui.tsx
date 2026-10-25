import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { font, Ink, radius, space, type_, useTheme } from './theme';

export function Btn(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'plain' | 'danger';
  small?: boolean;
  serif?: boolean;
}) {
  const { label, onPress, disabled, kind = 'plain', small, serif } = props;
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        small ? s.btnSmall : null,
        kind === 'primary' && { backgroundColor: ink.accent, borderColor: ink.accent },
        kind === 'danger' && { borderColor: ink.border, backgroundColor: ink.raised },
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text
        style={[
          s.btnText,
          serif && { fontFamily: font.serif },
          small ? { fontSize: type_.small } : null,
          kind === 'primary' && { color: '#fff' },
          kind === 'danger' && { color: ink.red },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Header(props: { title: string; right?: React.ReactNode; subtitle?: string }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  return (
    <View style={s.header}>
      <View style={{ flex: 1 }}>
        <Text style={s.headerTitle} numberOfLines={1}>{props.title}</Text>
        {props.subtitle ? <Text style={s.headerSub} numberOfLines={1}>{props.subtitle}</Text> : null}
      </View>
      {props.right}
    </View>
  );
}

export function Busy(props: { text: string }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  return (
    <View style={s.busy}>
      <ActivityIndicator color={ink.accent} size="small" />
      <Text style={s.busyText}>{props.text}</Text>
    </View>
  );
}

export function ErrorNote(props: { text: string }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  if (!props.text) return null;
  return (
    <View style={s.errorBox}>
      <Text style={s.errorText}>{props.text}</Text>
    </View>
  );
}

export function Card(props: { children: React.ReactNode; style?: object }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  return <View style={[s.card, props.style]}>{props.children}</View>;
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderColor: ink.border,
    backgroundColor: ink.raised,
    borderRadius: radius.xl,
    paddingHorizontal: space(2.5),
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnSmall: { minHeight: 36, paddingHorizontal: space(2) },
  btnText: { color: ink.fg, fontSize: type_.body, fontFamily: font.sansMed },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(2),
    paddingVertical: space(1.5),
    backgroundColor: ink.canvas,
    borderBottomWidth: 1,
    borderBottomColor: ink.border,
    gap: space(1),
  },
  headerTitle: { fontSize: type_.title, color: ink.fg, fontFamily: font.serif },
  headerSub: { fontSize: type_.small, color: ink.muted, marginTop: 2, fontFamily: font.sans },
  busy: { flexDirection: 'row', alignItems: 'center', gap: space(1), paddingHorizontal: space(2), paddingVertical: space(1.5) },
  busyText: { color: ink.muted, fontSize: type_.small, fontFamily: font.sans },
  errorBox: {
    backgroundColor: ink.redSoft,
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.25)',
    borderRadius: radius.lg,
    padding: space(1.5),
    marginHorizontal: space(2),
    marginTop: space(1),
  },
  errorText: { color: ink.red, fontSize: type_.small, lineHeight: 19, fontFamily: font.sans },
  card: {
    backgroundColor: ink.raised,
    borderWidth: 1,
    borderColor: ink.border,
    borderRadius: radius.xxl,
    padding: space(2),
  },
});
