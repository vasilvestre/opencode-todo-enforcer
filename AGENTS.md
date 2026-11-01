# AGENTS.md — maintainer instructions

Instructions for agents working in this repository.

## What this repo ships

One OpenCode v2 plugin: `@vasilvestre/opencode-todo-enforcer`.

When a session goes idle with todos still open, it resumes the session once
with the list of what remains. The agent finishes each todo or marks it
cancelled.

The plugin is one file, `index.js`, with no build step and no dependency.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | the plugin, and the only runtime file |
| `index.test.mjs` | 15 tests, `node:test`, no dependency |
| `.github/workflows/ci.yml` | tests on pull request and push |
| `.github/workflows/release.yml` | publishes on version bump |
| `README.md` | public usage, behaviour, option, known limits |

## Hard rules

- **Fail silent.** The handler runs inside the session runner. Wrap the whole
  body in `try`/`catch` and swallow. A lookup that fails means "no todos".
- **No dependency.** The plugin imports nothing. Adding a package to a 5 kB
  plugin is a cost the user pays on every install.
- **The todo source is the last completed `todowrite` tool call.** There is no
  todo endpoint in OpenCode 2.2.5, and the plugin context has no
  `session.message` object. Read the active context with
  `ctx.session.context({ sessionID })`, which returns `{ data }`.
- **The idle event is `{ sessionID, background }`.** `background` is a list of
  running items, each with a `kind` and a `sessionID`.
- **Skip while `/goal` is active.** `/goal` stores its state under the storage
  key `session:<id>`, with a `status` field. Read it inside `try`/`catch`: the
  key is an internal detail, so a miss means the plugin runs.
- **Cap every resume.** A session gets `maxResumes` resumes (default 5), and no
  resume when the remaining todos are identical to the previous one.

## Before you commit

```bash
npm test
```

Every change to `index.js` needs a test.

## Release

Published to npm. `.github/workflows/release.yml` publishes on every push to
`main` when the version in `package.json` is not on npm yet.

Bumping the version is the release decision:

```bash
npm version patch   # or minor, or major
git push --follow-tags
```

The workflow stops at "Skip when already published" when the version is
unchanged. It never invents a version. `ci.yml` runs the tests only.

## Commits

Imperative subject, 72 characters or fewer, no trailing period. Say what
changed and why, not how.
