# Secondary action audit (#34)

## Converted to icon-only

These actions are secondary, repeated in dense media/route controls, and have unambiguous icons. They use the shared `IconActionButton`, retain an explicit accessible name, and expose the same concise description on hover and keyboard focus.

- Journey Composer pending media: remove, move earlier, move later.
- Journey Composer route draft: move point earlier, move point later, delete point.
- Journey Story media overview: set media as Journey cover.
- Journey Story current-media controls: set as cover, move earlier, move later, delete media.

The cover action uses `IconPhotoStar` instead of a generic bookmark so the action reads as a media/cover operation rather than a saved-item action.

## Intentionally kept as text

- Save/create Journey: primary action.
- Play Journey / enter playback: primary experiential action.
- Delete Journey: destructive entry point whose scope must remain explicit.
- Destructive confirmation buttons: `取消` / `确认删除` stay textual so confirmation is never icon-dependent.
- Add/upload media and soundtrack actions: context-dependent operations where a bare icon would be ambiguous.
- Remove soundtrack: the target is not visually local enough for a trash icon alone to be reliably understood.

## Interaction contract

- `aria-label` is the accessible name; tooltip text is supplementary.
- Tooltip appears on pointer hover and `:focus-visible`.
- Mobile icon actions are at least 44×44 px.
- Destructive secondary icons retain a distinct hover/focus tone and existing confirmation flows.
- Disabled/loading semantics remain on the underlying `<button>`.
