# Independent review of daily journals

A separate read-only reviewer inspected local commit `50a5359` and the follow-up implementation. No private travel diary or live model was used.

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| Custom model contract did not directly work with a standard model endpoint | Removed the journal-specific external document contract; reused existing `requestIntentModelAnswer` and `INTENT_*` server settings | Unit tests inspect real Chat Completions envelope/strict schema; authenticated API test checks endpoint through a mocked standard completion |
| Saving could still be described as discarded when closing | Return/discard/Escape are blocked during the pending save | Browser holds the PUT response, verifies disabled return and no Escape discard, then releases it |
| Deleted media references prevented all later edits | Previously owned stale links are cleaned; new foreign links remain rejected; explicit unlink control exists even with no remaining media | PostgreSQL integration deletes linked media then saves edited prose |
| Cleanup broke response-loss retries | Migration 0041 adds a private last-request digest; exact last accepted request is recognized under parent locks before cleanup | Integration replays the identical stale-reference request and checks identical saved document/revision |
| Same undated text on different days was swallowed | New chapters store immutable importDate, separate from editable display date | Parser tests cover different import days and reimport after display date correction |
| Date headings and all statuses became individual uncertain events; AI adoption was per-line only | Date/status headings are metadata; explicit status prefixes/sections are retained; one preview action adopts only untouched prose | 14-day parser and browser fixtures; edited prose survives batch adoption |
| Descriptive planned headings inherited actual status | Status-bearing Markdown headings switch sections; unknown Markdown headings reset uncertainty | Reviewer independently reproduced actual/planned/uncertain after the fix; unit assertion covers the same case |

The final independent follow-up reported no new blocking findings. It reconfirmed Atlas scoping, raw-source protection, optimistic conflicts and rejection of newly supplied foreign references.

AI requirements are documented in `daily-journal.md`: the existing standard INTENT channel must be configured with a model supporting strict JSON Schema. The old custom itinerary recognizer alone does not enable journal AI. No credentials or deployment configuration were changed, and no paid provider call was made.
