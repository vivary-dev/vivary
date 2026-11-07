# Narrow navigation

## Sub-features

Sheet opening, Escape dismissal, focus restoration and navigation dismissal.

## How to get to it (user POV)

Resize the authenticated workspace to 390 x 844. Activate Open navigation.

## Driving it with Playwright

Use the topbar Open navigation button. Locate the visible dialog named Projects
and conversations. Press Escape and assert it closes with focus on the opener.
Reopen it and click its Settings link. Assert /settings, visible General content
and a closed dialog. Capture every action and result.

## Gotchas

The breakpoint is 767 pixels. Hidden desktop links must not satisfy sheet checks.
Do not navigate with page.goto to substitute for selecting the sheet link.
