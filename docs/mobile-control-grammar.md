# Mobile control grammar

Startrips mobile controls use one optical grid so controls read as a quiet instrument panel rather than feature-specific widgets.

## Tokens

- `--mobile-control-hit-size: 44px` is the minimum square hit geometry for icon actions.
- `--mobile-control-cluster-gap: 6px` is the default gap for controls sharing a row or corner cluster.
- `--mobile-control-radius: 999px` defines the default circular/soft-circle icon surface.
- Glyph size may vary for optical correction, but the hit box must not resize when state changes.

## Shape hierarchy

Use an icon circle for one compact action such as close, account, fullscreen, overflow, play/pause, or map dismissal. Use a text/icon pill only when transient status or a labeled mode genuinely needs text. Use a full-width row for sheet navigation/actions. Destructive confirmation stays text-forward and explicit.

Story close follows that rule: idle is an icon-only X with an accessible label. During upload/delete it may expand to a status pill, because the text communicates an active operation rather than duplicating the close icon.

## Stateful motion

Do not add Morphicons yet. The current product only has a small number of true same-control state pairs and already uses Tabler icons. Adding a morphing runtime now would increase dependency/runtime surface before the shared geometry is stable. Prefer fixed-box icon swaps using existing motion tokens; `prefers-reduced-motion` must remain an instant swap. Re-evaluate a morphing dependency only when at least three recurring state pairs benefit from continuous glyph identity without introducing layout shift.

## Audit rule

When adding or reviewing mobile Atlas, Story, fullscreen, account-sheet, picker, or playback controls, first reuse the shared hit/gap/radius tokens. A local dimension is acceptable only when the control is intentionally not an icon action (for example a sheet row or explicit destructive confirmation).
