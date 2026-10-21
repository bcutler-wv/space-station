# Design

**Reference:** open [design/wireframe.html](../design/wireframe.html) in a browser. It is the source of truth for layout, components, and motion. The data in it is fake.

## Direction

Inspired by the Caelestia shell for Hyprland: Material 3 color generated from the wallpaper, a framed screen, big soft shapes, and morphing motion. Do not copy Caelestia's code, icons, or assets (it is GPL-3.0 and a different platform). Match the feel.

### The frame

The app sits inside a solid frame. The left bar and the top strip are part of the frame. The content area is a large rounded window cut into it, so the inner corners curve where frame meets content. The wallpaper shows inside that window, in the gaps between panels. In the wireframe this is done with a very large `box-shadow` on the interior element.

### Shapes

- Panel radius 28px, list items 22px, cards 16px, buttons and chips fully rounded.
- Depth comes from stepping between surface-container tones, not borders or drop shadows.
- Icons: Material Symbols Rounded, filled. Type: Rubik. Serve font and icon assets locally in production; pin their sources and licenses.

### Motion

- Panels grow out of the control that opened them (CAPCOM from the search pill, Settings from the gear) and shrink back into it when closed.
- The active Orbit pill stretches with a spring curve.
- Colors cross-fade when the theme changes.
- With `prefers-reduced-motion`, everything becomes an instant change.

### Layout

- **Bar (left):** logo, Mission Control, Orbit pills (letter, color, unread badge, active pill stretched), Mail, Calendar, then the user's avatar and the settings gear at the bottom. Icon only, with tooltips.
- **Top strip:** current location, the CAPCOM search pill (Ctrl or Cmd K), clock, Blackout toggle.
- **Mission Control:** briefing, today's timeline across Orbits, Needs you with Up next, then the review tray, Promises, and Recently auto-cleared, then the week board.
- **Orbit view:** a hero in the Orbit's color with its context and sources, inbox and chat, today's meetings, open tasks.
- **Mobile:** the bar moves to the bottom as a horizontal strip.

No filler. Every panel shows real items the user can act on. No count-only rollup cards.

The M1 mail reader backend exposes bounded conversation and message metadata pages plus a separate item body. The later mail view must re-sanitize stored HTML before constructing a sandboxed iframe, then use the planned image proxy for opaque image references. It must not place remote source URLs in browser data. Automatic SSE-driven reader refetches must use an explicit passive read mode with the same owner authorization or show an update prompt; ordinary reader GETs currently renew the owner's idle session.

The reusable M1 body reader has its own authenticated deep link ahead of full mail navigation. Its scrollable iframe uses the selected theme's resolved color roles and a local Rubik font, with loading, plain-text, unsupported and unavailable states outside the frame. The surrounding controls own remote image consent and bounded expansion.

The first real Mail view is a separate live workspace inside the frame. The configured Orbit and account selector, label filter, and literal subject filter determine a bounded conversation list. A thread opens all visible messages in that account or Orbit, with bodies opened one at a time. Pagination is explicit. Live mail events show a refresh prompt so passive updates do not renew the idle session. Compose and reply use a focused panel inside the same frame. The fixed sending account and optional Orbit are visible; a reply shows its selected destination and fixed conversation subject. Server drafts survive reload, while saving, unsaved and conflict states remain visible. Drafts and unresolved sends have a manual refresh entry point. The unknown-send view never offers an automatic retry. Each thread message has explicit archive, read-state and existing user-label actions. Opening its action panel reads current Gmail eligibility for that message; opening a body does not mark it read. Pending message changes have an account-selected, paginated recovery view with a subject link when the original message is still available in that scope, and an explicit unavailable-message fallback. Its Orbit filter stays exact across account choices. An uncertain change stays blocked until its desired state is observed through an explicit check. Provider confirmation and an observed current Gmail state have distinct copy; neither proves synchronized local labels are current. Labels and read state shown in Mail update only after an authoritative refresh. New-label creation and routing management remain later slices.

## Color system

### Tokens

All colors are CSS custom properties on `:root`, named after Material 3 roles:

`primary`, `on-primary`, `primary-container`, `on-primary-container`, `secondary-container`, `on-secondary-container`, `tertiary`, `tertiary-container`, `on-tertiary-container`, `surface`, `surface-container-lowest`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`, `on-surface`, `on-surface-variant`, `outline`, `outline-variant`, `error`, `on-error`, `error-container`, `on-error-container`, `warn`, `ok`, `frame`, `wall-tint`, `scrim`, and for each Orbit color slot `orbit-N`, `orbit-N-container`, and `on-orbit-N-container`.

Components only use these names. No hex values anywhere outside the token file. CI should grep for stray hex values.

The prototype also has layout tokens such as `--bar-w`, `--gap`, and `--r-l`; these are not color roles. Its named Orbit tokens are sample data. Production uses generated `--orbit-N` and `--orbit-N-container` color slots; normalize the prototype's shorthand `--orbit-c` to the selected slot container role in implementation. Resolve all aliases in the central token file so components consume one vocabulary.

### Generation

1. The user uploads a wallpaper (Settings, Appearance).
2. Extract a seed color with Material Color Utilities (`QuantizerCelebi` then `Score`).
3. Generate light and dark schemes with `SchemeTonalSpot`.
4. Orbit colors come from fixed base hues per color slot, run through `Blend.harmonize` toward the seed.
5. Write every token onto `:root` and persist the seed and wallpaper in `settings`. The M0.3 wallpaper is normalized to bounded WebP and stored in the `appearance` settings row; it can move to the private data volume when the attachment store exists.

The wireframe uses a lightweight OKLCH stand-in for this (`design/theme-engine-prototype.js`). Replace it with Material Color Utilities in the build and keep the token names.

The reference's dark mode has weak contrast in briefing text, event labels, and some buttons. Preserve layout and motion, but tune tonal roles and text roles to meet WCAG AA contrast for normal text (4.5:1) and large text/UI controls (3:1). Check both modes with automated contrast assertions and visual review.

### Modes

System (default), Light, and Dark, in Settings, Appearance. System follows `prefers-color-scheme` live. The resolved mode is set as `data-theme` on `<html>` before first paint to avoid a flash. Both modes must be polished for v1.0.0.

Settings also has: a wallpaper preview, upload and reset, a palette preview, and a switch to hide the wallpaper between panels.

## Writing in the UI

- Plain verbs, sentence case, no filler.
- Theme words in names and headings only (Mission Control, Orbits, CAPCOM, Flight Plan, Blackout). Buttons say what they do: Reply, Add task, Dismiss, Undo.
- Every "why" line explains why something matters now, in one sentence.
- Empty states say what will appear there and how.
