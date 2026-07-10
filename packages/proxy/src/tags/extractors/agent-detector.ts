import type { TagExtractor, TagContext } from "../types.js";

interface AgentRule {
  match: (ua: string, headers: Headers, body?: any) => boolean;
  agent: string;
  extractMeta?: (ua: string, headers: Headers, body?: any) => Record<string, string>;
}

// Extract the first line of body.system, handling both string and
// array-of-blocks ({type, text}) forms. Returns "" when unavailable.
function getSystemFirstLine(body?: any): string {
  if (!body?.system) return "";
  let text: string;
  if (typeof body.system === "string") {
    text = body.system;
  } else if (Array.isArray(body.system) && body.system[0]?.text) {
    text = body.system[0].text;
  } else {
    return "";
  }
  return text.split("\n")[0]?.trim() ?? "";
}

const rules: AgentRule[] = [
  {
    match: (ua) => ua.includes("claude-cli") || ua.includes("claude-code"),
    agent: "claude-code",
    extractMeta: (ua, headers) => {
      const meta: Record<string, string> = {};
      const versionMatch = ua.match(/claude-cli\/([^\s(]+)/);
      if (versionMatch) meta.agent_version = versionMatch[1];
      const session = headers.get("x-claude-code-session-id");
      if (session) meta.agent_session = session;
      const os = headers.get("x-stainless-os");
      if (os) meta.agent_os = os;
      const arch = headers.get("x-stainless-arch");
      if (arch) meta.agent_arch = arch;
      return meta;
    },
  },
  {
    // Codex ships multiple binaries with distinct User-Agent strings:
    //   - "codex-cli/..."        older CLI builds
    //   - "codex/..."            some intermediate versions
    //   - "codex-tui/..."        current TUI binary (≥0.144)
    //   - "codex_cli_rs/..."     current headless binary (≥0.144)
    // The separator can be `-`, `_`, or `/`, so match any of them.
    match: (ua) => /codex[-_/](?:cli|tui|cli_rs)?/i.test(ua) || ua.includes("codex-cli"),
    agent: "codex",
    extractMeta: (ua) => {
      const meta: Record<string, string> = {};
      const versionMatch = ua.match(/codex[-_/]([^\s(]+)/);
      if (versionMatch) meta.agent_version = versionMatch[1];
      return meta;
    },
  },
  {
    // OpenClaw does not send an identifying User-Agent (uses generic "undici")
    // nor any custom header. Its signature is the first line of the system
    // prompt: "You are a personal assistant running inside OpenClaw."
    match: (_ua, _h, body) => getSystemFirstLine(body).includes("OpenClaw"),
    agent: "openclaw",
  },
];

export const agentDetector: TagExtractor = {
  name: "agent-detector",
  extract(ctx: TagContext) {
    const ua = (ctx.headers.get("user-agent") ?? "").toLowerCase();
    for (const rule of rules) {
      if (rule.match(ua, ctx.headers, ctx.body)) {
        const tags: Record<string, string> = { agent: rule.agent };
        if (rule.extractMeta) {
          Object.assign(tags, rule.extractMeta(ua, ctx.headers, ctx.body));
        }
        return tags;
      }
    }
    return null;
  },
};
