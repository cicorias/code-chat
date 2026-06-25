# Chat with Code & Repos (`code-chat`)

A chat UI that answers questions about **one or more source-code repositories**. It is based
on `spark-databricks-study/webapp` and uses the
[GitHub Copilot SDK](https://github.com/github/copilot-sdk), so it relies on your existing
Copilot CLI authentication — no separate API key is required.

The assistant runs **read-only** and is **scoped**: it can only read files inside the
configured *include* roots, minus any *exclude* paths.

## Key facts

- **No pre-indexing / no vector store.** There are no embeddings, no RAG index, and no
  background indexing. The assistant grounds every answer by doing **live** `grep`/`glob`/`view`
  reads at query time. The only "index" is a file listing (`/api/files`) used purely to make
  filenames in answers clickable.
- **Source-code aware.** Citable/openable content now includes a broad set of programming
  languages and build/config files (TypeScript, Python, Go, Rust, Java, C/C++, SQL, Terraform,
  shell, Dockerfiles, Makefiles, etc.) in addition to docs.
- **Multi-root include + per-root exclude.** You choose which top-level directories are in
  scope, and within each one you can exclude paths. **An exclude always overrides the include.**
  Scope is enforced at the Copilot read-permission layer, so the agent physically cannot read
  out-of-scope files.

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io).
- GitHub Copilot CLI installed on your `PATH` and authenticated (`copilot --version`).

## Run

```bash
cd code-chat
pnpm install
pnpm start
```

Then open <http://localhost:4174>.

## Configuration of scope — `code-chat.config.json`

```json
{
  "roots": [
    { "include": "../ai-dev-kit",   "exclude": ["databricks-skills/**/dist", "**/__pycache__"] },
    { "include": "../appkit",       "exclude": ["pnpm-lock.yaml", "**/dist", "**/.turbo"] },
    { "include": "../fde-challenge", "exclude": [] }
  ]
}
```

- **`include`** — a top-level root the assistant may read. Path is **relative to the config
  file's directory** (`code-chat/`). List one or more.
- **`exclude`** — paths **relative to that include root** that must never be read, even though
  their parent is included. **Exclude overrides include.**
- **`code-chat` itself is intentionally NOT included** (the app does not read its own source).
- **Default excludes** (`.git`, `node_modules`, `.DS_Store`) are merged into every root.

### Exclude glob syntax

| Pattern        | Matches                                                        |
| -------------- | ------------------------------------------------------------- |
| `dist`         | the `dist` file/dir at the root **and everything under it**   |
| `*`            | exactly one path segment                                      |
| `**`           | any depth                                                     |
| `**/dist`      | a `dist` directory at any depth (and its contents)            |
| `a/b/c.py`     | one specific file                                             |
| `?`            | exactly one character                                         |

The agent's **working directory** is the longest common ancestor of all include roots, and all
citations/paths in the UI are relative to that working directory (e.g. `appkit/CLAUDE.md`).

## Environment variables

| Variable            | Default                                  | Purpose                                            |
| ------------------- | ---------------------------------------- | -------------------------------------------------- |
| `PORT`              | `4174`                                   | HTTP port                                          |
| `COPILOT_MODEL`     | `claude-sonnet-4.6`                      | Model name (must be one your Copilot plan offers)  |
| `CODE_CHAT_CONFIG`  | `./code-chat.config.json`                | Path to the include/exclude config                 |
| `COPILOT_CLI_PATH`  | auto-detected on `PATH`                  | Explicit path to the `copilot` CLI binary          |

## How it works

- `src/server.ts` — Express server. It resolves the include roots, computes their common
  ancestor as the Copilot `workingDirectory`, and enforces scope two ways:
  1. The **system message** tells the agent exactly which roots are in/out of scope.
  2. The **`onPermissionRequest` handler** inspects every read's `path` and rejects anything
     outside an include root or matching an exclude (the hard guarantee).
  `POST /api/chat` streams the answer as Server-Sent Events.
- `GET /api/roots` — the configured roots/excludes (shown in the UI header).
- `GET /api/files` — citable in-scope files across all roots (relative to the working dir),
  used by the browser to linkify filenames in answers.
- `POST /api/open` — opens a cited file with the host's default app (WSL2 / macOS / Linux),
  re-validating that the path is in scope.
- `public/index.html` — single-page chat UI (no build step); Markdown via
  [`marked`](https://marked.js.org), sanitized with
  [`DOMPurify`](https://github.com/cure53/DOMPurify).

## Endpoints

| Method & path     | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `GET /health`     | status, model, working dir, roots, session count   |
| `GET /api/roots`  | configured include roots and their excludes        |
| `GET /api/files`  | in-scope citable files                              |
| `POST /api/open`  | open a cited file on the host                       |
| `POST /api/chat`  | SSE chat stream                                     |
