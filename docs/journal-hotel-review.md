# Independent review of journal hotel tools

A separate read-only reviewer examined `512b6c4` and the follow-up diff using synthetic sources only. No live model or private travel source was used; this is not a GitHub approval.

| Finding | Fix | Evidence |
| --- | --- | --- |
| A model could crop a cancelled source sentence to the word “check-in” and obtain a hotel proposal | Independent conservative source eligibility check; complete event source in preview/signature; eligibility and exact source rechecked at apply | Unit cases for cancellation, plans, negation and instructions; PostgreSQL refuses signed cancelled/cropped plans |
| A new hotel updated only Stream's local Journey, disappearing after the reader remounted | Propagate the updated Journey into the owner application's existing `mergeJourney` state path | Browser verifies owner Journey update and remounts Stream before checking the linked point |
| A punctuation-only area normalized to empty and matched every provider address | Require nonempty normalized hotel name and area before search | Unit fixture refuses a punctuation-only city and verifies no search |

The independent follow-up confirmed all three fixes, found no new blocking issue, and independently ran the related two unit files (nine tests passed). The factual check remains conservative rather than a claim to understand all natural-language ambiguity. Full-source preview and confirmation of each batch remain required. Model providers without supported function calls fail explicitly; no generic HTTP/SQL executor is exposed.

## Named-hotel attribution correction

GitHub Source review [5698590403](https://github.com/U2SG/startrips/pull/761#pullrequestreview-5698590403) identified a further P2 in `da29b477`: a stay verb anywhere in an event did not prove that the selected hotel was the stayed hotel. The original follow-up above did not cover this sibling assumption; its earlier clear result is not acceptance of the corrected Source.

The guard now requires the named hotel to be the immediate object of an explicit completed-stay predicate, retaining word/clause boundaries. A restaurant/photo-stop hotel in another activity cannot borrow the first hotel's stay verb. Unsupported word order (including a city inserted between the verb and the selected hotel name) remains a question. The complete original source is still signed and previewed, and apply invokes the same guard against the unchanged source.

An independent second pass caught English purpose qualifiers (`stayed ... for dinner`) and negation separated by adverbs (`never actually stayed`). Rather than enumerate purpose words, every `stayed ... for ...` clause now fails closed (even duration-only variants remain questions); all factual checks use the same NFKC-normalized text. Synthetic positive/negative Chinese and English cases exercise the pure guard, the two-call preview, and signed plans through the authenticated PostgreSQL apply endpoint. The initial nine new guard cases failed against the previous implementation, demonstrating the defect before repair. Existing full-source preservation, confirmation and authorization are unchanged.

The final independent read-only follow-up confirmed the named-object, purpose and negation corrections with no remaining blocking finding; it independently ran two unit files / 27 tests successfully. This is a local code-review result, not a dismissal of the GitHub review or a Maintainer/GitHub approval. Fresh exact-Source CI and Maintainer evaluation remain separate.

## Stay-geography correction

GitHub Source review [5700467880](https://github.com/U2SG/startrips/pull/761#pullrequestreview-5700467880) confirmed the hotel-name fix but identified a distinct P2: a model could borrow another event's city from the same chapter. A synthetic two-city preview regression failed on `bd5d1d3`, reproducing the wrong-city candidate path before the repair.

Preview now requires a directly supported geography/stay/name construction in the selected event. Chapter headings and location mentions attached to another activity do not qualify; no chapter-level inference is attempted. The original area is stored separately from the provider address in the signed plan. Apply rechecks the identical predicate against the unchanged full source, plus candidate/existing-point address consistency. Pre-fix tokens without area provenance are rejected and require a fresh preview. No database migration is needed.

The relationship audit also rejects missing/duplicate plan event IDs. Date/time fields remain unchanged, and journal/Journey revisions protect intervening edits. Synthetic tests cover two cities in one chapter/event, matching and mismatched geography, signed invalid provenance, unsigned tampering with area/candidate/coordinates/source, stale versions, replay and unchanged narrative dates. Mixed-purpose positive fixtures now state the hotel's own location explicitly; previously implicit photo-stop geography has dedicated negative coverage rather than a weakened assertion.

The independent pass additionally reproduced `York` incorrectly matching `New York` in provider/owned-point addresses. Preview and apply now share exact matching against complete delimited address components; opaque or ambiguous addresses remain questions. Dedicated synthetic guard, provider/owned-preview and signed-apply tests reject that collision. This deliberately rejects undelimited composite addresses instead of guessing their geographic structure.

Final independent read-only follow-up found no remaining blocking issue in this geography correction and independently passed two files / 44 tests plus diff checks. PostgreSQL and full CI are separate owner validation. No GitHub APPROVE or Maintainer clearance is claimed.
