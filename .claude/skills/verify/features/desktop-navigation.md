# Desktop navigation

## Sub-features

Topbar collapse and expand, accessible menu state and resize handle visibility.

## How to get to it (user POV)

Open the authenticated workspace at 1280 x 900. Open navigation if closed.

## Driving it with Playwright

Use getByRole('button', {name: 'Close navigation', exact: true}), then the
Open navigation button. Assert the visible Projects and conversations aside and
Resize project navigation handle disappear and return. Check aria-expanded and
the usable workspace after each click. Capture both transitions.

## Gotchas

An invisible desktop aside remains in the DOM. Check visibility and bounding
width rather than counting matches. No localStorage writes to set collapse state.
