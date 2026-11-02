# Settings return

## Sub-features

Settings navigation and returning to the selected project's workspace.

## How to get to it (user POV)

From the desktop workspace, select Settings in the visible navigation.

## Driving it with Playwright

Click Settings. Assert /settings, General, Appearance and the Theme control.
Click the topbar Return to workspace link. Assert / and the selected project's
conversation heading. Capture both clicks and their resulting views.

## Gotchas

A successful route response is insufficient. Inspect the visible page and
selection. Returning through page.goto does not exercise the link.
