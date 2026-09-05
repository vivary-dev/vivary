# Vivary multi-project language

Vivary helps people and their agents work in portable filesystem workspaces. The workbench coordinates projects while each runtime retains its own agent loop.

## Language

**Workspace**: A bounded collection of files, instructions, knowledge, and operating context usable by an agent. A Vivary workspace can operate independently of the GUI.

**Workspace collection**: A user's collection of registered projects and optional shared knowledge, presented together in the workbench. It is not itself a required repository.

**Project**: A named unit of work with a stable identity and an explicitly selected filesystem root. A project can contain code, research, writing, or a Brain and does not require version control.

**Project registration**: The association between a project identity and its authorized root in a collection. Registration does not move, adopt, publish, or take ownership of the files.

**Managed project**: A registered project using Vivary's workspace contract. Management describes the available Vivary operations, not permission to rewrite existing project conventions.

**Checkout**: A version-controlled working copy associated with a project. A project can use multiple checkouts, while a folder without version control has no checkout.

**Workspace template**: A versioned package of workspace content and declarations installed into a chosen project. It is independent of the repository host, task tracker, and coding runtime.

**Adoption**: Adding the bounded Vivary contract to an existing project through a previewed, conflict-aware change. Existing instructions, history, tooling, and files remain owned by the project.

**Runtime binding**: The association of a session with a particular agent runtime, project root, execution location, and applicable authority.

**Session**: An interaction owned by a selected runtime and referenced by the workbench. Resuming a session preserves its project and execution binding.

**Brain**: An optional knowledge workspace containing sourced knowledge and evidence from work. Shared learning requires an explicit scope beyond any project's private Brain.

**Learning proposal**: An evidence-backed suggested change to knowledge, instructions, or skills. A proposal is distinct from an accepted change and never grants itself authority.

**Repository host**: A service such as GitHub or Gitea that stores a remote repository. Hosting is separate from local version control.

**Task source**: The system that owns a project's tasks, such as native framework tasks, files, or Beads. Workbench views reference that owner instead of maintaining competing task truth.

**Workbench**: Vivary's primary graphical work environment for projects, sessions, plans, files, previews, and evidence. Agent-Native is its application foundation, not the user's required project framework.
