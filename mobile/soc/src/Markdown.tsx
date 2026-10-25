// 轻量 markdown 渲染：粗体 / 斜体（角色动作神态）/ 行内代码 / 围栏代码块 / 列表 / 小标题。
// 上课与群聊的 LLM 输出都按桌面版习惯带这些标记。
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font, Ink, radius, space, type_, useTheme } from './theme';

type Styles = ReturnType<typeof makeStyles>;

function renderInline(text: string, baseStyle: object, s: Styles, keyPrefix: string): React.ReactNode[] {
  // 按 **bold** / *italic* / `code` 切分
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((p, i) => {
    const key = `${keyPrefix}-${i}`;
    if (p.startsWith('**') && p.endsWith('**')) {
      return <Text key={key} style={[baseStyle, s.bold]}>{p.slice(2, -2)}</Text>;
    }
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
      return <Text key={key} style={[baseStyle, s.action]}>{p.slice(1, -1)}</Text>;
    }
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return <Text key={key} style={[baseStyle, s.inlineCode]}>{p.slice(1, -1)}</Text>;
    }
    return <Text key={key} style={baseStyle}>{p}</Text>;
  });
}

export default function Markdown({ text, color }: { text: string; color?: string }) {
  const { ink } = useTheme();
  const s = useMemo(() => makeStyles(ink), [ink]);
  const baseStyle = { ...s.p, ...(color ? { color } : null) };
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const t = para.join('\n');
    blocks.push(
      <Text key={`p${key++}`} style={baseStyle}>
        {renderInline(t, baseStyle, s, `p${key}`)}
      </Text>,
    );
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过结尾围栏
      blocks.push(
        <View key={`c${key++}`} style={s.codeBlock}>
          <Text style={s.codeText}>{code.join('\n')}</Text>
        </View>,
      );
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flushPara();
      blocks.push(
        <Text key={`h${key++}`} style={[baseStyle, s.heading]}>
          {renderInline(h[2], { ...baseStyle, ...s.heading }, s, `h${key}`)}
        </Text>,
      );
      i++;
      continue;
    }

    const li = line.match(/^\s*(?:[-•]|\d+[.、])\s+(.*)/);
    if (li) {
      flushPara();
      blocks.push(
        <View key={`l${key++}`} style={s.listRow}>
          <Text style={[baseStyle, s.listDot]}>·</Text>
          <Text style={[baseStyle, { flex: 1 }]}>{renderInline(li[1], baseStyle, s, `l${key}`)}</Text>
        </View>,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();

  return <View style={{ gap: space(1) }}>{blocks}</View>;
}

const makeStyles = (ink: Ink) => StyleSheet.create({
  p: { fontSize: type_.body, color: ink.fg, lineHeight: 24, fontFamily: font.sans },
  bold: { fontFamily: font.sansBold },
  action: { color: ink.muted },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: type_.small,
    backgroundColor: ink.sunken,
    color: ink.fg,
  },
  heading: { fontFamily: font.sansBold, fontSize: type_.body, marginTop: space(0.5) },
  codeBlock: {
    backgroundColor: ink.sunken,
    borderRadius: radius.lg,
    padding: space(1.5),
  },
  codeText: { fontFamily: font.mono, fontSize: type_.small, color: ink.fg, lineHeight: 20 },
  listRow: { flexDirection: 'row', gap: space(1) },
  listDot: { color: ink.muted },
});
