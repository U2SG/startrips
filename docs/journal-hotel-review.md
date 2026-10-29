# Independent review of journal hotel tools

A separate read-only reviewer examined `512b6c4` and the follow-up diff using synthetic sources only. No live model or private travel source was used; this is not a GitHub approval.

| Finding | Fix | Evidence |
| --- | --- | --- |
| A model could crop a cancelled source sentence to the word “check-in” and obtain a hotel proposal | Independent conservative source eligibility check; complete event source in preview/signature; eligibility and exact source rechecked at apply | Unit cases for cancellation, plans, negation and instructions; PostgreSQL refuses signed cancelled/cropped plans |
| A new hotel updated only Stream's local Journey, disappearing after the reader remounted | Propagate the updated Journey into the owner application's existing `mergeJourney` state path | Browser verifies owner Journey update and remounts Stream before checking the linked point |
| A punctuation-only area normalized to empty and matched every provider address | Require nonempty normalized hotel name and area before search | Unit fixture refuses a punctuation-only city and verifies no search |

The independent follow-up confirmed all three fixes, found no new blocking issue, and independently ran the related two unit files (nine tests passed). The factual check remains conservative rather than a claim to understand all natural-language ambiguity. Full-source preview and confirmation of each batch remain required. Model providers without supported function calls fail explicitly; no generic HTTP/SQL executor is exposed.
