# Independent journal streaming acceptance

Run from the repository root (Node 24):

```sh
node --import tsx --test scripts/qa-journal-streaming.node-test.ts
```

These tests and `qa-journal-streaming-fixtures.ts` use invented text, injected
fetch responses and a loopback HTTP server. No real model, account, database or
production endpoint is used. They call production extraction/transport code.
The `.node-test.ts` name deliberately keeps this pending acceptance suite outside
Vitest's default glob; it is not skipped inside its own explicit command.

## Contract

- Send `stream: true`; reconstruct the single allowed tool call over arbitrary
  network and UTF-8 boundaries. CRLF, comments and a usage-only chunk do not
  corrupt the arguments. Validate the complete answer only after successful
  termination; EOF without termination, length exhaustion, content filtering and
  body failure cannot return a successful answer. Never retry silently.
- Continuous data may exceed 30 seconds. Connection, first-byte and idle deadlines
  remain independent from total duration; caller cancellation reaches fetch/body.
  Pre-cancelled work must send nothing. The provisional test adapter uses the
  existing `timeoutMs` as the phase deadline and `options.signal` for cancellation;
  map those arguments to the owner's final public options once supplied, without
  weakening temporal assertions. Fake-clock tests advance 40 seconds with genuine
  ReadableStream reads. A separate loopback test uses native fetch and HTTP writes.
- Complete line coverage and exact references precede a usable draft. Validate the
  last event as strictly as the first. Plans/cancellations remain distinct from
  completed facts, meridiem/range evidence stays whole, and neither midnight nor
  date-line travel invents a local date. Preserve manual content and replay IDs.
- The final integration gate must additionally run database write/replay/backup
  tests, verify CLI preview can continue past its old 70-second operational cap,
  and test frontend cancellation plus late progress/result isolation across
  request replacement, journey/account changes and unmount. Those are not claimed
  by this provider/extraction-only suite.

## Initial baseline and finding

Reviewed PR #766 head `5703cbc20b02f9658a8802e7d3bb6df9fcb41f2e`, with product
Source `06d39d3a0907ef6278530a769e5d623995de776b`; fresh main is
`4a4e46c10fba62e8cf041815875c1ac09b12906c`.

Initial suite: **15 passed, 7 failed (22 total)**. This is an intentionally red
acceptance baseline, not approval of an unimplemented streaming change. Existing
`journal-import-workflow.test.ts` and `journal-hotel-tools.test.ts`: **70 passed**.

Concrete pre-existing finding at `server/itinerary/journal-import-workflow.ts:113`:
the unconditional Markdown-heading alternative lets a model omit a factual event
from `### 2028年6月3日 实际：她在虚构城入住星桥酒店。`. The source remains in chapter
text, but its stay is absent from events and cannot enter hotel linking. The new
`markdown date heading containing a hotel stay` test reproduces accepted omission
and requires rejection. Pure date headings must still work.

The other six failures document absent streaming/cancellation behavior in this
baseline. A positive SSE case must pass before negative SSE cases can establish
parser correctness. Mock success never establishes real MaaS output quality.
Final integrated Source review, frontend and database verification are pending
an exact integration SHA and the final transport/progress contract from the owner.
