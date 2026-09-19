# Vendored renderer provenance

These files are a verbatim copy of the reviewed **Startrips Reveal Flows** package,
`startrips-reveal-flows` version **1.0.0** (`manifest.json` `kind:
executable-renderer-package`, `flows: 5`, `verifiedChecks: 46`).

Issue #367 requires the renderer to ship with the deployed Startrips web
experience rather than being loaded from a machine-local package at runtime, so
the reviewed sources live here under version control.

## What was copied

Only the package's `src/` tree, its published type surface and its licence are
vendored. The package's demo page, bundled `dist/` JavaScript, example
photographs, QA notes and Python build/test scripts are intentionally not
vendored: the application builds the renderer from these sources through Vite.

| Vendored path | Package path | sha256 |
| --- | --- | --- |
| `index.js` | `src/index.js` | `22240c804a16889933fbeb988fddc1d630268f1fa30f755b6bf2457cf23f5dac` |
| `backends.js` | `src/backends.js` | `ca3ec49e0391e517d137552e7d4168fc4c1bd0d209ae6fa65a214d231754ddf3` |
| `presets.js` | `src/presets.js` | `97c9bc2a38455af859e7861caa73bcb030f05f050055f6ad69b9b7c76daa1fe5` |
| `noise.js` | `src/noise.js` | `4f23fac4a445a4a7ad1c1465d974fe5ee7bf4307c8e23c1103193e1064a21394` |
| `images.js` | `src/images.js` | `9c48e22e4fa3fcea1ba9994c2598007e2a92255c328547c943d7ad1446afc0b7` |
| `fiber.js` | `src/fiber.js` | `be34242cbefcc0ac0018d2c80d556b854f48e666ddbbf2e7c6e6e4f2947acf96` |
| `shaders.js` | `src/shaders.js` | `ec603dc144ea201fd1f7516f206d677d1df0f8767c74adfd4d06ad8a1e204811` |
| `shaders/transition.frag` | `src/shaders/transition.frag` | `601d318dd6df5579611ff3ef4aedf8ee5029566f2f68e15b5cb6ccddf2dbabf6` |
| `index.d.ts` | `dist/reveal-flows.d.ts` | `1c72bed87f5f2747f8b8995116bf8fbb3d42ba47321dbd3ca9bc4aeabedc322c` |
| `LICENSE` | `LICENSE` | `777479a95139d97dea8166ae5b2a10e1e3dcc001673df0c47387121ef1c4cc27` |

Every hash above is the value recorded in the package's own `manifest.json`, and
each vendored file is byte-identical to it.

`shaders/transition.frag` is the editable fragment-shader source; `shaders.js`
is the package's generated string form of it and is what the renderer imports.
Both are kept so a future shader change stays reviewable.

## Modification policy

These files are third-party sources. Do not edit them in place — Startrips
behaviour belongs in the surrounding module (`../coverRevealFlow.ts`,
`../revealBudget.ts`, `../CoverRevealStage.tsx`). Replacing them means copying a
newer reviewed package version and updating this note.

The renderer is standalone WebGL2 with a Canvas2D fallback and only an optional
injected Three.js adapter, so vendoring it does not add a second Three.js
instance to the bundle. Startrips does not inject `THREE`.

Licence: MIT, see `LICENSE`.
