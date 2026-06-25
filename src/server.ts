import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type PermissionRequest,
  type PermissionRequestResult,
} from "@github/copilot-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");

const PORT = Number(process.env.PORT ?? 4174);
const MODEL = process.env.COPILOT_MODEL ?? "claude-sonnet-4.6";
const CONFIG_PATH = resolve(process.env.CODE_CHAT_CONFIG ?? join(APP_ROOT, "code-chat.config.json"));

// ── Content types ───────────────────────────────────────────────────────────
// File extensions that can be cited/opened. Docs + a broad set of source code.
const OPENABLE_EXTENSIONS = new Set([
  // docs / config / data
  ".md", ".mdx", ".rst", ".txt", ".adoc", ".ipynb",
  ".toml", ".yaml", ".yml", ".json", ".jsonc", ".json5", ".ini", ".cfg", ".conf", ".properties", ".env",
  ".xml", ".csv", ".tsv", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  // shell / build
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
  ".mk", ".cmake", ".gradle", ".bazel", ".bzl", ".nix", ".dockerfile",
  // source code
  ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".sc", ".clj", ".cljs", ".groovy",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".m", ".mm",
  ".cs", ".fs", ".fsx", ".vb", ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".jl",
  ".swift", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".mli", ".elm", ".zig", ".nim",
  ".sql", ".hql", ".graphql", ".gql", ".proto", ".thrift", ".tf", ".tfvars", ".hcl",
]);

// Extensionless / dotfile basenames (lowercased) that are still citable.
const OPENABLE_BASENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "jenkinsfile",
  "vagrantfile", "brewfile", "license", "notice", "readme", "codeowners",
  ".gitignore", ".gitattributes", ".dockerignore", ".npmrc", ".nvmrc", ".env",
  ".editorconfig", ".prettierrc", ".eslintrc", ".babelrc",
]);

// Excludes applied to every include root regardless of config.
const DEFAULT_EXCLUDES = [".git", "node_modules", ".DS_Store"];

// ── Configuration model ─────────────────────────────────────────────────────
interface RootConfig {
  include: string;
  exclude?: string[];
}
interface ResolvedRoot {
  /** Absolute path of the include root. */
  abs: string;
  /** Display label (path relative to the working directory). */
  label: string;
  /** Exclude glob patterns (config + defaults), relative to this root. */
  excludes: string[];
}

function loadConfig(): { roots: RootConfig[] } {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { roots?: RootConfig[] };
  if (!parsed.roots?.length) {
    throw new Error(`Config ${CONFIG_PATH} must define a non-empty "roots" array.`);
  }
  return { roots: parsed.roots };
}

const CONFIG_DIR = dirname(CONFIG_PATH);

// Resolve include roots to absolute paths (relative to the config file's dir).
function resolveRoots(roots: RootConfig[]): ResolvedRoot[] {
  const resolved: ResolvedRoot[] = [];
  for (const r of roots) {
    if (!r.include) continue;
    const abs = resolve(CONFIG_DIR, r.include);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.warn(`⚠  Skipping include "${r.include}" — not a directory: ${abs}`);
      continue;
    }
    resolved.push({
      abs,
      label: abs,
      excludes: [...DEFAULT_EXCLUDES, ...(r.exclude ?? [])],
    });
  }
  if (!resolved.length) throw new Error("No valid include roots resolved from config.");
  return resolved;
}

// Longest common ancestor directory of all include roots — used as the agent's
// working directory so it can see every included root.
function commonAncestor(paths: string[]): string {
  const split = paths.map((p) => p.split(sep));
  const first = split[0];
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((parts) => parts[i] === seg)) out.push(seg);
    else break;
  }
  const joined = out.join(sep);
  return joined || sep;
}

// ── Glob matching for excludes ──────────────────────────────────────────────
// Supports '**' (any depth), '*' (one path segment), '?' (one char).
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // '**' — match across path segments (optionally including the slash).
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

// A path (relative to an include root) is excluded if any pattern matches it,
// or matches it treated as a directory whose contents are all excluded.
function isExcluded(rel: string, patterns: string[]): boolean {
  const norm = rel.split(sep).join("/");
  for (const p of patterns) {
    const pat = p.replace(/\/+$/, "");
    if (globToRegExp(pat).test(norm)) return true;
    if (globToRegExp(`${pat}/**`).test(norm)) return true;
  }
  return false;
}

// ── Scope enforcement ───────────────────────────────────────────────────────
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && resolve(parent, rel) === child;
}

// True if the absolute path may be read: inside some include root AND not
// matched by that root's excludes. Excludes always override includes.
function isReadAllowed(roots: ResolvedRoot[], absPath: string): boolean {
  for (const root of roots) {
    if (!isWithin(root.abs, absPath)) continue;
    const rel = relative(root.abs, absPath);
    if (rel === "") return true; // the include root directory itself
    if (!isExcluded(rel, root.excludes)) return true;
  }
  return false;
}

// ── File listing (citable files across all roots) ───────────────────────────
function isCitable(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (OPENABLE_BASENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return false; // no extension (and not a dotfile allowlist entry)
  return OPENABLE_EXTENSIONS.has(lower.slice(dot));
}

// List files tracked by git for a root (paths relative to the root).
function gitFiles(rootAbs: string): string[] | null {
  try {
    if (!existsSync(join(rootAbs, ".git"))) {
      // Could still be inside a parent git repo; probe with rev-parse.
      execFileSync("git", ["-C", rootAbs, "rev-parse", "--is-inside-work-tree"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    const out = execFileSync("git", ["-C", rootAbs, "ls-files"], { maxBuffer: 64 * 1024 * 1024 }).toString();
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

// Recursive directory walk (paths relative to the root) for non-git roots.
function walkFiles(rootAbs: string, excludes: string[]): string[] {
  const results: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const relDir = stack.pop() as string;
    const absDir = relDir ? join(rootAbs, relDir) : rootAbs;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (isExcluded(childRel, excludes)) continue;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) results.push(childRel);
    }
  }
  return results;
}

// Citable files across every include root, as paths relative to the working dir.
function listScopedFiles(roots: ResolvedRoot[], workingDir: string): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    const tracked = gitFiles(root.abs) ?? walkFiles(root.abs, root.excludes);
    for (const rel of tracked) {
      if (isExcluded(rel, root.excludes)) continue;
      const base = rel.split("/").pop() ?? rel;
      if (!isCitable(base)) continue;
      const abs = join(root.abs, rel);
      out.add(relative(workingDir, abs).split(sep).join("/"));
    }
  }
  return [...out].sort();
}

// ── Boot config ─────────────────────────────────────────────────────────────
const { roots: rawRoots } = loadConfig();
const ROOTS = resolveRoots(rawRoots);
const WORKING_DIR = commonAncestor(ROOTS.map((r) => r.abs));
for (const r of ROOTS) r.label = relative(WORKING_DIR, r.abs).split(sep).join("/") || ".";

function buildSystemMessage(): string {
  const rootLines = ROOTS.map((r) => {
    const ex = r.excludes.length ? `\n    excluded: ${r.excludes.join(", ")}` : "";
    return `  - ${r.label}/${ex}`;
  }).join("\n");
  return `
<role>
You are a code & repository assistant. You answer questions about, and help users
understand, one or more source-code repositories. The repositories contain code
(many languages), configuration, and documentation.
</role>

<scope>
You may ONLY read files under these INCLUDED top-level roots (relative to the working directory):
${rootLines}

Excluded paths (listed per root above, relative to that root) must NEVER be read, even
though their parent is included. Any path outside the included roots is off-limits and
will be denied. Do not attempt to read the working directory itself or sibling
directories that are not listed as included roots.
</scope>

<answering_rules>
- Answer ONLY from the content of files within the included roots. Use your read/search
  tools (grep, glob, view) scoped to the included roots to find relevant material first.
- When citing, use the path relative to the working directory, e.g. "${ROOTS[0].label}/README.md".
- If the included repositories do not cover the topic, say so plainly instead of guessing.
- Prefer concise, well-structured answers. Use short code blocks when quoting code.
- Never modify, create, or delete files. You are strictly read-only.
</answering_rules>
`;
}

const SYSTEM_MESSAGE = buildSystemMessage();

// ── Read-only + scope permission handler ────────────────────────────────────
function permissionHandler(request: PermissionRequest): PermissionRequestResult {
  switch (request.kind) {
    case "read": {
      const abs = resolve(WORKING_DIR, request.path);
      if (isReadAllowed(ROOTS, abs)) return { kind: "approve-once" };
      return {
        kind: "reject",
        feedback:
          "That path is outside the configured included roots (or matches an exclude). " +
          "Only read files within the included roots.",
      };
    }
    case "memory":
      return { kind: "approve-once" };
    default:
      return {
        kind: "reject",
        feedback: "This assistant is read-only; only reading in-scope repository files is permitted.",
      };
  }
}

// ── Cross-platform helpers ──────────────────────────────────────────────────
function whichExe(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function resolveCopilotCli(): string | undefined {
  if (process.env.COPILOT_CLI_PATH && existsSync(process.env.COPILOT_CLI_PATH)) {
    return process.env.COPILOT_CLI_PATH;
  }
  return whichExe("copilot");
}

function openOnHost(absPath: string): void {
  if (isWsl()) {
    const wslview = whichExe("wslview");
    if (wslview) {
      execFileSync(wslview, [absPath]);
    } else {
      const winPath = execFileSync("wslpath", ["-w", absPath]).toString().trim();
      execFileSync("explorer.exe", [winPath]);
    }
  } else if (process.platform === "darwin") {
    execFileSync("open", [absPath]);
  } else {
    const xdg = whichExe("xdg-open");
    if (!xdg) throw new Error("No opener found (need xdg-open on Linux).");
    execFileSync(xdg, [absPath]);
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(join(APP_ROOT, "public")));

const NODE_MODULES = join(APP_ROOT, "node_modules");
app.use("/vendor/marked", express.static(join(NODE_MODULES, "marked", "lib")));
app.use("/vendor/dompurify", express.static(join(NODE_MODULES, "dompurify", "dist")));

const cliPath = resolveCopilotCli();
const client = new CopilotClient({
  workingDirectory: WORKING_DIR,
  ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
});
const sessions = new Map<string, CopilotSession>();

async function getSession(sessionId?: string): Promise<CopilotSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
  }
  const session = await client.createSession({
    model: MODEL,
    streaming: true,
    systemMessage: { content: SYSTEM_MESSAGE },
    onPermissionRequest: permissionHandler,
  });
  sessions.set(session.sessionId, session);
  return session;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    model: MODEL,
    workingDir: WORKING_DIR,
    roots: ROOTS.map((r) => ({ root: r.label, excludes: r.excludes })),
    sessions: sessions.size,
  });
});

app.get("/api/roots", (_req, res) => {
  res.json({ workingDir: WORKING_DIR, roots: ROOTS.map((r) => ({ root: r.label, excludes: r.excludes })) });
});

app.get("/api/files", (_req, res) => {
  res.json({ files: listScopedFiles(ROOTS, WORKING_DIR) });
});

app.post("/api/open", (req, res) => {
  const requested = String(req.body?.path ?? "").trim();
  if (!requested) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const abs = resolve(WORKING_DIR, requested);
  // Must stay within the working dir AND inside an included (non-excluded) root.
  if (!isWithin(WORKING_DIR, abs) || !isReadAllowed(ROOTS, abs)) {
    res.status(403).json({ error: "path is out of scope" });
    return;
  }
  if (!existsSync(abs)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  try {
    openOnHost(abs);
    res.json({ ok: true, opened: relative(WORKING_DIR, abs).split(sep).join("/") });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let session: CopilotSession;
  try {
    session = await getSession(sessionId);
  } catch (err) {
    send("error", { message: `Failed to start session: ${(err as Error).message}` });
    res.end();
    return;
  }

  send("session", { sessionId: session.sessionId });

  const unsubscribers: Array<() => void> = [];
  const cleanup = () => unsubscribers.forEach((fn) => fn());

  unsubscribers.push(
    session.on("assistant.message_delta", (event) => {
      send("delta", { text: event.data.deltaContent });
    }),
  );
  unsubscribers.push(
    session.on("session.idle", () => {
      send("done", {});
      cleanup();
      res.end();
    }),
  );

  req.on("close", () => {
    cleanup();
    session.abort().catch(() => {});
  });

  try {
    await session.send({ prompt: message });
  } catch (err) {
    send("error", { message: (err as Error).message });
    cleanup();
    res.end();
  }
});

async function main() {
  await client.start();
  try {
    const models = await client.listModels();
    const names = models.map((m: { id?: string; name?: string }) => m.id ?? m.name).filter(Boolean);
    console.log(`Available models: ${names.join(", ")}`);
    if (names.length && !names.includes(MODEL)) {
      console.warn(`⚠  Configured COPILOT_MODEL="${MODEL}" not in available list; requests may fail.`);
    }
  } catch {
    // listModels is best-effort.
  }

  app.listen(PORT, () => {
    console.log(`Code-chat app on http://localhost:${PORT}`);
    console.log(`Working directory: ${WORKING_DIR}`);
    console.log("Included roots:");
    for (const r of ROOTS) {
      console.log(`  - ${r.label}/  (excludes: ${r.excludes.join(", ") || "none"})`);
    }
    console.log(`Model: ${MODEL}`);
    console.log(`Copilot CLI: ${cliPath ?? "(SDK bundled default)"}`);
  });
}

async function shutdown() {
  console.log("\nShutting down...");
  await client.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
