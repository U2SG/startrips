// Socratopia project-data 领域层：与桌面版完全相同的文件格式读写。
// 路径均相对数据根 %APPDATA%\socratopia。
import * as api from './api';

// ---------- 类型（与桌面版 JSON 对齐） ----------

export type Companion = {
  candidateId: string;
  name: string;
  customName: string | null;
  bio: string;
  pronoun: string;
  nicknames: string[];
  avatar: string | null;
  color: string;
} | null;

export type WorldMeta = {
  worldId: string;
  name: string;
  companions: Companion[];
  createdAt: string;
  language: string;
  lastStudyDate?: string;
};

export type TextbookEntry = {
  id: string;
  fileName: string;
  format: string;
  title: string;
  author?: string;
  year?: string;
  numPages: number;
  currentPage: number;
  field?: string;
  abstract?: string;
  [k: string]: unknown;
};

export type TextbookIndex = { worldId: string; updatedAt: string; textbooks: TextbookEntry[] };

export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; timestamp: string };
export type Chat = {
  id: string;
  createdAt: string;
  character: string;
  title: string;
  messages: ChatMessage[];
  // 桌面侧边栏按 textbookTitle/textbookId 分组，缺失会被归入「其他」
  worldId?: string;
  profileId?: string;
  textbookTitle?: string;
  textbookId?: string;
  companionCandidateId?: string;
};

export type Flashcard = {
  id: string;
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  source: { textbook: string; chapter: string; textbookSlug: string };
  created: string;
  conversationId: string;
  status: string;
  history: { time: string; chosen: number; correct: boolean }[];
  nextReview?: string | null;
};

export type FlashcardFile = { textbookId: string; updatedAt: string; cards: Flashcard[] };

export type HandoffMeta = {
  savedAt: string;
  prevConvId: string;
  companionName: string;
  companionSlot: string;
  endingPage: number;
  teachingLanguage: string;
};

export type HandoffTail = { savedAt: string; messages: { role: string; content: string }[] };

export type GroupMessage = { time: string; speaker: string; text: string };

export type LlmProfile = { name: string; model: string };
export type LlmConfig = { active: string; profiles: LlmProfile[] };

// ---------- id 生成（nanoid 风格 21 位，与桌面 id 形态一致） ----------

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
export function nanoid(size = 21): string {
  let id = '';
  for (let i = 0; i < size; i++) id += ALPHABET[(Math.random() * 64) | 0];
  return id;
}

export function flashcardId(d: Date): string {
  let hex = '';
  for (let i = 0; i < 12; i++) hex += '0123456789abcdef'[(Math.random() * 16) | 0];
  return `fc_${d.getTime()}_000_${hex}`;
}

// ---------- profile 发现 ----------

let baseCache: string | null = null;
export function clearProfileCache(): void { baseCache = null; }

/** 发现 accounts/<acc>/profiles/<prof> 基路径（取最近修改的组合） */
export async function profileBase(): Promise<string> {
  if (baseCache) return baseCache;
  const accounts = (await api.list('project-data/accounts')).filter((e) => e.dir);
  if (!accounts.length) return 'project-data/accounts/local/profiles/default';
  accounts.sort((a, b) => b.mtime - a.mtime);
  for (const acc of accounts) {
    const profDir = `project-data/accounts/${acc.name}/profiles`;
    let profs: api.Entry[] = [];
    try { profs = (await api.list(profDir)).filter((e) => e.dir); } catch { continue; }
    profs.sort((a, b) => b.mtime - a.mtime);
    if (profs.length) {
      baseCache = `${profDir}/${profs[0].name}`;
      return baseCache;
    }
  }
  throw new Error('没有找到 profile 目录');
}

export async function worldPath(worldId: string): Promise<string> {
  return `${await profileBase()}/worlds/${worldId}`;
}

// ---------- 世界 / 激活状态 ----------

export async function getActive(): Promise<{ worldId: string; textbookId: string }> {
  return api.readJson(`${await profileBase()}/worlds/active.json`);
}

export async function setActive(worldId: string, textbookId: string): Promise<void> {
  await api.writeJson(`${await profileBase()}/worlds/active.json`, { worldId, textbookId });
}

export async function listWorlds(): Promise<string[]> {
  const base = await profileBase();
  return (await api.list(`${base}/worlds`)).filter((e) => e.dir).map((e) => e.name);
}

export async function readWorldMeta(worldId: string): Promise<WorldMeta> {
  return api.readJson(`${await worldPath(worldId)}/world_meta.json`);
}

export async function writeWorldMeta(worldId: string, meta: WorldMeta): Promise<void> {
  await api.writeJson(`${await worldPath(worldId)}/world_meta.json`, meta);
}

// ---------- 教材 ----------

export async function readTextbookIndex(worldId: string): Promise<TextbookIndex> {
  return (await api.readJsonOrNull<TextbookIndex>(`${await worldPath(worldId)}/textbooks/textbook_index.json`))
    || { worldId, updatedAt: '', textbooks: [] };
}

export async function writeTextbookIndex(worldId: string, idx: TextbookIndex): Promise<void> {
  idx.updatedAt = new Date().toISOString();
  await api.writeJson(`${await worldPath(worldId)}/textbooks/textbook_index.json`, idx);
}

export async function textbookDir(worldId: string, tb: TextbookEntry): Promise<string> {
  return `${await worldPath(worldId)}/textbooks/${tb.id}`;
}

export async function textbookPdfPath(worldId: string, tb: TextbookEntry): Promise<string> {
  return `${await textbookDir(worldId, tb)}/${await findPdfFileName(worldId, tb)}`;
}

async function findPdfFileName(worldId: string, tb: TextbookEntry): Promise<string> {
  // 实际文件名带上传时间戳后缀（如 “书名 1769311171849.pdf”），按目录扫描匹配
  const dir = await textbookDir(worldId, tb);
  const entries = await api.list(dir);
  const pdf = entries.find((e) => !e.dir && /\.(pdf|epub)$/i.test(e.name));
  if (!pdf) throw new Error(`教材 ${tb.title} 目录下没有 PDF 或 EPUB 文件`);
  return pdf.name;
}

export async function importTextbook(worldId: string, name: string, body: BodyInit): Promise<TextbookEntry> {
  const guard = api.sessionGuard();
  const world = await worldPath(worldId);
  guard();
  const metaPath = `${world}/world_meta.json`;
  const existing = await api.readJsonOrNull<WorldMeta>(metaPath);
  guard();
  if (!existing) {
    const meta: WorldMeta = {
      worldId, name: '我的学习', createdAt: new Date().toISOString(), language: 'zh',
      companions: [{ candidateId: 'socrates', name: '苏格拉底', customName: null,
        bio: '通过提问和讨论陪你理解教材。', pronoun: '他', nicknames: [], avatar: null, color: 'teal' }],
    };
    try { await api.writeJson(metaPath, meta); }
    catch (error) { if ((error as { status?: number }).status !== 409) throw error; }
  }
  guard();
  return api.uploadTextbook<TextbookEntry>(world, name, body);
}

export async function readPreface(worldId: string, tb: TextbookEntry): Promise<{ contentStartPage: number } | null> {
  return api.readJsonOrNull(`${await textbookDir(worldId, tb)}/preface.json`);
}

/** 解析 progress.md 头部「# 当前页码：第 N 页」 */
export function parseProgressPage(progressMd: string | null): number | null {
  if (!progressMd) return null;
  const m = progressMd.match(/当前页码：第\s*(\d+)\s*页/);
  return m ? Number(m[1]) : null;
}

export async function readProgress(worldId: string, tb: TextbookEntry): Promise<string | null> {
  return api.readTextOrNull(`${await textbookDir(worldId, tb)}/progress.md`);
}

export async function writeProgress(worldId: string, tb: TextbookEntry, content: string): Promise<void> {
  await api.writeText(`${await textbookDir(worldId, tb)}/progress.md`, content);
}

// ---------- 对话 ----------

export async function listChats(worldId: string): Promise<api.Entry[]> {
  const dir = `${await worldPath(worldId)}/chats`;
  try {
    return (await api.list(dir)).filter((e) => e.name.endsWith('.json')).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export async function readChat(worldId: string, chatId: string): Promise<Chat> {
  return api.readJson(`${await worldPath(worldId)}/chats/${chatId}.json`);
}

export async function writeChat(worldId: string, chat: Chat): Promise<void> {
  await api.writeJson(`${await worldPath(worldId)}/chats/${chat.id}.json`, chat);
}

export async function readCurrentReading(
  worldId: string,
  convId: string,
): Promise<{ startPage: number; endPage: number; body: string } | null> {
  const md = await api.readTextOrNull(`${await worldPath(worldId)}/conversations/${convId}/current_reading.md`);
  if (!md) return null;
  const m = md.match(/^<!-- startPage: (\d+) endPage: (\d+) -->\n?/);
  if (!m) return null;
  return { startPage: Number(m[1]), endPage: Number(m[2]), body: md.slice(m[0].length) };
}

export async function writeCurrentReading(
  worldId: string,
  convId: string,
  startPage: number,
  endPage: number,
  pages: { page: number; text: string }[],
): Promise<void> {
  const body =
    `<!-- startPage: ${startPage} endPage: ${endPage} -->\n` +
    pages.map((p) => `--- 第 ${p.page} 页 ---\n${p.text}`).join('\n');
  await api.writeText(`${await worldPath(worldId)}/conversations/${convId}/current_reading.md`, body);
}

// ---------- NPC / 学习者 ----------

export async function readNpc(worldId: string, slot: string): Promise<string | null> {
  return api.readTextOrNull(`${await worldPath(worldId)}/${slot}.md`);
}

export async function readLearnerProfile(worldId: string): Promise<string | null> {
  return api.readTextOrNull(`${await worldPath(worldId)}/learner_profile.md`);
}

export async function writeLearnerProfile(worldId: string, content: string): Promise<void> {
  await api.writeText(`${await worldPath(worldId)}/learner_profile.md`, content);
}

export async function readStory(worldId: string): Promise<string | null> {
  return api.readTextOrNull(`${await worldPath(worldId)}/story.md`);
}

// ---------- handoff ----------

export async function readHandoff(worldId: string, tb: TextbookEntry): Promise<{ meta: HandoffMeta | null; tail: HandoffTail | null }> {
  const dir = `${await textbookDir(worldId, tb)}/handoff`;
  return {
    meta: await api.readJsonOrNull<HandoffMeta>(`${dir}/last_meta.json`),
    tail: await api.readJsonOrNull<HandoffTail>(`${dir}/last_tail.json`),
  };
}

export async function writeHandoff(worldId: string, tb: TextbookEntry, meta: HandoffMeta, tail: HandoffTail): Promise<void> {
  const dir = `${await textbookDir(worldId, tb)}/handoff`;
  await api.writeJson(`${dir}/last_meta.json`, meta);
  await api.writeJson(`${dir}/last_tail.json`, tail);
}

// ---------- 课程小结 ----------

export async function writeLessonSummary(worldId: string, convId: string, windowStart: number, content: string): Promise<void> {
  await api.writeText(
    `${await worldPath(worldId)}/lesson_summaries/${convId}.md`,
    `<!-- windowStart: ${windowStart} -->\n${content}`,
  );
}

export async function latestLessonSummary(worldId: string): Promise<string | null> {
  const dir = `${await worldPath(worldId)}/lesson_summaries`;
  try {
    const entries = (await api.list(dir)).filter((e) => e.name.endsWith('.md')).sort((a, b) => b.mtime - a.mtime);
    if (!entries.length) return null;
    return await api.readText(`${dir}/${entries[0].name}`);
  } catch {
    return null;
  }
}

// ---------- 闪卡 ----------

export async function listFlashcardFiles(worldId: string): Promise<string[]> {
  const dir = `${await worldPath(worldId)}/flashcards`;
  try {
    return (await api.list(dir)).filter((e) => e.name.endsWith('.json')).map((e) => e.name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function readFlashcards(worldId: string, textbookId: string): Promise<FlashcardFile> {
  const file = await api.readJsonOrNull<FlashcardFile>(`${await worldPath(worldId)}/flashcards/${textbookId}.json`);
  return file || { textbookId, updatedAt: new Date().toISOString(), cards: [] };
}

export async function writeFlashcards(worldId: string, file: FlashcardFile): Promise<void> {
  file.updatedAt = new Date().toISOString();
  await api.writeJson(`${await worldPath(worldId)}/flashcards/${file.textbookId}.json`, file);
}

export { nextReviewAfter } from './flashcardReview';

// ---------- 群聊 ----------

function pad(n: number) { return String(n).padStart(2, '0'); }

export function groupTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function parseGroupChat(md: string): GroupMessage[] {
  const out: GroupMessage[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.+?)：(.*)$/);
    if (m) out.push({ time: m[1], speaker: m[2], text: m[3] });
    else if (out.length && line.trim()) out[out.length - 1].text += '\n' + line;
  }
  return out;
}

export async function readGroupChat(worldId: string): Promise<GroupMessage[]> {
  const md = await api.readTextOrNull(`${await worldPath(worldId)}/groupchat/recent.md`);
  return md ? parseGroupChat(md) : [];
}

export async function appendGroupChat(worldId: string, msgs: { speaker: string; text: string }[], baseTime: Date): Promise<void> {
  let t = baseTime.getTime();
  const lines = msgs.map((m) => {
    const line = `[${groupTimestamp(new Date(t))}] ${m.speaker}：${m.text.replace(/\n+/g, ' ')}`;
    t += 5000; // 桌面版相邻消息间隔约 5 秒
    return line;
  });
  await api.append(`${await worldPath(worldId)}/groupchat/recent.md`, lines.join('\n') + '\n');
  await api.writeText(`${await worldPath(worldId)}/groupchat/last_read.txt`, new Date(t).toISOString());
}

// ---------- 全局配置 ----------

export async function readRules(): Promise<string> {
  const r = await api.readTextOrNull('rules.md');
  return r || '你是耐心的苏格拉底式学习伙伴。严格依据提供的教材内容，用中文提问，引导学习者自己推理。一次只讨论一个问题，先听回答，再给提示和反馈。不要编造教材之外的结论。';
}

export async function readLlmConfig(): Promise<LlmConfig> {
  return api.studyJson<LlmConfig>('/models');
}

