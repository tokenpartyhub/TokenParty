import type { TagExtractor, TagContext } from "../types.js";

interface AgentRule {
  match: (ua: string, headers: Headers) => boolean;
  agent: string;
  extractMeta?: (ua: string, headers: Headers) => Record<string, string>;
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
    match: (ua) => ua.includes("codex-cli") || ua.includes("codex/"),
    agent: "codex",
    extractMeta: (ua) => {
      const meta: Record<string, string> = {};
      const versionMatch = ua.match(/codex[-/]([^\s(]+)/);
      if (versionMatch) meta.agent_version = versionMatch[1];
      return meta;
    },
  },
  {
    match: (_ua, h) => h.has("x-openclaw"),
    agent: "openclaw",
  },
];

export const agentDetector: TagExtractor = {
  name: "agent-detector",
  extract(ctx: TagContext) {
    const ua = (ctx.headers.get("user-agent") ?? "").toLowerCase();
    for (const rule of rules) {
      if (rule.match(ua, ctx.headers)) {
        const tags: Record<string, string> = { agent: rule.agent };
        if (rule.extractMeta) {
          Object.assign(tags, rule.extractMeta(ua, ctx.headers));
        }
        return tags;
      }
    }
    return null;
  },
};
