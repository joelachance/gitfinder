# Keyboard Completeness Plan

Goal: make GitFinder fully usable without the mouse.

## Definition

Keyboard-complete means a user can:

- open the palette
- type and edit a query
- add and remove filter pills
- open and close the qualifier menu
- move through result lists
- use `/theme`
- use `/ai`
- enter and exit `/repos` drill-down
- reach the auth button
- close the palette with `Escape`

No dead ends, no hidden focus traps, no controls that only work if `#query` is focused.

## Current State

The current renderer already has pieces of this:

- DOM controls live in [src/renderer/index.html](/Users/joe/git/gitfinder/src/renderer/index.html:16).
- Result-list navigation is mostly input-driven in [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:2005).
- Filter-pill rendering/removal lives in [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:313).
- Theme preview/commit behavior lives in [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:658).
- Palette-level `Escape` handling is now global in [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:1968).
- Focus styling for pill dismiss buttons exists in [src/renderer/styles.css](/Users/joe/git/gitfinder/src/renderer/styles.css:396).

What is still missing is system design. The app has local fixes, but not one coherent keyboard model.

## Keyboard Contract

These bindings should work consistently:

- `Escape`: back out one level, then hide palette
- `Tab` / `Shift+Tab`: move through real controls in a stable order
- `ArrowUp` / `ArrowDown`: move active result row
- `j` / `k`: same as arrows when the search input owns list navigation
- `Enter`: activate the current result row or focused control
- `Space`: activate the focused button-like control
- `Delete` / `Backspace`: remove focused filter pill
- `Cmd/Ctrl+R`: refresh current view
- `/`: move focus back to the search input if the palette is open

## Focus Model

Use two different navigation models:

1. Real focus for real controls

- `#query`
- `#btn-filter-qualifier`
- qualifier menu items
- each filter-pill dismiss button
- `#btn-auth`

2. Roving active row for the results list

- results should not become dozens of Tab stops
- the list keeps one `activeIndex`
- arrows and `j` / `k` move the active row
- `Enter` opens the active row

Tab should never walk every result row.

## Proposed Focus Order

When the qualifier menu is closed:

1. `#query`
2. `#btn-filter-qualifier`
3. each `.badge-dismiss`
4. `#btn-auth`

When the qualifier menu is open:

1. `#query`
2. `#btn-filter-qualifier`
3. qualifier menu items
4. each `.badge-dismiss`
5. `#btn-auth`

When the palette is reopened, focus should always return to `#query` and select the current value.

## State Stack For Escape

`Escape` should act like a back stack, not a special case:

1. if the qualifier menu is open, close it and focus `#btn-filter-qualifier`
2. else if `/repos` sub-list is open, return to the repo menu
3. else if `/repos` menu is open, return to the repo catalog
4. else if `/theme` is previewing, restore the committed theme
5. else hide the palette

This belongs in one shared helper, not scattered across focused controls.

## Implementation Phases

### Phase 1: Introduce a Palette Keyboard Router

Files:

- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js)

Work:

- add one small router that understands palette state
- split app-level keys from input-level keys
- keep `#query` responsible for text editing and result navigation only
- move `Escape`, `/`, and `Cmd/Ctrl+R` to the palette-level handler

Target functions:

- `runSearch()`
- `handleEscapeKey()`
- `searchInput.addEventListener('keydown', ...)`
- `document.addEventListener('keydown', ...)`

### Phase 2: Finish Tab Navigation

Files:

- [src/renderer/index.html](/Users/joe/git/gitfinder/src/renderer/index.html)
- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js)

Work:

- make every intended control focusable by design
- ensure qualifier menu items receive focus when opened
- restore focus to the trigger when the qualifier menu closes
- ensure filter-pill removal restores focus deterministically
- ensure auth button is reachable and does not swallow `Escape`

Open gap today:

- the qualifier menu opens visually, but does not yet behave like a keyboard-managed menu

### Phase 3: Add Focus State Helpers

Files:

- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js)
- [src/renderer/styles.css](/Users/joe/git/gitfinder/src/renderer/styles.css)

Work:

- add helpers like `focusSearchInput()`, `focusQualifierButton()`, `focusFirstQualifierItem()`
- centralize post-action focus restoration
- make focus styling explicit for all keyboard targets

Needed styles:

- `#btn-filter-qualifier:focus-visible`
- `.filter-qualifier-menu-item:focus-visible`
- `#btn-auth:focus-visible`
- keep pill focus styling aligned with the rest

### Phase 4: Make Slash Modes Consistent

Files:

- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:658)
- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js:1408)

Work:

- `/theme`: preview on active row, commit on `Enter`, restore on `Escape`
- `/ai`: `Escape` hides from any focused element, not just the input
- `/repos`: preserve active row and back out cleanly with repeated `Escape`

### Phase 5: Add Selection Restoration

Files:

- [src/renderer/renderer.js](/Users/joe/git/gitfinder/src/renderer/renderer.js)

Work:

- when leaving a repo drill-down, restore the last active repo row
- when closing and reopening the qualifier menu, avoid resetting unrelated UI state
- when returning focus to the search box, preserve caret position unless intentional select-all is desired

## Suggested Data Helpers

Add a lightweight focus/state layer:

- `getPaletteMode()`
- `focusSearchInput({ select?: boolean })`
- `focusQualifierButton()`
- `focusQualifierMenuItem(index)`
- `closeQualifierMenu({ restoreFocus?: boolean })`
- `restoreResultsSelection()`

This should stay small. No framework, no state machine library.

## Acceptance Criteria

The work is done when all of these pass:

- `Escape` hides the palette from input, `+`, qualifier menu items, filter-pill `x`, auth button
- `Tab` and `Shift+Tab` move predictably through all controls
- opening the qualifier menu by keyboard puts focus inside it
- `Escape` from the qualifier menu closes it and returns focus to `+`
- removing a filter pill keeps focus on the next logical dismiss button
- removing the last filter pill returns focus to `#query`
- `/theme` preview cancels cleanly on `Escape`
- `/repos` drill-down backs out one level per `Escape`
- reopening the palette always lands on `#query`

## Manual Test Matrix

1. Open palette, press `Tab` repeatedly, confirm focus order.
2. Open qualifier menu with keyboard, choose `repo:`, close it with `Escape`.
3. Add three pills, remove the middle pill, then the last pill, without touching the mouse.
4. Focus the auth button, press `Escape`, verify the palette hides.
5. Enter `/theme`, move with arrows, press `Escape`, verify the committed theme is restored.
6. Enter `/repos`, open a repo menu, open a repo sub-list, press `Escape` twice, verify you land back in the repo catalog.
7. Reopen the palette and verify `#query` is focused.

## Follow-up

After this lands, the next high-value step is a small automated UI smoke suite for:

- `Escape`
- Tab order
- qualifier menu keyboard flow
- filter-pill removal focus
- `/theme` cancel/commit behavior
