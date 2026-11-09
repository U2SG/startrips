import type { JournalChapter, JournalEvent, JournalSuggestion } from "./dailyJournal";

export function journalChapterQuestions(chapter: JournalChapter) {
  const questions = new Map<string, number[]>();
  chapter.events.forEach((event, index) => {
    const suggestion = chapter.suggestions.find(suggestion => suggestion.eventId === event.id);
    for (const question of new Set(suggestion?.questions.map(question => question.trim()).filter(Boolean) ?? [])) {
      questions.set(question, [...questions.get(question) ?? [], index + 1]);
    }
  });
  return [...questions].map(([question, events]) => ({ question, events }));
}
export function hasJournalReadingSuggestion(event: JournalEvent, suggestion?: JournalSuggestion) {
  return !!suggestion && (!!suggestion.background.trim() || (!!suggestion.text.trim() && suggestion.text.trim() !== event.text.trim()));
}
export function JournalChapterReview({ chapter }: { chapter: JournalChapter }) {
  const questions = journalChapterQuestions(chapter);
  return questions.length ? <details className="daily-journal__review"><summary tabIndex={0}>{chapter.date} · 需核实的内容（{questions.length} 项）</summary>
    <p>相同问题合并展示，正文仍可阅读。只需核实以下内容，不必补齐原文未提供的每个字段。</p>
    <ul>{questions.map(({ question, events }) => <li key={question}>{question}<small>对应本章第 {events.join("、")} 条记录</small></li>)}</ul>
  </details> : null;
}
