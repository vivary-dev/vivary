# Bundled documentation

## Sub-features

Read-only architecture text and return to Settings.

## How to get to it (user POV)

Select Documentation from the visible navigation.

## Driving it with Playwright

Click Documentation. Assert /settings/architecture and the visible High-level
design document. Check substantive text from docs/ARCHITECTURE.md, and that the
editor is read-only. Click Return to settings and assert General at /settings.

## Gotchas

The reader is bundled at build time. Rebuild after source mutations. External
reference links need network access and are outside this seed journey.
