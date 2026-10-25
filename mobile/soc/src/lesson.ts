import { MissingLessonDataError } from './lessonRecovery';
// 上课 / 下课核心编排：提示词装配与课后更新管线。
// 写入的所有文件与桌面版格式一致，保证两端接续上课。
// 与桌面版同规则：一节课没下课就不能开新课——进行中的课通过指针持久化，重启后恢复继续。
import AsyncStorage from './storage';
import * as api from './api';
import * as data from './data';
import { chatJson, chatStream, LlmMessage } from './llm';
import type { Chat, Companion, HandoffMeta, LlmProfile, TextbookEntry, WorldMeta } from './data';

const WINDOW_SIZE = 18; // 每节课加载的教材页数窗口（桌面版约 19 页）

// ---------- 进行中课程指针（下课前不允许开新课） ----------

export type LessonPointer = { worldId: string; textbookId: string; convId: string };

const POINTER_KEY = 'socratopia.activeLesson';

export async function loadLessonPointer(): Promise<LessonPointer | null> {
  const raw = await AsyncStorage.getItem(POINTER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function saveLessonPointer(p: LessonPointer): Promise<void> {
  await AsyncStorage.setItem(POINTER_KEY, JSON.stringify(p));
}

export async function clearLessonPointer(): Promise<void> {
  await AsyncStorage.removeItem(POINTER_KEY);
}

export type LessonContext = {
  assertSession: () => void;
  controller: AbortController;
  worldId: string;
  textbook: TextbookEntry;
  chat: Chat;
  companion: NonNullable<Companion>;
  companionSlot: string;
  windowStart: number;
  windowEnd: number;
  systemPrompt: string;
  startedAt: string; // 本次落座开始（ISO），仅用于计时，不落盘
};

function lessonScope() {
  const guard = api.sessionGuard();
  const controller = new AbortController();
  return { controller, assertSession: () => {
    guard();
    if (controller.signal.aborted) throw new Error('这节课已取消，请重新打开');
  } };
}

function companionBySlot(meta: WorldMeta, slot: string): NonNullable<Companion> | null {
  const idx = { npc_a: 0, npc_b: 1, npc_c: 2 }[slot];
  if (idx === undefined) return null;
  return meta.companions[idx] ?? null;
}

function buildSystemPrompt(args: {
  rules: string;
  persona: string | null;
  companion: NonNullable<Companion>;
  learner: string | null;
  handoff: { meta: HandoffMeta | null; tail: data.HandoffTail | null };
  textbook: TextbookEntry;
  windowStart: number;
  windowEnd: number;
  windowText: string;
}): string {
  const { rules, persona, companion, learner, handoff, textbook, windowStart, windowEnd, windowText } = args;
  const tailText = handoff.tail?.messages
    ?.map((m) => `${m.role === 'user' ? '学习者' : companion.name}：${m.content}`)
    .join('\n');
  return [
    rules,
    `\n---\n\n# 你的角色设定\n\n${persona || `你是${companion.name}，${companion.bio}。`}`,
    `\n---\n\n# 学习者档案\n\n${learner || '（尚无档案）'}`,
    handoff.meta && tailText
      ? `\n---\n\n# 上次课交接\n\n上次课由 ${handoff.meta.companionName} 上到第 ${handoff.meta.endingPage} 页（${handoff.meta.savedAt.slice(0, 10)}）。结尾对话：\n\n${tailText}`
      : '',
    `\n---\n\n# 本节课教材内容（《${textbook.title}》第 ${windowStart}-${windowEnd} 页）\n\n${windowText}`,
    `\n---\n\n# 本节课要求\n\n- 教学语言：中文。始终保持角色，用角色的口吻说话，可以用 *斜体* 描写神态动作。\n- 严格基于上面的教材窗口推进，引用教材时报页码；窗口之外的内容不要展开。\n- 遵守苏格拉底教学规则：提问驱动，不直接灌输结论。`,
  ].filter(Boolean).join('\n');
}

/** 列出这个世界可选的授课老师（非空 slot），给开课前的选择器用 */
export async function listTeachers(worldId: string): Promise<{ slot: string; companion: NonNullable<Companion> }[]> {
  const meta = await data.readWorldMeta(worldId);
  const slots = ['npc_a', 'npc_b', 'npc_c'];
  return meta.companions
    .map((c, i) => ({ slot: slots[i], companion: c }))
    .filter((x): x is { slot: string; companion: NonNullable<Companion> } => !!x.companion);
}

/** 开始一节课：定位页码窗口、提取教材文本、写 current_reading.md、装配 system prompt。
 *  preferSlot 给定且该 slot 有老师时用它开课（手动换老师）；否则沿用上次交接的老师。 */
export async function startLesson(
  worldId: string,
  textbook: TextbookEntry,
  onStatus: (s: string) => void,
  preferSlot?: string,
): Promise<LessonContext> {
  const { assertSession, controller } = lessonScope();
  onStatus('读取世界与交接…');
  const [meta, rules, learner, handoff, preface, progressMd] = await Promise.all([
    data.readWorldMeta(worldId),
    data.readRules(),
    data.readLearnerProfile(worldId),
    data.readHandoff(worldId, textbook),
    data.readPreface(worldId, textbook),
    data.readProgress(worldId, textbook),
  ]);

  // 老师选择：手动指定的 slot 优先（且该 slot 确有老师），否则沿用上次交接的 slot
  let slot = (preferSlot && companionBySlot(meta, preferSlot)) ? preferSlot : (handoff.meta?.companionSlot || 'npc_a');
  let companion = companionBySlot(meta, slot);
  if (!companion) {
    const i = meta.companions.findIndex(Boolean);
    if (i < 0) throw new Error('这个世界没有可用的学习伙伴');
    slot = ['npc_a', 'npc_b', 'npc_c'][i];
    companion = meta.companions[i]!;
  }
  const persona = await data.readNpc(worldId, slot);

  // 页码窗口：进度页（progress.md 优先，其次 index.currentPage）+1 开始；新书从正文起始页开始
  const progressPage = data.parseProgressPage(progressMd) ?? textbook.currentPage;
  const windowStart = progressPage > 0 ? progressPage + 1 : preface?.contentStartPage || 1;
  const windowEnd = Math.min(windowStart + WINDOW_SIZE - 1, textbook.numPages);
  if (windowStart > textbook.numPages) throw new Error('这本教材已经读完了');

  onStatus(`提取教材第 ${windowStart}-${windowEnd} 页…`);
  const pdfPath = await data.textbookPdfPath(worldId, textbook);
  const extracted = await api.extractPdf(pdfPath, windowStart, windowEnd);

  const profileId = (await data.profileBase()).split('/').pop()!;
  const chat: Chat = {
    id: data.nanoid(),
    createdAt: new Date().toISOString(),
    character: slot,
    title: `${textbook.title.slice(0, 8)}… (${new Date().toISOString().slice(5, 10)})`,
    messages: [],
    worldId,
    profileId,
    textbookTitle: textbook.title,
    textbookId: textbook.id,
    companionCandidateId: companion.candidateId,
  };

  onStatus('写入课程上下文…');
  assertSession();
  await data.writeCurrentReading(worldId, chat.id, windowStart, windowEnd, extracted.pages);
  assertSession();
  await data.writeChat(worldId, chat);
  assertSession();
  await saveLessonPointer({ worldId, textbookId: textbook.id, convId: chat.id });

  const windowText = extracted.pages.map((p) => `--- 第 ${p.page} 页 ---\n${p.text}`).join('\n\n');
  const systemPrompt = buildSystemPrompt({
    rules, persona, companion, learner, handoff, textbook, windowStart, windowEnd, windowText,
  });

  return {
    assertSession, controller, worldId, textbook, chat, companion, companionSlot: slot, windowStart, windowEnd, systemPrompt,
    startedAt: new Date().toISOString(),
  };
}

/** 恢复一节未下课的课：从 chats + current_reading.md 重建上下文，继续对话 */
export async function resumeLesson(
  pointer: LessonPointer,
  onStatus: (s: string) => void,
): Promise<LessonContext> {
  const { assertSession, controller } = lessonScope();
  const { worldId, convId } = pointer;
  onStatus('恢复未下课的课…');
  const idx = await data.readTextbookIndex(worldId);
  const textbook = idx.textbooks.find((t) => t.id === pointer.textbookId);
  if (!textbook) throw new MissingLessonDataError('找不到这节课对应的教材');

  const [chat, reading, meta, rules, learner, handoff] = await Promise.all([
    data.readChat(worldId, convId),
    data.readCurrentReading(worldId, convId),
    data.readWorldMeta(worldId),
    data.readRules(),
    data.readLearnerProfile(worldId),
    data.readHandoff(worldId, textbook),
  ]);
  if (!reading) throw new MissingLessonDataError('这节课的教材窗口（current_reading.md）丢失');

  const slot = chat.character || 'npc_a';
  const companion = companionBySlot(meta, slot);
  if (!companion) throw new MissingLessonDataError('这节课的学习伙伴已不存在');
  const persona = await data.readNpc(worldId, slot);

  const systemPrompt = buildSystemPrompt({
    rules, persona, companion, learner, handoff, textbook,
    windowStart: reading.startPage, windowEnd: reading.endPage, windowText: reading.body,
  });

  return {
    assertSession, controller, worldId, textbook, chat, companion, companionSlot: slot,
    windowStart: reading.startPage, windowEnd: reading.endPage, systemPrompt,
    startedAt: new Date().toISOString(), // 恢复 = 新一次落座，计本次时长
  };
}

/** 发送一条消息并流式接收回复；自动持久化 chats/<id>.json */
export async function sendLessonMessage(
  ctx: LessonContext,
  profile: LlmProfile,
  userText: string,
  onDelta: (full: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const assertSession = ctx.assertSession;
  assertSession();
  const now = new Date().toISOString();
  ctx.chat.messages.push({ id: data.nanoid(), role: 'user', content: userText, timestamp: now });

  const messages: LlmMessage[] = [
    { role: 'system', content: ctx.systemPrompt },
    ...ctx.chat.messages.map((m) => ({ role: m.role, content: m.content }) as LlmMessage),
  ];
  const reply = await chatStream(profile, messages, (_d, full) => onDelta(full), [ctx.controller.signal, ...(signal ? [signal] : [])]);
  ctx.chat.messages.push({ id: data.nanoid(), role: 'assistant', content: reply, timestamp: new Date().toISOString() });
  assertSession();
  await data.writeChat(ctx.worldId, ctx.chat);
}

// ---------- 下课管线 ----------

type WrapupResult = {
  endingPage: number;
  topics: string;
  lessonSummary: string;
  progressParagraph: string;
  flashcards: { question: string; choices: string[]; correctIndex: number; explanation: string; chapter: string }[];
  groupchatLines: { speaker: string; text: string }[];
  learnerProfilePatch: string;
};

// 下课断点：LLM 结果 + 已完成的非幂等步骤。中途断网/被冻结后重试：
// 跳过贵的 LLM 调用，且 progress 段落/闪卡/群聊/档案这些 append 型步骤不重复写。
// （summary/handoff/index 是覆盖写，天然幂等，不用记。）
type EndCheckpoint = {
  wrap: WrapupResult;
  done: { progress?: boolean; flashcards?: boolean; learner?: boolean; groupchat?: boolean };
};

const endCheckpointKey = (convId: string) => `socratopia.endLesson/${convId}`;

function transcript(chat: Chat, companionName: string): string {
  return chat.messages.map((m) => `${m.role === 'user' ? '学习者' : companionName}：${m.content}`).join('\n\n');
}

/** 下课：一次结构化 LLM 调用产出全部课后材料，然后逐项落盘（格式与桌面版一致） */
export async function endLesson(
  ctx: LessonContext,
  profile: LlmProfile,
  onStatus: (s: string) => void,
): Promise<{ endingPage: number }> {
  const assertSession = ctx.assertSession;
  assertSession();
  if (!ctx.chat.messages.length) throw new Error('这节课还没有任何对话');

  const meta = await data.readWorldMeta(ctx.worldId);
  const learner = await data.readLearnerProfile(ctx.worldId);
  const others = meta.companions.filter((c): c is NonNullable<Companion> => !!c && c.name !== ctx.companion.name);

  // 断点恢复：上次下课中途失败的话，直接用存下的 LLM 结果续跑
  const ckKey = endCheckpointKey(ctx.chat.id);
  let checkpoint: EndCheckpoint | null = null;
  try {
    const raw = await AsyncStorage.getItem(ckKey);
    if (raw) checkpoint = JSON.parse(raw);
  } catch { /* 断点损坏当作没有，重新生成 */ }

  let wrap: WrapupResult;
  const done = checkpoint?.done ?? {};
  const saveCheckpoint = () => {
    assertSession();
    return AsyncStorage.setItem(ckKey, JSON.stringify({ wrap, done } satisfies EndCheckpoint));
  };

  if (checkpoint) {
    onStatus('恢复上次的课后总结…');
    wrap = checkpoint.wrap;
  } else {
    onStatus('生成课后总结…');
    // 拆 3 路并行：单次大 JSON 输出 ~2000 token 串行生成是「下课慢」的主因，
    // 并行后总耗时 ≈ 最慢一路（输入重复三份，换时延；BYOK 成本可接受）
    const sys = '你是 Socratopia 的课后整理器。根据本节课对话生成课后材料。只输出一个 JSON 对象，不要任何其它文字。';
    const context = [
      `教材：《${ctx.textbook.title}》，本节课加载窗口为第 ${ctx.windowStart}-${ctx.windowEnd} 页。`,
      `授课伙伴：${ctx.companion.name}（${ctx.companion.bio}）。`,
      `学习者档案：\n${learner || '（无）'}`,
      `本节课对话记录：\n${transcript(ctx.chat, ctx.companion.name)}`,
    ].join('\n');
    const ask = (spec: string[]) => [
      { role: 'system' as const, content: sys },
      { role: 'user' as const, content: [context, '', '请输出 JSON：', '{', ...spec, '}'].join('\n') },
    ];
    const batch = new AbortController();
    const cancellation = [ctx.controller.signal, batch.signal];
    const [core, cards, social] = await Promise.all([
      chatJson<Pick<WrapupResult, 'endingPage' | 'topics' | 'lessonSummary' | 'progressParagraph'>>(profile, ask([
        ' "endingPage": 本节课实际推进到的页码（整数，介于窗口起止之间，按对话实际覆盖内容判断）,',
        ' "topics": "本节课主题关键词，顿号分隔，15 字内",',
        ' "lessonSummary": "2-3 段课程小结：学习者掌握了什么、卡在哪里、推进路径（第三人称，称\'学习者\'）",',
        ' "progressParagraph": "1 段教学交接记录：下一位老师需要知道的掌握情况与薄弱点（第一人称，以授课伙伴口吻）"',
      ]), cancellation),
      chatJson<Pick<WrapupResult, 'flashcards'>>(profile, ask([
        ' "flashcards": [4 道复习选择题 {"question","choices":[4 个选项],"correctIndex":0-3,"explanation","chapter":"所属章节名"}，考察本节课易错点]',
      ]), cancellation),
      chatJson<Pick<WrapupResult, 'groupchatLines' | 'learnerProfilePatch'>>(profile, [
        { role: 'system' as const, content: sys },
        {
          role: 'user' as const,
          content: [
            context,
            `群聊其他成员：${others.map((c) => `${c.name}（${c.bio}）`).join('、') || '（无）'}`,
            '', '请输出 JSON：', '{',
            ` "groupchatLines": [3-5 条群聊消息 {"speaker","text"}：${ctx.companion.name} 向其他成员复盘这节课，其他成员回应。口语化、有角色个性、不要彩虹屁],`,
            ' "learnerProfilePatch": "对学习者档案中 学习风格/知识掌握地图/强项/弱项 的增量更新描述（markdown 列表，只写新观察）"',
            '}',
          ].join('\n'),
        },
      ], cancellation),
    ]).finally(() => batch.abort());
    wrap = { ...core, ...cards, ...social };
    await saveCheckpoint(); // LLM 结果先落地：后续任何一步失败，重试都不再重花这三次调用
  }

  const endingPage = Math.max(ctx.windowStart, Math.min(ctx.windowEnd, Math.round(wrap.endingPage) || ctx.windowStart));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  onStatus('写入课程小结…');
  assertSession();
  await data.writeLessonSummary(ctx.worldId, ctx.chat.id, ctx.windowStart, wrap.lessonSummary);

  onStatus('更新教材进度…');
  const progressMd = await data.readProgress(ctx.worldId, ctx.textbook);
  // 头部页码只进不退：复习旧页的课不允许把进度写倒退（桌面端 server.js 有同样的护栏）
  const headPage = Math.max(endingPage, data.parseProgressPage(progressMd) ?? 0);
  if (!done.progress) {
    const section = `## ${today} | ${ctx.companion.name}\np.${ctx.windowStart}-${endingPage} | ${wrap.topics}\n\n${wrap.progressParagraph}\n`;
    const oldBody = progressMd ? progressMd.replace(/^# 当前页码：第\s*\d+\s*页\s*\n/, '') : '';
    assertSession();
    await data.writeProgress(ctx.worldId, ctx.textbook, `# 当前页码：第 ${headPage} 页\n\n${section}\n${oldBody}`.trimEnd() + '\n');
    done.progress = true;
    await saveCheckpoint();
  }

  const idx = await data.readTextbookIndex(ctx.worldId);
  const entry = idx.textbooks.find((t) => t.id === ctx.textbook.id);
  if (entry) {
    entry.currentPage = headPage;
    assertSession();
    await data.writeTextbookIndex(ctx.worldId, idx);
  }
  meta.lastStudyDate = today;
  assertSession();
  await data.writeWorldMeta(ctx.worldId, meta);

  onStatus('生成闪卡…');
  if (!done.flashcards) {
    const fcFile = await data.readFlashcards(ctx.worldId, ctx.textbook.id);
    // 双保险：断点标记 + 按 convId 去重（防桌面端等旁路写入后的极端重复）
    if (!fcFile.cards.some((c) => c.conversationId === ctx.chat.id)) {
      for (const fc of wrap.flashcards || []) {
        if (!fc.question || !Array.isArray(fc.choices) || fc.choices.length < 2) continue;
        fcFile.cards.push({
          id: data.flashcardId(now),
          question: fc.question,
          choices: fc.choices,
          correctIndex: Math.max(0, Math.min(fc.choices.length - 1, fc.correctIndex | 0)),
          explanation: fc.explanation || '',
          source: { textbook: ctx.textbook.title, chapter: fc.chapter || wrap.topics, textbookSlug: ctx.textbook.id },
          created: now.toISOString(),
          conversationId: ctx.chat.id,
          status: 'active',
          history: [],
          nextReview: data.nextReviewAfter({ history: [] } as unknown as data.Flashcard, true, now),
        });
      }
      assertSession();
      await data.writeFlashcards(ctx.worldId, fcFile);
    }
    done.flashcards = true;
    await saveCheckpoint();
  }

  onStatus('更新学习者档案…');
  if (!done.learner) {
    if (wrap.learnerProfilePatch?.trim()) {
      const updated = `${(learner || '# 学习者档案').trimEnd()}\n\n## ${today} 课后观察（${ctx.companion.name}）\n${wrap.learnerProfilePatch.trim()}\n`;
      assertSession();
      await data.writeLearnerProfile(ctx.worldId, updated);
    }
    done.learner = true;
    await saveCheckpoint();
  }

  onStatus('伙伴们在群里复盘…');
  if (!done.groupchat) {
    if (wrap.groupchatLines?.length) {
      const valid = wrap.groupchatLines.filter((l) => l.speaker && l.text);
      assertSession();
      await data.appendGroupChat(ctx.worldId, valid, now);
    }
    done.groupchat = true;
    await saveCheckpoint();
  }

  onStatus('保存交接…');
  const handoffMeta: HandoffMeta = {
    savedAt: now.toISOString(),
    prevConvId: ctx.chat.id,
    companionName: ctx.companion.name,
    companionSlot: ctx.companionSlot,
    endingPage,
    teachingLanguage: meta.language || 'chinese',
  };
  const tailMsgs = ctx.chat.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
  assertSession();
  await data.writeHandoff(ctx.worldId, ctx.textbook, handoffMeta, { savedAt: now.toISOString(), messages: tailMsgs });

  // 写入桌面端的「下课」结束标记：桌面侧边栏靠 chat 里是否存在以「[下课]」开头的 user 消息
  // 判定会话「进行中 / 已下课」。不写这条，桌面端会一直显示「进行中」。
  // 放在交接之后，避免污染 handoff 的对话尾巴（last_tail）。重试时不重复插。
  if (!ctx.chat.messages.some((m) => m.role === 'user' && m.content.startsWith('[下课]'))) {
    ctx.chat.messages.push({
      id: data.nanoid(),
      role: 'user',
      content: '[下课] 请执行课后更新。',
      timestamp: now.toISOString(),
    });
  }
  assertSession();
  await data.writeChat(ctx.worldId, ctx.chat);

  assertSession();
  await clearLessonPointer(); // 课已完成，解锁开新课
  assertSession();
  await AsyncStorage.removeItem(ckKey).catch(() => {}); // 全部落盘成功，清掉断点
  return { endingPage };
}
