# Vivary workbench acceptance key

This is the answer key for the project verify skill. Review changes to these
expectations separately from the runner. The runner must read this file from
`origin/dev` and fail closed when it is absent.

These are required user journeys, not a record of passing tests. Source checked
on 2026-11-02. Use the normal web workbench with isolated disposable state and
an authenticated session where remote access requires one. Register two
disposable connected folders as Alpha and Beta before the project journey.
A missing precondition is a failed journey with a reason, never a skipped pass.

| Feature | User action | Observable result |
| --- | --- | --- |
| Desktop navigation | At 1280 x 900, open navigation if needed, activate the topbar **Close navigation** menu button, then activate its **Open navigation** button. | Closing hides the Projects and conversations sidebar and its resize handle, leaves the workbench usable, and changes the menu to Open navigation with `aria-expanded=false`. Opening restores the sidebar and resize handle and changes the menu to Close navigation with `aria-expanded=true`. |
| Narrow navigation | At 390 x 844, activate the topbar **Open navigation** button, press Escape, reopen it, then choose **Settings** in the sheet. | Navigation opens in the **Projects and conversations** sheet. Escape closes it and returns focus to the menu button. Choosing Settings navigates to `/settings`, closes the sheet, and leaves Settings content visible without a persistent desktop sidebar. |
| Project selection | In Projects, select Alpha, select Beta, reload the page, then select Alpha again. | Each choice marks only the selected project as pressed and changes the conversation heading to that project's name. Reload retains Beta as selected. Returning to Alpha restores Alpha as selected and its conversation heading, without showing Beta as selected. |
| Settings return | From the workspace, choose **Settings**, then activate **Return to workspace** in the topbar. | Settings opens at `/settings` with General, Appearance and Theme controls visible. Return to workspace opens `/` and restores the workspace surface and the selected project's conversation heading. |
| Bundled documentation | Choose **Documentation** from navigation, read the High-level design document, then activate **Return to settings**. | `/settings/architecture` displays the read-only **High-level design document** with substantive bundled architecture text. Return to settings opens `/settings` with General visible. |

Source anchors for review:

- `packages/workbench/app/components/layout/Layout.tsx`
- `packages/workbench/app/components/layout/Sidebar.tsx`
- `packages/workbench/app/components/layout/use-workspace-layout.ts`
- `packages/workbench/app/components/projects/ProjectNavigation.tsx`
- `packages/workbench/app/routes/settings.tsx`
- `packages/workbench/app/routes/architecture.tsx`

Capture the action and resulting visible state for every row, including both
navigation transitions. A successful HTTP response or source inspection alone
does not pass a journey. This seed covers five workbench features. It does not
establish model execution, filesystem isolation, desktop packaging or release
acceptance.
