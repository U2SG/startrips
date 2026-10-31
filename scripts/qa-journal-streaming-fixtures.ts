/** Fictional QA input only. No account, provider, or private manuscript data. */
export const qaLines = [
  '2028年6月3–5日',
  '- 23:30 实际：她在虚构城入住星桥酒店🌉。',
  '- 07:30 计划：前往虚构花园。',
  '- 08:00 取消：原计划入住山谷酒店。',
  '- 10:30–13:30 计划：游览。实际留在酒店。',
  '',
  '2028年6月6日',
  '- 晚上11:30–凌晨1:00 实际：她在途中。',
  '- 18:20 实际：跨越日期变更线后抵达乙城。',
];
export const qaInput = { sentence: '导入这份流水账并关联已入住酒店', source: qaLines.join('\n'), fallbackDate: '2028-06-01' };
export function qaDraft() {
  const event = (line: number, status: string, time: string, timeEnd: string | null = null, timeEvidence = time) => ({
    line, evidence: qaLines[line], status, localDate: null, dateEvidence: null,
    time, timeEnd, timeEvidence, reading: qaLines[line], questions: [] as string[],
  });
  return { chapters: [
    { firstLine: 0, lastLine: 5, date: '2028-06-03', dateEnd: '2028-06-05', dateEvidence: qaLines[0], events: [
      event(1, 'actual', '23:30'), event(2, 'planned', '07:30'), event(3, 'cancelled', '08:00'), event(4, 'actual', '10:30', '13:30', '10:30–13:30'),
    ] },
    { firstLine: 6, lastLine: 8, date: '2028-06-06', dateEnd: null, dateEvidence: qaLines[6], events: [
      event(7, 'actual', '23:30', '01:00', '晚上11:30–凌晨1:00'), event(8, 'actual', '18:20'),
    ] },
  ] };
}
export const qaToolName = 'stage_journal_import';
export const qaModel = { baseUrl: 'https://qa-provider.invalid/v1', apiKey: 'synthetic-only', model: 'synthetic', timeoutMs: 30_000 };
export const qaJsonResponse = (payload: unknown) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
  tool_calls: [{ id: 'qa-tool-0', type: 'function', function: { name: qaToolName, arguments: JSON.stringify(payload) } }],
} }] });
export const qaFrame = (payload: unknown) => `data: ${JSON.stringify(payload)}\r\n\r\n`;
export const qaDelta = (args: string, initial = false) => qaFrame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
  ...(initial ? { id: 'qa-tool-0', type: 'function' } : {}), function: { ...(initial ? { name: qaToolName } : {}), arguments: args },
}] }, finish_reason: null }] });
export function qaSse(payload: unknown, finish: string | null = 'tool_calls', done = true) {
  const args = JSON.stringify(payload), pieces = Array.from({ length: Math.ceil(args.length / 17) }, (_, i) => args.slice(i * 17, (i + 1) * 17));
  return ': synthetic keepalive\r\n\r\n' + pieces.map((piece, i) => qaDelta(piece, i === 0)).join('')
    + (finish ? qaFrame({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) : '')
    + qaFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    + (done ? 'data: [DONE]\r\n\r\n' : '');
}
export function qaResponse(text: string, chunkBytes = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) controller.enqueue(bytes.slice(offset, offset + chunkBytes));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
/** Lets validation cases use either transport while requiring separate SSE tests. */
export function qaAnswer(payload: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => JSON.parse(String(init?.body)).stream ? qaResponse(qaSse(payload)) : qaJsonResponse(payload)) as typeof fetch;
}
