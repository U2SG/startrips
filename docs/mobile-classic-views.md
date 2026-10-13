# Mobile classic view trials

The owner requested all four mobile directions together, with one switch, for personal testing. These are local layout trials, not a traffic-split experiment or a replacement for the Book / Stream presentations.

## Try the layouts

Open the account menu. Directly below `媒体呈现`, the `经典视图` button shows the current letter and layout name and cycles A → B → C → D → A. This entry is available in both the desktop dock and the mobile account sheet, even before opening a Journey. The selected layout applies when you open a Journey in the classic (`媒体呈现：默认`) presentation on a compact viewport. Its accessible name includes the current layout name. The choice is remembered only in this browser under `startrips.mobile-classic-view.v1`; no server, Journey, or share-setting write occurs. Storage denial still allows switching for the current visit.

| Variant | Name | Main difference |
| --- | --- | --- |
| A | 轻量经典 | Quiet flat controls and the familiar in-context sheet. |
| B | 单手操作 | Taller picture and a grouped bottom control row. |
| C | 照片优先 | The largest picture aperture; tapping a photo reveals viewing options instead of immediately entering immersive viewing. |
| D | 地球优先 | A shorter sheet keeps more of the existing particle Earth visible. |

The first row contains chapter selection, playback and More. Native-video navigation retains its separate Previous/Next pair instead of hijacking video seeking gestures. More reveals immersive viewing, automatic browsing, management, thumbnails, statistics, soundtrack and Journey navigation. Notes are not deleted or trimmed from stored content. The existing full-text note reader and management mode remain available.

The switch only changes scoped layout attributes. It does not key or remount StoryMediaPages, reset the selected media, replace the live video, or change its currentTime. Desktop and other media presentations retain their existing layout. Expanded Story and native/browser fullscreen remain explicit user actions.

## Validation

CI runs `pnpm qa:mobile-classic-views` in the existing `shell-composer` shard. It executes all five viewport commands below; the browser matrix stays within eight shards and retains every existing suite.

- `pnpm vitest run src/journey/mobileClassicView.test.ts src/journey/JourneyStory.test.ts src/journey/compactMobileContract.test.ts --maxWorkers=1`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm build`
- `node scripts/qa-mobile-classic-views.mjs 320`
- `node scripts/qa-mobile-classic-views.mjs 360`
- `node scripts/qa-mobile-classic-views.mjs 390`
- `node scripts/qa-mobile-classic-views.mjs 430`
- `node scripts/qa-mobile-classic-views.mjs 844 390`

The browser check uses the real JourneyStory QA fixture and the real account-menu preference component in a second tab, starts its own Vite server unless QA_ORIGIN is provided, and writes captures and geometry to `artifacts/mobile-classic/`. It verifies four-way cycling through storage events, 44px controls, overlaps, horizontal overflow, live picture identity, disclosure Back, expanded Escape, reload persistence and desktop isolation. The 390px case also plays a real fixture video and verifies node identity, retained playback time, play state and native controls during switching. The existing login-v3 suite also opens the actual mobile account sheet and desktop dock, checks that Classic View immediately follows Media Presentation, and cycles all four choices without an API write.

Each layout also enters immersive viewing twice through More and returns using Escape and browser Back. The secondary entry collapses on return, so focus must land on visible More before the next interaction; a still-connected hidden button is not an acceptable return target.

### Staggered entrance paint regression

The `auth-media` job `114816346693` on Source `41f2dc38` failed only `story-stage-owner-back-during-settle`. Its initial screenshot was dim while the return image, return clone and media identity were correct. The classic context row shifts `.journey-story__layout` to the fourth staged child: its 420ms delay can outlive the article's 360ms entrance. The former root-only animation/opacity check therefore accepted a still-transparent, translated media ancestor.

`storyPaintReady` checks the current picture and its paint ancestors, including delayed/pending animations, before the existing stationary screenshot. It retains the 3-second deadline and every pixel, clone, focus and media-identity assertion. It does not change product motion or poll screenshots until they pass. The classic-view browser test holds the real layout's entrance after finishing the article, proves the old root-only check incorrectly accepts it and the new check rejects it, then finishes that entrance and verifies the unchanged media node is ready.

Emulation does not prove hardware safe-area insets, software keyboards, iOS Safari media behavior or the owner's final visual preference. Final acceptance is the owner's phone trial. This change does not merge or deploy itself.
