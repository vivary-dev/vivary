# Project selection

## Sub-features

Exclusive project selection, conversation heading and persisted selection.

## How to get to it (user POV)

Create and register disposable Alpha and Beta projects in the isolated instance.
Return to the desktop viewport and open Projects.

## Driving it with Playwright

Click the visible project-choice buttons named Alpha and Beta. Assert only the
chosen button has aria-pressed=true and the heading names that project's
conversations. Reload after choosing Beta and assert Beta remains selected.
Then click Alpha and repeat the exclusive-selection and heading checks.

## Gotchas

Missing projects or unavailable folders fail setup. Use normal creation and
registration UI. Never insert registry rows or write selection storage directly.
