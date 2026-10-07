#!/usr/bin/env node
// Your Claude Code and Codex sessions on Полка (docs/specs/AGENT_SESSIONS.md):
// what the agent did, which secrets it saw and where they went, what it cost.
// Secrets are replaced on this machine before anything is sent; the server
// gets a session index, a secrets report (type, keyed fingerprint, where) and
// a shortened, redacted transcript. Thinking is left out unless asked for.
// No dependencies: Node 22+.
//
//   node polka-sessions.mjs login                 (asks for the token, keeps it in ~/.polka, mode 600)
//   node polka-sessions.mjs list [--since 7d]
//   node polka-sessions.mjs preview <session-id|file>
//   node polka-sessions.mjs upload <session-id|file>
//   node polka-sessions.mjs sync [--since 7d] [--source claude|codex]
//   node polka-sessions.mjs hook                  (Claude Code SessionEnd hook; needs POLKA_SESSIONS=on)
//
// See docs/specs/AGENT_SESSIONS.md.
import { createHmac, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

// Empty in the repository. An installation that serves this file
// (GET /api/v1/cli/polka-sessions.mjs) fills in its own origin.
const DEFAULT_ENDPOINT = "";
const TIMEOUT_MS = 300_000;
/** The server keeps at most this many tool calls of one session. */
export const MAX_TOOL_CALLS = 20_000;
const INPUT_CHARS = 4_000;
const OUTPUT_HEAD = 2_000;
const OUTPUT_TAIL = 1_000;

// ---------------------------------------------------------------------------
// Secrets

/** Rule families after gitleaks' defaults; bounded repetition only. */
export const RULES = [
  { type: "private-key", confidence: "high", re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,8192}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g },
  { type: "aws-access-key", confidence: "high", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { type: "github-token", confidence: "high", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g },
  { type: "gitlab-token", confidence: "high", re: /\bglpat-[\w-]{20}\b/g },
  { type: "anthropic-key", confidence: "high", re: /\bsk-ant-(?:api03|admin01|oat01)-[\w-]{80,}/g },
  { type: "openai-key", confidence: "high", re: /\bsk-(?:proj-|svcacct-|admin-)?[\w-]{20,}T3BlbkFJ[\w-]{20,}|\bsk-proj-[\w-]{40,}/g },
  { type: "yandex-iam-token", confidence: "high", re: /\bt1\.[\w-]+=*\.[\w-]{86}=*/g },
  { type: "yandex-api-key", confidence: "high", re: /\bAQVN[\w-]{35,38}\b/g },
  { type: "yandex-oauth-token", confidence: "high", re: /\by0_[\w-]{55}\b/g },
  { type: "yandex-static-key", confidence: "high", re: /\bYC[\w-]{38}\b/g },
  { type: "google-api-key", confidence: "high", re: /\bAIza[\w-]{35}\b/g },
  { type: "slack-token", confidence: "high", re: /\bxox[baprs]-[\w-]{10,}/g },
  { type: "stripe-key", confidence: "high", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { type: "telegram-bot-token", confidence: "high", re: /\b\d{8,10}:AA[\w-]{33}\b/g },
  { type: "npm-token", confidence: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "huggingface-token", confidence: "high", re: /\bhf_[A-Za-z]{34}\b/g },
  { type: "jwt", confidence: "high", re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  // Only the password of a URL with credentials.
  { type: "url-password", confidence: "high", group: 1, re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,100}:([^\s@/'"`]{4,200})@[\w.-]+/gi },
  { type: "auth-header", confidence: "medium", group: 1, re: /\b(?:authorization|x-api-key|api-key|x-auth-token)["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Api-Key|OAuth)?\s*([A-Za-z0-9+/_.=-]{16,})/gi },
  { type: "assignment", confidence: "medium", group: 1, re: /\b(?:[A-Za-z_][A-Za-z0-9_]{0,60})?(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIALS?|DSN)[A-Za-z0-9_]{0,30}["']?[ \t]*[:=][ \t]*["']?([^\s"'`,;\\%][^\s"'`,;\\]{7,299})/gi },
];

const PLACEHOLDER = /^(?:changeme|x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|(?:process\.env|os\.environ)\b.*|your[-_].*|example.*|dummy.*|test|null|undefined|true|false|none|\[REDACTED.*)$/i;

/**
 * Code, not a value: a call, an interpolation, a dotted name, a bare word.
 * Measured on stage 0: most "PASSWORD = …" hits in sessions are code.
 */
const LOOKS_LIKE_CODE = (value) =>
  /[(){}[\]<>$`]/.test(value) ||
  /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value) ||
  /^[A-Za-z_]+$/.test(value) ||
  /^(?:string|number|boolean|str|int|bytes|optional|required|secret|password|token)\b/i.test(value);

/** Already a fingerprint marker, a placeholder or a path: not a secret value. */
const NOT_SECRET = (value) => PLACEHOLDER.test(value) || /^[./~]/.test(value);
/**
 * A hash or a UUID: no secret by itself, so the generic rule skips it. Named
 * (`*_SECRET=<64 hex>`) it is one: a random secret is often hex.
 */
const LOOKS_LIKE_HASH = (value) =>
  /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * The captured value inside its match, found from the end: the value is the
 * last part of every rule with a group (before "@host" for a URL). Replacing
 * the first occurrence would hit a user name equal to the password.
 */
function replaceGroup(match, value, marker, followedBy) {
  const at = match.lastIndexOf(value + followedBy);
  return at < 0 ? match.replace(value, marker) : match.slice(0, at) + marker + match.slice(at + value.length);
}

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/**
 * A redactor with one fingerprint key. `redact(text, where)` returns the text
 * with secrets replaced by [REDACTED:<type>:<fingerprint>]; findings
 * accumulate per fingerprint. A value never leaves this function.
 */
export function createRedactor(key) {
  const findings = new Map();
  const fp = (value) => createHmac("sha256", key).update(value).digest("hex").slice(0, 12);
  const samples = [];
  /** For tuning the rules: the shape of a value and its masked surroundings, never the value. */
  const shape = (value) => value.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9").replace(/(.)\1{3,}/g, "$1…");
  let context = "";
  function note(type, confidence, value, where) {
    if (samples.length < 50 && Math.random() < 0.05) {
      const at = context.indexOf(value);
      samples.push({ type, where, shape: shape(value).slice(0, 40), before: at >= 0 ? context.slice(Math.max(0, at - 40), at).replace(/[A-Za-z0-9]{6,}/g, (w) => (/^[a-z_]+$/i.test(w) ? w : shape(w))) : "", length: value.length });
    }
    const id = fp(value);
    const prefix = (/^(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|github_pat_|glpat-|AKIA|ASIA|xox[a-z]-|AIza|y0_|t1\.|AQVN|eyJ|npm_|hf_)/.exec(value) ?? [""])[0];
    const entry = findings.get(id) ?? { type, confidence, fp: id, prefix, length: value.length, occurrences: 0, where: {} };
    entry.occurrences++;
    entry.where[where] = (entry.where[where] ?? 0) + 1;
    findings.set(id, entry);
    return `[REDACTED:${type}:${id}]`;
  }
  function redact(text, where = "unknown") {
    if (typeof text !== "string" || text.length < 8) return text;
    context = text;
    let out = text;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (match, ...groups) => {
        const value = rule.group ? groups[rule.group - 1] : match;
        if (!value || NOT_SECRET(value)) return match;
        if (rule.confidence !== "high" && LOOKS_LIKE_CODE(value)) return match;
        const marker = note(rule.type, rule.confidence, value, where);
        return rule.group ? replaceGroup(match, value, marker, rule.type === "url-password" ? "@" : "") : marker;
      });
    }
    // A random-looking token right after a key-like word ("api_key = …",
    // "token: …"), as gitleaks' generic rule: entropy alone flags images,
    // minified code and hashes by the million (stage 0 measurement).
    out = out.replace(
      /\b(?:key|token|secret|passw(?:or)?d|auth|bearer|credential|apikey|access)[\w-]{0,20}["'\]]?\s*(?:[:=]|=>|\s)\s*["'`]?([A-Za-z0-9+/_-]{24,128}={0,2})(?![A-Za-z0-9+/_=-])/gi,
      (match, token) => {
        if (NOT_SECRET(token) || LOOKS_LIKE_HASH(token) || /^[A-Za-z_-]+$/.test(token) || !/\d/.test(token) || entropy(token) < 4) return match;
        return replaceGroup(match, token, note("generic-key", "low", token, where), "");
      },
    );
    return out;
  }
  return { redact, findings: () => [...findings.values()], samples: () => samples };
}

// ---------------------------------------------------------------------------
// One session file → index (+ an optional redacted transcript)

const NETWORK_TOOLS = /^(?:WebFetch|WebSearch|web_search|web_fetch)$/;
const EDIT_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/;
const READ_TOOLS = /^(?:Read|Grep|Glob|LS|view_image)$/;
const SHELL_TOOLS = /^(?:Bash|BashOutput|shell|shell_command|exec|exec_command|local_shell|unified_exec|write_stdin)$/;
const NETWORK_COMMAND = /\b(?:curl|wget|ssh|scp|rsync|nc|telnet|git\s+push|gh\s|npm\s+publish|docker\s+push|aws\s|gcloud\s|yc\s|psql\s|mysql\s|redis-cli|kubectl\s|helm\s|terraform\s)/;
const WORK_ID = /(?:\/works\/|"artifactId"\s*:\s*")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export function toolKind(name) {
  if (name.startsWith("mcp__")) return "mcp";
  if (SHELL_TOOLS.test(name)) return "shell";
  if (EDIT_TOOLS.test(name)) return "edit";
  if (READ_TOOLS.test(name)) return "read";
  if (NETWORK_TOOLS.test(name)) return "web";
  if (/^(?:Task|Agent|spawn_agent|send_message)$/.test(name)) return "task";
  return "other";
}

/** Shell words of one command, quotes kept together ("a b" is one word). */
function shellWords(text) {
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+/g)].map((match) => match[0]);
}
/** Steps that only set the scene: the command worth naming comes after them. */
const SETUP = /^(?:cd|pushd|popd|export|set|source|\.|unset|ulimit|umask|true|:)$/;

/**
 * argv0 and a template with values blanked: "git push --force origin". The
 * first real step of a chain: `cd "<dir>"; npm test` is npm, not cd.
 */
export function commandShape(command) {
  const steps = command
    .trim()
    .split(/\n|&&|\|\||;|\|/)
    .map((step) => shellWords(step.trim()))
    .filter((words) => words.length);
  const shape = (words) => {
    let i = 0;
    while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++;
    return { words, i, argv0: basename((words[i] ?? "").replace(/^["']|["']$/g, "")) };
  };
  const shaped = steps.map(shape);
  const chosen = shaped.find((step) => step.argv0 && !SETUP.test(step.argv0)) ?? shaped[0] ?? { words: [], i: 0, argv0: "" };
  const rest = chosen.words
    .slice(chosen.i + 1, chosen.i + 4)
    .map((w) => (w.startsWith("-") ? w.replace(/=.*/, "=<v>") : /^[a-z][a-z-]{1,20}$/.test(w) ? w : "<arg>"));
  return { argv0: chosen.argv0, template: [chosen.argv0, ...rest].join(" ").slice(0, 120) };
}

/** Piping a download into a shell anywhere in the command. */
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;

export function hostsIn(text) {
  const hosts = new Set();
  for (const match of String(text).matchAll(/\b(?:https?|wss?|ssh|git|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/(?:[^@\s/'"]*@)?([a-z0-9.-]+\.[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3}|localhost)/gi))
    hosts.add(match[1].toLowerCase());
  for (const match of String(text).matchAll(/\b(?:ssh|scp|rsync)\s+(?:-\S+\s+)*(?:[\w.-]+@)?([a-z0-9.-]+\.[a-z]{2,24})/gi)) hosts.add(match[1].toLowerCase());
  return [...hosts].slice(0, 20);
}

const bytes = (value) => (value === undefined || value === null ? 0 : typeof value === "string" ? Buffer.byteLength(value) : Buffer.byteLength(JSON.stringify(value)));
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}… [${text.length - n} more characters]` : text);
const headTail = (text) =>
  text.length > OUTPUT_HEAD + OUTPUT_TAIL + 100 ? `${text.slice(0, OUTPUT_HEAD)}\n… [${text.length - OUTPUT_HEAD - OUTPUT_TAIL} characters left out] …\n${text.slice(-OUTPUT_TAIL)}` : text;

/** Text of a message or tool result; images and documents become a marker. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text : block?.type === "image" ? "[image]" : block?.type === "document" ? "[document]" : block?.type === "tool_reference" ? "" : JSON.stringify(block)))
    .join("\n");
}

function newIndex(source, file) {
  return {
    schema: "polka-session-index/1",
    source,
    file: basename(file),
    sessionId: null,
    parentSessionId: null,
    cliVersion: null,
    project: { cwd: null, gitBranch: null, remote: null },
    models: {},
    permissionMode: null,
    startedAt: null,
    endedAt: null,
    turns: 0,
    prompts: 0,
    toolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costUSD: null,
    links: { works: [], prs: [] },
    unknownRecordTypes: {},
    parseErrors: 0,
    rawBytes: 0,
  };
}

function seen(index, at) {
  const t = ms(at);
  if (!Number.isFinite(t)) return;
  if (index.startedAt === null || t < index.startedAt) index.startedAt = t;
  if (index.endedAt === null || t > index.endedAt) index.endedAt = t;
}

/** Text the person or the model wrote, redacted; returns the redacted text. */
function scan(redactor, text, where) {
  if (typeof text === "string") return redactor.redact(text, where);
  if (text !== undefined && text !== null) return redactor.redact(JSON.stringify(text), where);
  return "";
}

function noteWorks(index, call, text) {
  if (!call || !/polka/i.test(call.tool)) return;
  for (const match of String(text).matchAll(WORK_ID)) {
    const id = match[1].toLowerCase();
    if (!index.links.works.includes(id) && index.links.works.length < 100) index.links.works.push(id);
  }
}

/**
 * Options: `transcript` — an array to push redacted transcript events into;
 * `thinking` — keep the model's thinking in it (left out by default).
 */
export async function parseClaude(file, redactor, { transcript = null, thinking = false } = {}) {
  const index = newIndex("claude-code", file);
  const calls = new Map();
  const seenMessages = new Set();
  const emit = (event) => transcript?.push(event);
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    index.rawBytes += line.length + 1;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      index.parseErrors++;
      continue;
    }
    seen(index, record.timestamp);
    const t = ms(record.timestamp);
    index.sessionId ??= record.sessionId ?? null;
    if (record.cwd) index.project.cwd ??= record.cwd;
    if (record.gitBranch) index.project.gitBranch ??= record.gitBranch;
    if (record.version) index.cliVersion ??= record.version;
    switch (record.type) {
      case "assistant": {
        const message = record.message ?? {};
        const id = message.id ?? record.requestId;
        if (message.model && message.usage && id && !seenMessages.has(id)) {
          seenMessages.add(id);
          const usage = message.usage;
          const model = (index.models[message.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
          model.input += usage.input_tokens ?? 0;
          model.output += usage.output_tokens ?? 0;
          model.cacheRead += usage.cache_read_input_tokens ?? 0;
          model.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        }
        for (const block of message.content ?? []) {
          if (block.type === "text") {
            const text = scan(redactor, block.text, "assistant_text");
            if (text) emit({ t, type: "assistant", text, ...(record.isSidechain ? { subagent: true } : {}) });
          } else if (block.type === "thinking") {
            const text = scan(redactor, block.thinking, "thinking");
            if (thinking && text) emit({ t, type: "thinking", text });
          } else if (block.type === "tool_use") {
            const kind = toolKind(block.name);
            const command = kind === "shell" ? String(block.input?.command ?? "") : "";
            const input = scan(redactor, block.input, kind === "shell" ? "tool_input_command" : kind === "web" || kind === "mcp" ? "tool_input_network" : kind === "edit" ? "tool_input_file" : "tool_input");
            const call = {
              seq: index.toolCalls.length,
              t,
              tool: block.name,
              kind,
              mcpServer: block.name.startsWith("mcp__") ? block.name.split("__")[1] : null,
              status: "unknown",
              durationMs: null,
              inputBytes: bytes(block.input),
              outputBytes: 0,
              agent: record.isSidechain ? "subagent" : "main",
              ...(command ? commandShape(command) : {}),
              ...(command && PIPE_TO_SHELL.test(command) ? { pipeToShell: true } : {}),
              hosts: kind === "shell" ? hostsIn(command) : kind === "web" ? hostsIn(block.input?.url ?? block.input?.query ?? "") : [],
              network: kind === "web" || kind === "mcp" || (kind === "shell" && NETWORK_COMMAND.test(command)),
            };
            calls.set(block.id, call);
            index.toolCalls.push(call);
            emit({ t, type: "tool_call", seq: call.seq, tool: call.tool, input: clip(input, INPUT_CHARS) });
          }
        }
        break;
      }
      case "user": {
        const content = record.message?.content;
        if (typeof content === "string") {
          if (!record.isMeta) {
            index.prompts++;
            index.turns++;
          }
          const text = scan(redactor, content, "user_prompt");
          if (!record.isMeta) emit({ t, type: "prompt", text: clip(text, INPUT_CHARS * 4) });
        } else if (Array.isArray(content))
          for (const block of content) {
            if (block.type === "tool_result") {
              const call = calls.get(block.tool_use_id);
              const where = call?.kind === "read" ? "file_read" : "tool_output";
              const output = scan(redactor, textOf(block.content), where);
              noteWorks(index, call, output);
              if (call) {
                call.status = block.is_error ? "error" : record.toolUseResult?.interrupted ? "interrupted" : "ok";
                call.outputBytes = bytes(block.content);
                if (Number.isFinite(t) && Number.isFinite(call.t)) call.durationMs = t - call.t;
                emit({ t, type: "tool_result", seq: call.seq, status: call.status, output: headTail(output) });
              }
            } else if (block.type === "text") {
              index.prompts++;
              index.turns++;
              emit({ t, type: "prompt", text: clip(scan(redactor, block.text, "user_prompt"), INPUT_CHARS * 4) });
            } else if (block.type === "image") emit({ t, type: "prompt", text: "[image]" });
          }
        break;
      }
      case "permission-mode":
        index.permissionMode = record.permissionMode ?? index.permissionMode;
        break;
      case "cost-state":
        index.costUSD = record.totalCostUSD ?? index.costUSD;
        break;
      case "pr-link":
        if (typeof record.prUrl === "string" && /^https:\/\//.test(record.prUrl) && !index.links.prs.includes(record.prUrl) && index.links.prs.length < 100)
          index.links.prs.push(record.prUrl.slice(0, 500));
        break;
      case "attachment":
      case "system":
      case "queue-operation":
      case "last-prompt":
      case "atis-latch":
      case "file-history-snapshot":
      case "mode":
      case "summary":
      case "custom-title":
      case "ai-title":
      case "agent-name":
        break;
      default:
        index.unknownRecordTypes[record.type] = (index.unknownRecordTypes[record.type] ?? 0) + 1;
    }
  }
  finish(index);
  return index;
}

export async function parseCodex(file, redactor, { transcript = null, thinking = false } = {}) {
  const index = newIndex("codex", file);
  const calls = new Map();
  const emit = (event) => transcript?.push(event);
  let model = "unknown";
  let lastTotal = null;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    index.rawBytes += line.length + 1;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      index.parseErrors++;
      continue;
    }
    seen(index, record.timestamp);
    const t = ms(record.timestamp);
    const p = record.payload ?? {};
    const kind = `${record.type}/${p.type ?? ""}`;
    switch (kind) {
      case "session_meta/":
        index.sessionId = p.id ?? p.session_id ?? index.sessionId;
        index.project.cwd ??= p.cwd ?? null;
        index.cliVersion ??= p.cli_version ?? null;
        index.project.gitBranch ??= p.git?.branch ?? null;
        index.project.remote ??= p.git?.repository_url ? String(p.git.repository_url).replace(/\/\/[^@/]*@/, "//") : null;
        break;
      case "turn_context/":
        model = p.model ?? model;
        index.permissionMode = `${p.approval_policy ?? "?"}/${typeof p.sandbox_policy === "object" ? (p.sandbox_policy?.type ?? p.sandbox_policy?.mode ?? "?") : (p.sandbox_policy ?? "?")}`;
        break;
      case "event_msg/task_started":
        index.turns++;
        break;
      case "event_msg/token_count":
        if (p.info?.total_token_usage) lastTotal = { model, usage: p.info.total_token_usage };
        break;
      case "response_item/message":
        if (p.role === "user") {
          const raw = (p.content ?? []).map((c) => c.text ?? (c.type === "input_image" ? "[image]" : "")).join("\n");
          // Injected context is not the person's prompt.
          const injected = /^<(?:environment_context|user_instructions|permissions)/.test(raw.trim());
          if (!injected) index.prompts++;
          const text = scan(redactor, raw, "user_prompt");
          if (!injected) emit({ t, type: "prompt", text: clip(text, INPUT_CHARS * 4) });
        } else if (p.role === "assistant") {
          const text = scan(redactor, (p.content ?? []).map((c) => c.text ?? "").join("\n"), "assistant_text");
          if (text) emit({ t, type: "assistant", text });
        }
        break;
      case "response_item/reasoning": {
        const text = scan(redactor, (p.summary ?? []).map((s) => s.text ?? "").join("\n"), "thinking");
        if (thinking && text) emit({ t, type: "thinking", text });
        break;
      }
      case "response_item/function_call":
      case "response_item/custom_tool_call":
      case "response_item/web_search_call":
      case "response_item/local_shell_call": {
        const name = p.name ?? (p.type === "web_search_call" ? "web_search" : p.type === "local_shell_call" ? "local_shell" : "tool");
        let args = p.arguments ?? p.input ?? p.action ?? null;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            // custom tools (apply_patch) send plain text
          }
        }
        // Codex names an MCP tool by its server as the namespace (mcp__<server>).
        const toolKindName = p.namespace?.startsWith("mcp__") ? "mcp" : toolKind(name);
        const commandRaw = toolKindName === "shell" ? (Array.isArray(args?.cmd ?? args?.command) ? (args.cmd ?? args.command).join(" ") : String(args?.cmd ?? args?.command ?? (typeof args === "string" ? args : ""))) : "";
        const command = commandRaw.replace(/^(?:bash|zsh|sh) -l?c /, "");
        const input = scan(redactor, args, toolKindName === "shell" ? "tool_input_command" : toolKindName === "web" || toolKindName === "mcp" ? "tool_input_network" : toolKindName === "edit" ? "tool_input_file" : "tool_input");
        const call = {
          seq: index.toolCalls.length,
          t,
          tool: p.namespace ? `${p.namespace}.${name}` : name,
          kind: toolKindName,
          mcpServer: p.namespace?.startsWith("mcp__") ? p.namespace.slice(5).replace(/_+$/, "") : null,
          status: p.type === "web_search_call" ? (p.status === "completed" ? "ok" : "unknown") : "unknown",
          durationMs: null,
          inputBytes: bytes(p.arguments ?? p.input),
          outputBytes: 0,
          agent: "main",
          ...(command ? commandShape(command) : {}),
          ...(command && PIPE_TO_SHELL.test(command) ? { pipeToShell: true } : {}),
          hosts: toolKindName === "shell" ? hostsIn(command) : toolKindName === "web" ? hostsIn(JSON.stringify(args ?? "")) : [],
          network: toolKindName === "web" || toolKindName === "mcp" || (toolKindName === "shell" && NETWORK_COMMAND.test(command)),
        };
        if (p.call_id) calls.set(p.call_id, call);
        index.toolCalls.push(call);
        emit({ t, type: "tool_call", seq: call.seq, tool: call.tool, input: clip(input, INPUT_CHARS) });
        break;
      }
      case "response_item/function_call_output":
      case "response_item/custom_tool_call_output":
      case "response_item/local_shell_call_output": {
        const call = calls.get(p.call_id);
        const raw = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        const output = scan(redactor, raw, "tool_output");
        noteWorks(index, call, output);
        if (call) {
          const exit = /(?:Exit code|exit_code"?):?\s*(-?\d+)/i.exec(raw);
          call.exitCode = exit ? Number(exit[1]) : null;
          call.status = exit && Number(exit[1]) !== 0 ? "error" : "ok";
          call.outputBytes = Buffer.byteLength(raw);
          if (Number.isFinite(t) && Number.isFinite(call.t)) call.durationMs = t - call.t;
          emit({ t, type: "tool_result", seq: call.seq, status: call.status, output: headTail(output) });
        }
        break;
      }
      case "event_msg/item_completed":
      case "compacted/":
      case "world_state/":
      case "event_msg/task_complete":
      case "event_msg/turn_aborted":
      case "token_usage_record/":
      case "response_item/tool_search_call":
      case "response_item/tool_search_output":
      case "response_item/agent_message":
      case "event_msg/thread_settings_applied":
      case "event_msg/thread_goal_updated":
      case "inter_agent_communication_metadata/":
      case "event_msg/user_message":
      case "event_msg/agent_message":
      case "event_msg/agent_reasoning":
      case "event_msg/exec_command_end":
      case "event_msg/patch_apply_end":
        break;
      default:
        index.unknownRecordTypes[kind] = (index.unknownRecordTypes[kind] ?? 0) + 1;
    }
  }
  if (lastTotal) {
    const u = lastTotal.usage;
    index.models[lastTotal.model] = {
      input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
      output: u.output_tokens ?? 0,
      cacheRead: u.cached_input_tokens ?? 0,
      cacheWrite: u.cache_write_input_tokens ?? 0,
    };
    index.tokens.reasoning = u.reasoning_output_tokens ?? 0;
  }
  finish(index);
  return index;
}

function finish(index) {
  for (const m of Object.values(index.models)) {
    index.tokens.input += m.input;
    index.tokens.output += m.output;
    index.tokens.cacheRead += m.cacheRead;
    index.tokens.cacheWrite += m.cacheWrite;
  }
  index.project.label = index.project.cwd ? basename(index.project.cwd) : null;
}

/** Findings with their flags: what the model saw, ran, sent out or wrote. */
export function secretsReport(findings) {
  const items = findings.map((f) => {
    const w = f.where;
    return {
      ...f,
      seenByModel: !!(w.user_prompt || w.tool_output || w.file_read),
      modelEmitted: !!(w.assistant_text || w.thinking || w.tool_input || w.tool_input_command || w.tool_input_network || w.tool_input_file),
      toCommand: !!w.tool_input_command,
      toNetwork: !!w.tool_input_network,
      writtenToFile: !!w.tool_input_file,
    };
  });
  const status = items.some((i) => i.toNetwork) ? "sent_out" : items.some((i) => i.toCommand || i.writtenToFile) ? "used" : items.length ? "seen" : "clean";
  return { status, items };
}

// ---------------------------------------------------------------------------
// Local sessions

const CLAUDE_DIR = () => join(homedir(), ".claude", "projects");
const CODEX_DIR = () => join(homedir(), ".codex", "sessions");
const STATE_DIR = () => join(homedir(), ".polka");

async function walk(dir, match, depth, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) await walk(path, match, depth - 1, out);
    else if (entry.isFile() && match(entry.name)) out.push(path);
  }
  return out;
}

/** Local session files, newest first: Claude Code's top-level JSONL and Codex rollouts. */
export async function localSessions({ source, since } = {}) {
  const files = [];
  if (!source || source === "claude")
    for (const path of await walk(CLAUDE_DIR(), (name) => /^[0-9a-f-]{36}\.jsonl$/.test(name), 1, []))
      files.push({ source: "claude-code", path, id: basename(path, ".jsonl") });
  if (!source || source === "codex")
    for (const path of await walk(CODEX_DIR(), (name) => /^rollout-.*\.jsonl$/.test(name), 3, []))
      files.push({ source: "codex", path, id: (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path) ?? [])[1] ?? basename(path) });
  const out = [];
  for (const file of files) {
    const info = await stat(file.path);
    if (since && info.mtimeMs < since) continue;
    out.push({ ...file, size: info.size, mtimeMs: info.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const parseSince = (text) => {
  if (!text) return undefined;
  const match = /^(\d+)([dh])$/.exec(text);
  if (!match) throw new CliError("--since takes a number of days or hours, e.g. 7d or 12h.", 2);
  return Date.now() - Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
};

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** One session, ready to send: index, secrets report, links and the gzipped transcript. */
export async function prepareSession(file, key, { thinking = false } = {}) {
  const redactor = createRedactor(key);
  const transcript = [];
  const parse = file.source === "codex" ? parseCodex : parseClaude;
  const index = await parse(file.path, redactor, { transcript, thinking });
  const report = secretsReport(redactor.findings());
  const total = index.toolCalls.length;
  const body = {
    schema: index.schema,
    source: index.source,
    externalId: index.sessionId ?? file.id,
    cliVersion: index.cliVersion,
    project: { label: index.project.label, remote: index.project.remote, gitBranch: index.project.gitBranch },
    permissionMode: index.permissionMode,
    startedAt: index.startedAt,
    endedAt: index.endedAt,
    turns: index.turns,
    prompts: index.prompts,
    toolCallCount: total,
    toolCalls: index.toolCalls.slice(0, MAX_TOOL_CALLS).map(({ t, agent, ...call }) => ({ ...call, at: Number.isFinite(t) ? t : null, subagent: agent === "subagent" })),
    tokens: index.tokens,
    models: index.models,
    costUSD: index.costUSD,
    links: index.links,
    secrets: report.items.map((item) => ({
      fingerprint: item.fp,
      type: item.type,
      confidence: item.confidence,
      prefix: item.prefix || null,
      length: item.length,
      occurrences: item.occurrences,
      seenByModel: item.seenByModel,
      modelEmitted: item.modelEmitted,
      toCommand: item.toCommand,
      toNetwork: item.toNetwork,
      writtenToFile: item.writtenToFile,
    })),
    secretsStatus: report.status,
  };
  const lines = [JSON.stringify({ schema: "polka-session-transcript/1", source: index.source, externalId: body.externalId, thinking }), ...transcript.map((event) => JSON.stringify(event))];
  const transcriptGz = gzipSync(Buffer.from(`${lines.join("\n")}\n`));
  body.transcript = { sha256: createHash("sha256").update(transcriptGz).digest("hex"), bytes: transcriptGz.length };
  return { body, transcriptGz, index, report };
}

// ---------------------------------------------------------------------------
// The server

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

async function call(fetchImpl, method, url, token, body) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, (attempt - 1) * 2_000));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/octet-stream" } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      last = new CliError(`Request failed: ${error.message}`);
      continue;
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 300) };
    }
    if (response.ok) return payload;
    last = new CliError(`Полка answered ${response.status}${payload.code ? ` (${payload.code})` : ""}: ${payload.message ?? "no details"}`);
    if (!(response.status === 429 || response.status >= 500)) throw last;
  }
  throw last;
}

async function connection(options, env) {
  const saved = await readJson(join(STATE_DIR(), "sessions.json"), {});
  let token = env.POLKA_TOKEN?.trim();
  if (!token) {
    try {
      const path = join(STATE_DIR(), "sessions-token");
      const info = await stat(path);
      if ((info.mode & 0o077) !== 0) throw new CliError(`${path} must be readable by you only (chmod 600).`, 2);
      token = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }
  if (!token) throw new CliError("No token: run `polka-sessions login`, or set POLKA_TOKEN to an agent token with the «Сессии агентов» permission (Полка → Агенты).", 2);
  const address = options.endpoint?.trim() || env.POLKA_ENDPOINT?.trim() || saved.endpoint || DEFAULT_ENDPOINT;
  if (!address) throw new CliError("Set POLKA_ENDPOINT or pass --endpoint with your Полка address.", 2);
  let endpoint;
  try {
    endpoint = new URL(address);
  } catch {
    throw new CliError("The endpoint must be a URL such as https://polka.example.com.", 2);
  }
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new CliError("The endpoint must use https.", 2);
  return { token, origin: endpoint.origin };
}

async function fingerprintKey(fetchImpl, conn) {
  const { key } = await call(fetchImpl, "GET", `${conn.origin}/api/v1/sessions/key`, conn.token);
  return Buffer.from(key, "hex");
}

async function uploadOne(fetchImpl, conn, key, file, options) {
  const prepared = await prepareSession(file, key, { thinking: options.thinking });
  const saved = await call(fetchImpl, "POST", `${conn.origin}/api/v1/sessions`, conn.token, gzipSync(Buffer.from(JSON.stringify(prepared.body))));
  if (saved.transcriptNeeded) await call(fetchImpl, "PUT", `${conn.origin}/api/v1/sessions/${saved.id}/transcript`, conn.token, prepared.transcriptGz);
  return { ...saved, prepared };
}

function describe(index, report) {
  const minutes = index.startedAt && index.endedAt ? Math.round((index.endedAt - index.startedAt) / 60_000) : null;
  const kinds = {};
  for (const c of index.toolCalls) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const hosts = new Set(index.toolCalls.flatMap((c) => c.hosts));
  return [
    `${index.source} ${index.sessionId ?? index.file} · ${index.project.label ?? "?"}${index.project.gitBranch ? ` (${index.project.gitBranch})` : ""}`,
    `started ${index.startedAt ? new Date(index.startedAt).toISOString() : "?"}${minutes !== null ? `, ${minutes} min` : ""}, ${index.prompts} prompts, ${index.toolCalls.length} tool calls ${JSON.stringify(kinds)}`,
    `tokens in ${index.tokens.input} out ${index.tokens.output} cache read ${index.tokens.cacheRead}; models ${Object.keys(index.models).join(", ") || "—"}${index.costUSD !== null ? `; cost $${index.costUSD.toFixed(2)}` : ""}`,
    `network hosts: ${hosts.size ? [...hosts].slice(0, 10).join(", ") : "—"}`,
    `secrets: ${report.status}${report.items.length ? ` — ${report.items.map((i) => `${i.type} ${i.fp}${i.toNetwork ? " (sent out)" : i.toCommand ? " (in a command)" : i.writtenToFile ? " (written to a file)" : ""}`).join(", ")}` : ""}`,
    `links: ${index.links.works.length} works, ${index.links.prs.length} pull requests`,
  ].join("\n");
}

const USAGE = `Usage: polka-sessions <command> [options]

Your Claude Code and Codex sessions on Полка. Secrets are replaced on this
computer before anything is sent; thinking is left out unless --thinking.

Commands:
  login                 Save a token (from stdin) and the address in ~/.polka (mode 600)
  list                  Local sessions, newest first
  preview <id|file>     What would be sent for one session; sends nothing
  upload <id|file>      Send one session
  sync                  Send new and changed sessions (with --since, --source)
  hook                  Claude Code SessionEnd hook: sends the ended session in
                        the background; does nothing unless POLKA_SESSIONS=on

Options:
  --since <7d|12h>      Only sessions changed in this period (list, sync; sync default 7d)
  --source <claude|codex>
  --thinking            Include the model's thinking in the transcript
  --endpoint <url>      Полка address (or $POLKA_ENDPOINT${DEFAULT_ENDPOINT ? `; default ${DEFAULT_ENDPOINT}` : ""})
  --json                Machine-readable output
  -h, --help

Environment:
  POLKA_TOKEN           Agent token with «Сессии агентов» (else ~/.polka/sessions-token)
  POLKA_ENDPOINT        Полка address
  POLKA_SESSIONS=on     Lets the hook send sessions`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      source: { type: "string" },
      thinking: { type: "boolean", default: false },
      endpoint: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      token: { type: "string" },
    },
  });
  if (values.token) throw new CliError("Never pass the token as an argument: use `polka-sessions login` or POLKA_TOKEN.", 2);
  if (values.source && !["claude", "codex"].includes(values.source)) throw new CliError("--source is claude or codex.", 2);
  return { ...values, command: positionals[0], target: positionals[1] };
}

async function findSession(target) {
  if (!target) throw new CliError("Name a session id or a file.", 2);
  if (target.endsWith(".jsonl")) {
    const path = resolve(target);
    const isCodex = path.startsWith(CODEX_DIR()) || basename(path).startsWith("rollout-");
    const info = await stat(path).catch(() => null);
    if (!info) throw new CliError(`No such file: ${target}`, 2);
    return { source: isCodex ? "codex" : "claude-code", path, id: (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path) ?? [])[1] ?? basename(path), size: info.size, mtimeMs: info.mtimeMs };
  }
  const found = (await localSessions()).find((file) => file.id === target || file.id.startsWith(target));
  if (!found) throw new CliError(`No local session ${target}.`, 2);
  return found;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, stdin = readStdin } = {}) {
  try {
    const options = parse(argv);
    if (options.help || !options.command) {
      stdout.write(`${USAGE}\n`);
      return options.command ? 0 : options.help ? 0 : 2;
    }
    const statePath = join(STATE_DIR(), "sessions-state.json");
    switch (options.command) {
      case "login": {
        const token = (await stdin()).trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CliError("Paste the agent token on stdin, e.g. `pbpaste | polka-sessions login --endpoint https://…`.", 2);
        const conn = await connection(options, { ...env, POLKA_TOKEN: token });
        await fingerprintKey(fetchImpl, conn);
        await mkdir(STATE_DIR(), { recursive: true, mode: 0o700 });
        await writeFile(join(STATE_DIR(), "sessions-token"), `${token}\n`, { mode: 0o600 });
        await chmod(join(STATE_DIR(), "sessions-token"), 0o600);
        await writeFile(join(STATE_DIR(), "sessions.json"), `${JSON.stringify({ endpoint: conn.origin }, null, 2)}\n`);
        stdout.write(`Saved. Sessions go to ${conn.origin}.\n`);
        return 0;
      }
      case "list": {
        const state = await readJson(statePath, {});
        const files = await localSessions({ source: options.source, since: parseSince(options.since) });
        if (options.json) stdout.write(`${JSON.stringify(files.map((f) => ({ ...f, uploaded: !!state[`${f.source}:${f.id}`] })), null, 2)}\n`);
        else for (const f of files) stdout.write(`${new Date(f.mtimeMs).toISOString().slice(0, 16)}  ${f.source.padEnd(11)} ${f.id}  ${(f.size / 1048576).toFixed(1)} MB${state[`${f.source}:${f.id}`] ? "  sent" : ""}\n`);
        return 0;
      }
      case "preview": {
        const file = await findSession(options.target);
        // Fingerprints here use a local key: the server's key is only fetched to send.
        const { index, report, body, transcriptGz } = await prepareSession(file, Buffer.from("polka-sessions-preview"), { thinking: options.thinking });
        if (options.json) stdout.write(`${JSON.stringify({ ...body, transcriptBytes: transcriptGz.length }, null, 2)}\n`);
        else stdout.write(`${describe(index, report)}\ntranscript: ${(transcriptGz.length / 1024).toFixed(0)} KB compressed${options.thinking ? ", with thinking" : ""}\n`);
        return 0;
      }
      case "upload":
      case "sync": {
        const conn = await connection(options, env);
        const key = await fingerprintKey(fetchImpl, conn);
        const state = await readJson(statePath, {});
        const files = options.command === "upload" ? [await findSession(options.target)] : await localSessions({ source: options.source, since: parseSince(options.since ?? "7d") });
        let sent = 0;
        let skipped = 0;
        for (const file of files) {
          const mark = `${file.source}:${file.id}`;
          if (options.command === "sync" && state[mark]?.size === file.size && state[mark]?.mtimeMs === file.mtimeMs) {
            skipped++;
            continue;
          }
          const result = await uploadOne(fetchImpl, conn, key, file, options);
          state[mark] = { size: file.size, mtimeMs: file.mtimeMs, id: result.id };
          await mkdir(STATE_DIR(), { recursive: true, mode: 0o700 });
          await writeFile(statePath, JSON.stringify(state));
          sent++;
          stderr.write(`sent ${mark} → ${result.url ?? result.id} (secrets: ${result.prepared.report.status})\n`);
        }
        stdout.write(options.json ? `${JSON.stringify({ sent, skipped })}\n` : `Sent ${sent}, unchanged ${skipped}.\n`);
        return 0;
      }
      case "hook": {
        // Never fails the session: everything goes to a detached upload.
        if (env.POLKA_SESSIONS !== "on") return 0;
        let input = {};
        try {
          input = JSON.parse(await stdin());
        } catch {
          return 0;
        }
        const path = typeof input.transcript_path === "string" ? resolve(input.transcript_path) : "";
        if (!path.startsWith(CLAUDE_DIR()) || !path.endsWith(".jsonl")) return 0;
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "upload", path], { detached: true, stdio: "ignore", env });
        child.unref();
        return 0;
      }
      default:
        throw new CliError(`Unknown command ${options.command}.\n${USAGE}`, 2);
    }
  } catch (error) {
    stderr.write(`polka-sessions: ${error.message}\n`);
    return error instanceof CliError ? error.code : 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
