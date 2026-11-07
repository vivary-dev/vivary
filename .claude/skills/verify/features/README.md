# Workbench feature map

Source inspected 2026-11-02. The upstream acceptance key owns the required result.
Run every mapped feature. A missing precondition is a failure with a reason.

Coverage is limited to these five journeys. Files, Search and Preview are
outside this seed. Project selection checks selection and reload only,
not draft or conversation preservation. Record these exclusions in every
verification receipt. A pass does not establish those untested behaviours.

Project selection and Documentation have no planted-bug fixture yet
(fixtures.json currently covers only Desktop navigation, Narrow navigation
and Settings return); a pass on those two journeys does not prove a
regression there would be caught.

| Feature | Journey |
| --- | --- |
| [Desktop navigation](desktop-navigation.md) | Collapse and expand through the topbar |
| [Narrow navigation](narrow-navigation.md) | Open, dismiss and navigate through the sheet |
| [Project selection](project-selection.md) | Switch projects and restore after reload |
| [Settings return](settings-return.md) | Open Settings and return to the workspace |
| [Documentation](documentation.md) | Read bundled design and return to Settings |
