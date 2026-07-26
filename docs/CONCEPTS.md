# What is Vivary?

New to AI agents? Start here. This page explains, in plain language, what Vivary is,
the few ideas it's built on, and why they matter. No prior experience assumed.

## The one-paragraph version

An **AI agent** (like Claude Code or Codex) can read and change the files in a project
for you. The trouble is that, left alone, it forgets things between sessions, loses
track of where you are, and can confidently break something it didn't realize was
connected. **Vivary** sets up your project folder so the agent has a memory it can
trust, a clear sense of the current state, and guardrails before anything risky. You
get all of that with one command, in plain text files you can read yourself.

## The words, defined

You'll see a few terms a lot. Here's what they actually mean.

- **AI agent.** A program that uses an AI model to do real work on your project:
  reading files, editing code, running commands. The model supplies the thinking; the
  agent does the doing.
- **Harness.** The tool that runs the agent: Claude Code, Codex, and others. It
  decides what the model sees, what it's allowed to do, and what happens to its
  output. (More in [the blog](/blog/harnesses-explained/).)
- **Workspace.** The folder your agent works in. The files it reads and edits.
- **Agent-native workspace.** A workspace deliberately shaped so an agent can find its
  way around, check its own work, and trust what it reads, instead of you re-explaining
  the project in every prompt.
- **Knowledge graph.** A set of notes that are *connected*: this change relates to that
  module, which was shaped by this decision. The connections are the useful part.
- **Typed.** Each note has a kind (a "change," a "module," a "decision") with required
  fields. "Typed" means there are rules, and a checker that enforces them.
- **Gate.** A stopping point where a human approves something before it happens.
- **Blast radius.** Everything that depends on the thing you're about to change, so you
  can see what a change might touch before you make it.

## The five things Vivary creates

Run one command and Vivary lays down a complete workspace. Underneath, it gives your
project the five primitives every serious agent project ends up needing. They are
progressively disclosed: module `index.md` files route the agent to the one slice of
context it needs instead of loading the whole project.

1. **Typed project memory** — a small, validated knowledge graph of what the project
   knows, instead of a single `notes.md` that drifts out of date.
2. **Visible state** — one file, `STATE.md`, that always answers "where are we?" The
   agent reads it first and updates it last.
3. **Reusable skills** — the procedures the agent runs, written down once instead of
   re-explained every time.
4. **Private boundaries** — your personal context and durable memory, kept in files
   that are ignored by Git so they never end up in a public commit.
5. **Verification gates** — checks the agent must pass, and a human sign-off before
   anything risky.

## Why the "typed graph" part matters

This is the idea that makes the rest work. When your project's memory is a *typed
graph* instead of flat notes, three good things follow:

- The agent can **retrieve** the few things relevant to the task instead of re-reading
  everything and hoping. Cheaper, and far less error-prone.
- Module `index.md` files keep retrieval **DRY**: the index routes, while the owning
  note, source file, test, or skill carries the real detail once.
- A checker (`tropo check`) can **fail** on broken or mistyped notes, so the memory
  can't quietly rot.
- Review can show you a change's **blast radius**: not just the lines that changed, but
  what they touch. That's the break you wouldn't otherwise see coming.

## What Vivary is *not*

- **Not a platform you adopt.** It's plain Markdown and YAML plus a few small
  command-line tools. No runtime, no database, no account.
- **Not tied to one editor.** It works in any editor, or none.
- **Not tied to one AI tool or model.** Same workspace under Claude Code or Codex, with
  a cloud model or a local one. (See [running it
  locally](/blog/run-vivary-with-local-models/).)
- **Not heavy.** No third-party dependencies; it costs almost nothing to load, so it
  doesn't steal the context your actual work needs.

## The metaphor, if you like metaphors

A *vivary* is an old word for a vivarium: a small, self-contained world where living
things are kept, arranged in stacked layers. That's the idea. Your project lives inside
a small, well-formed world, with a substrate to stand on (the typed graph), an
atmosphere of rules and review around it, and gates at the edges. Vivary's four tools
are even named for the layers of the sky.

## Next steps

- [Getting started](/getting-started/) — go from nothing to a working workspace.
- [Why I built Vivary](/blog/why-i-built-vivary/) — the motivation, in story form.
- [What is an agent-native workspace?](/blog/what-is-an-agent-native-workspace/) — the
  concept, in more depth.
- [Homepage FAQ](https://vivary.vercel.app/#faq) — quick answers.
