import { sessionGuard } from './api';
// 群聊：学习者发言后，由 LLM 以各 NPC 口吻续聊，追加到 recent.md（桌面版同格式）。
import * as data from './data';
import { chatJson } from './llm';
import type { Companion, LlmProfile } from './data';

function learnerName(profileMd: string | null): string {
  const m = profileMd?.match(/\*\*姓名\*\*：(.+)/);
  return m ? m[1].trim() : '我';
}

export async function loadGroupChat(worldId: string) {
  const [messages, profileMd, meta] = await Promise.all([
    data.readGroupChat(worldId),
    data.readLearnerProfile(worldId),
    data.readWorldMeta(worldId).catch(() => null),
  ]);
  const colors: Record<string, string> = {};
  for (const c of meta?.companions || []) {
    if (c?.name && c.color) colors[c.name] = c.color;
  }
  return { messages, learner: learnerName(profileMd), colors };
}

/** 学习者发一条消息，NPC 们回应 1-3 条；全部追加进 recent.md */
export async function sendGroupMessage(
  worldId: string,
  profile: LlmProfile,
  userText: string,
): Promise<data.GroupMessage[]> {
  const assertSession = sessionGuard();
  const meta = await data.readWorldMeta(worldId);
  const companions = meta.companions.filter((c): c is NonNullable<Companion> => !!c);
  if (!companions.length) throw new Error('这个世界没有伙伴');

  const [history, lastSummary, profileMd] = await Promise.all([
    data.readGroupChat(worldId),
    data.latestLessonSummary(worldId),
    data.readLearnerProfile(worldId),
  ]);
  const me = learnerName(profileMd);
  const now = new Date();

  assertSession();

  await data.appendGroupChat(worldId, [{ speaker: me, text: userText }], now);

  const personas = await Promise.all(
    ['npc_a', 'npc_b', 'npc_c'].slice(0, companions.length).map((s) => data.readNpc(worldId, s)),
  );
  const recent = history.slice(-40).map((m) => `[${m.time}] ${m.speaker}：${m.text}`).join('\n');

  const replies = await chatJson<{ speaker: string; text: string }[]>(profile, [
    {
      role: 'system',
      content: [
        '你在扮演 Socratopia 学习世界群聊里的全部 NPC 成员。学习者刚发了一条消息，请以最合适的 1-3 位 NPC 的口吻回应。',
        '要求：口语化、短句、符合各自人设、不要彩虹屁、不要重复历史内容。只输出 JSON 数组：[{"speaker":"名字","text":"内容"}]。',
        '',
        ...companions.map((c, i) => `## NPC：${c.name}（${c.bio}）\n${(personas[i] || '').slice(0, 1500)}`),
        lastSummary ? `## 最近一节课小结\n${lastSummary.slice(0, 1200)}` : '',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `群聊最近记录：\n${recent}\n\n[${data.groupTimestamp(now)}] ${me}：${userText}\n\n请生成 NPC 回应。`,
    },
  ]);

  const valid = (Array.isArray(replies) ? replies : [])
    .filter((r) => r.speaker && r.text && companions.some((c) => c.name === r.speaker))
    .slice(0, 3);
  if (valid.length) {
    assertSession();
    await data.appendGroupChat(worldId, valid, new Date(now.getTime() + 5000));
  }
  return data.readGroupChat(worldId);
}
