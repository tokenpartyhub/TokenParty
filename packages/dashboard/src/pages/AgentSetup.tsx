import { useEffect, useMemo, useState } from "react";
import { api, getToken, getRole, getUserName } from "../lib/api";

// AgentSetup — copy-paste-ready Coding Agent configuration.
//
// Two facts are auto-discovered:
//   1. The TokenParty URL — from window.location.origin (the dashboard
//      itself is served by the same instance the agent will talk to).
//   2. The user's API token — pulled from the existing auth storage
//      via getToken(). No more pasting tokens into a sidebar input.
//
// The user only has to (a) confirm those two values and (b) tick the
// models they want to expose. Each agent card then renders the exact
// file contents the user needs to drop onto disk.

type Protocol = "anthropic" | "openai";

interface ProviderInfo {
  id: string;
  type: Protocol;
}

interface AvailableModel {
  id: string;
  protocols: Set<Protocol>;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch {}
          document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeBlock({ value, language }: { value: string; language: "json" | "toml" | "sh" }) {
  return (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 rounded-md p-4 text-xs leading-relaxed overflow-x-auto whitespace-pre">
        {value}
      </pre>
      <div className="absolute top-2 right-2 flex gap-2">
        <span className="text-[10px] uppercase tracking-wide text-gray-300 bg-gray-700 rounded px-1.5 py-0.5">{language}</span>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>;
}

// Mask the middle of an auth token so a screenshot doesn't leak it. We
// keep the prefix (so users can still tell which token it is from the
// token list) and the last 4 chars.
function maskToken(t: string): string {
  if (t.length <= 10) return t.slice(0, 3) + "****";
  return t.slice(0, 6) + "****" + t.slice(-4);
}

type ClaudeSlot = "main" | "sonnet" | "haiku" | "opus" | "reasoning";

const CLAUDE_SLOTS: { id: ClaudeSlot; envVar: string; label: string; hint: string }[] = [
  { id: "main", envVar: "ANTHROPIC_MODEL", label: "Main", hint: "Default when no model is given" },
  { id: "sonnet", envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet preset", hint: "/model sonnet" },
  { id: "haiku", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku preset", hint: "/model haiku" },
  { id: "opus", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus preset", hint: "/model opus" },
  { id: "reasoning", envVar: "ANTHROPIC_REASONING_MODEL", label: "Reasoning preset", hint: "extended thinking" },
];


// AvailableModel: the unified model list rendered in the picker.
// Built by joining api.getModels() (model id + provider ids) with
// api.getProviders() (provider id + protocol type). The picker needs
// to know which protocol each model can be served over, so a model
// served by both kinds of providers will show up in both groups.

function useAvailableModels() {
  const [models, setModels] = useState<AvailableModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawModels, rawProviders] = await Promise.all([
          api.getModels() as Promise<{ id: string; providers: string[] }[]>,
          api.getProviders() as Promise<ProviderInfo[]>,
        ]);
        if (cancelled) return;
        const providerById = new Map(rawProviders.map((p) => [p.id, p]));
        const seen = new Map<string, Set<Protocol>>();
        for (const m of rawModels) {
          for (const pid of m.providers) {
            const p = providerById.get(pid);
            if (!p) continue;
            const set = seen.get(m.id) ?? new Set<Protocol>();
            set.add(p.type);
            seen.set(m.id, set);
          }
        }
        const out: AvailableModel[] = [...seen.entries()]
          .map(([id, protocols]) => ({ id, protocols }))
          .sort((a, b) => a.id.localeCompare(b.id));
        setModels(out);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load models");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { models, error };
}


function ModelPicker({
  models,
  selected,
  onToggle,
}: {
  models: AvailableModel[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const anthropic = models.filter((m) => m.protocols.has("anthropic"));
  const openai = models.filter((m) => m.protocols.has("openai"));
  const both = models.filter((m) => m.protocols.has("anthropic") && m.protocols.has("openai"));

  const selectAllOfProtocol = (protocol: Protocol) => {
    const target = protocol === "anthropic" ? anthropic : openai;
    const allSelected = target.every((m) => selected.has(m.id));
    const next = new Set(selected);
    for (const m of target) {
      if (allSelected) next.delete(m.id); else next.add(m.id);
    }
    onToggle("__replace__" + JSON.stringify([...next]));
  };

  const onToggleAdapter = (id: string) => {
    if (id.startsWith("__replace__")) {
      // Special signal from selectAllOfProtocol — replace the whole set.
      const arr = JSON.parse(id.slice("__replace__".length));
      onToggle("__replace_set__" + JSON.stringify(arr));
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onToggle("__replace_set__" + JSON.stringify([...next]));
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Models</h3>
        <p className="text-sm text-gray-600 mt-1">
          Tick the models you want to expose. They will be embedded into the agent configs below. TokenParty handles routing — the model names you pick here are what you pass to the agent CLI.
        </p>
      </div>

      {both.length > 0 && (
        <p className="text-xs text-gray-500">
          {both.length} model(s) are served by both Anthropic and OpenAI providers. They appear in both groups.
        </p>
      )}

      <ModelGroup
        title="Anthropic protocol"
        subtitle="Visible to Claude Code and OpenClaw"
        color="purple"
        models={anthropic}
        selected={selected}
        onSelectAll={() => selectAllOfProtocol("anthropic")}
        onToggle={onToggleAdapter}
      />
      <ModelGroup
        title="OpenAI protocol"
        subtitle="Visible to Codex CLI"
        color="green"
        models={openai}
        selected={selected}
        onSelectAll={() => selectAllOfProtocol("openai")}
        onToggle={onToggleAdapter}
      />
    </div>
  );
}

function ModelGroup({
  title, subtitle, color, models, selected, onSelectAll, onToggle,
}: {
  title: string;
  subtitle: string;
  color: "purple" | "green";
  models: AvailableModel[];
  selected: Set<string>;
  onSelectAll: () => void;
  onToggle: (id: string) => void;
}) {
  const allOn = models.length > 0 && models.every((m) => selected.has(m.id));
  const badge = color === "purple" ? "bg-purple-100 text-purple-700" : "bg-green-100 text-green-700";
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge}`}>{title}</span>
            <span className="text-xs text-gray-500">{subtitle}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onSelectAll}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          {allOn ? "Clear" : "Select all"}
        </button>
      </div>
      {models.length === 0 ? (
        <p className="text-sm text-gray-400 italic px-1 py-2">No models available for this protocol. Add a provider in Settings first.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {models.map((m) => (
            <label key={m.id} className="flex items-center gap-2 px-3 py-2 border rounded hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => onToggle(m.id)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-mono text-gray-800 truncate">{m.id}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}


// Per-agent config generators. Each receives the origin, the auth
// token, and the relevant slice of the user's selected models. The
// generated text is meant to be copy-pasted verbatim.

function claudeCodeConfig(origin: string, token: string, slots: Record<ClaudeSlot, string>) {
  // Always include base URL + auth so the file is self-sufficient even
  // when no model slot has been picked yet.
  const lines: string[] = [
    `    "ANTHROPIC_BASE_URL": "${origin}/anthropic"`,
    `    "ANTHROPIC_AUTH_TOKEN": "${token}"`,
  ];
  for (const slot of CLAUDE_SLOTS) {
    const v = slots[slot.id];
    if (!v) continue;
    lines.push(`    "${slot.envVar}": "${v}"`);
  }
  return `{\n  "env": {\n${lines.join(",\n")}\n  }\n}`;
}

function openClawConfig(origin: string, token: string, modelIds: string[]) {
  const modelsBlock = modelIds.map((id) => `          {
            "id": "${id}",
            "name": "${id}",
            "input": ["text"],
            "maxTokens": 8192
          }`).join(",\n");
  return `{
  "models": {
    "mode": "merge",
    "providers": {
      "token-party": {
        "baseUrl": "${origin}/anthropic",
        "apiKey": "${token}",
        "api": "anthropic-messages",
        "models": [
${modelsBlock}
        ]
      }
    }
  }
}`;
}

function codexConfig(origin: string) {
  return `[model_providers.tokenparty]
name = "TokenParty"
base_url = "${origin}/v1"
env_key = "TOKENPARTY_API_KEY"
wire_api = "chat"
requires_openai_auth = false
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000`;
}

function codexEnvSnippet(token: string) {
  return `export TOKENPARTY_API_KEY="${token}"`;
}

function claudeOneClickScript(configBody: string) {
  // bash heredoc with single-quoted EOF so $origin / $token / etc.
  // inside the JSON body are NOT expanded by the user's shell.
  const EOFS = "'EOF'";
  return [
    "mkdir -p \"$HOME/.claude\"",
    "cat > \"$HOME/.claude/settings.json\" <<" + EOFS,
    configBody,
    EOFS,
    "echo \"Wrote $HOME/.claude/settings.json\"",
  ].join("\n");
}

function openclawProviderBlock(origin: string, token: string, modelIds: string[]) {
  // Single-line JSON object (one record per provider in
  // openclaw.json) — easier to embed in a heredoc than multi-line.
  const modelsBlock = modelIds.map((id) => ({
    id, name: id, input: ["text"], maxTokens: 8192,
  }));
  return JSON.stringify({
    baseUrl: `${origin}/anthropic`,
    apiKey: token,
    api: "anthropic-messages",
    models: modelsBlock,
  });
}

function openclawMergeScript(tokenPartyBlock: string) {
  // Stage the new provider block, then merge it into the existing
  // ~/.openclaw/openclaw.json under models.providers["token-party"]
  // so other providers in the file are preserved. Requires python3
  // on PATH.
  const EOFS = "'EOF'";
  const PYEOFS = "'PYEOF'";
  return [
    "mkdir -p \"$HOME/.openclaw\"",
    "cat > /tmp/openclaw-token-party.json <<" + EOFS,
    tokenPartyBlock,
    EOFS,
    "python3 - <<" + PYEOFS,
    [
      "import json, os",
      "with open(\"/tmp/openclaw-token-party.json\") as f:",
      "    new_block = json.load(f)",
      "target = os.path.expanduser(\"~/.openclaw/openclaw.json\")",
      "if os.path.exists(target):",
      "    with open(target) as f: existing = json.load(f)",
      "else:",
      "    existing = {}",
      "models = existing.setdefault(\"models\", {})",
      "models.setdefault(\"mode\", \"merge\")",
      "providers = models.setdefault(\"providers\", {})",
      "providers[\"token-party\"] = new_block",
      "with open(target, \"w\") as f:",
      "    json.dump(existing, f, indent=2)",
      "    f.write(\"\\n\")",
      "print(f\"Wrote {target}\")",
    ].join("\n"),
    PYEOFS,
  ].join("\n");
}

function openclawOneClickScript(tokenPartyBlock: string) {
  return openclawMergeScript(tokenPartyBlock);
}

function codexOneClickScript(origin: string, token: string) {
  const EOFS = "'EOF'";
  return [
    "mkdir -p \"$HOME/.codex\"",
    "cat > \"$HOME/.codex/config.toml\" <<" + EOFS,
    codexConfig(origin),
    EOFS,
    "export TOKENPARTY_API_KEY=\"" + token + "\"",
    "echo \"Wrote $HOME/.codex/config.toml\"",
    "echo \"Exported TOKENPARTY_API_KEY for this shell session\"",
    "echo \"Next: codex --model <one-of-your-selected-models>\"",
  ].join("\n");
}



// One-click scripts. Each is a bash snippet the user copies and runs.
// The script writes the right config file (or merges into OpenClaw's
// existing JSON) and, for Codex, exports the API key in the current
// shell. We avoid nested template-literal escapes by assembling the
// heredoc marker explicitly — single-quoted EOF keeps bash from
// expanding $origin or $token in the config body.

type ManualTab = "script" | "manual";

function AgentCard({
  name, protocol, configPath, configPathWindows, language, config, envSnippet, modelHints, emptyHint, manualExtras, script, scriptDescription,
}: {
  name: string;
  protocol: Protocol;
  configPath: string;
  configPathWindows?: string;
  language: "json" | "toml" | "sh";
  config: string;
  envSnippet?: string;
  modelHints?: string[];
  emptyHint?: string;
  // Optional node rendered at the top of the Manual tab — Claude Code
  // uses this for the 5-slot model mapping UI.
  manualExtras?: React.ReactNode;
  // One-click bash script. Required; the tab system is always shown.
  script: string;
  scriptDescription: string;
}) {
  const [tab, setTab] = useState<ManualTab>("script");
  const badge = protocol === "anthropic"
    ? "bg-purple-100 text-purple-700"
    : "bg-green-100 text-green-700";
  const protocolLabel = protocol === "anthropic" ? "Anthropic protocol" : "OpenAI protocol";

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{name}</h3>
          <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${badge}`}>{protocolLabel}</span>
        </div>
      </div>

      <div className="px-5 pt-4 flex gap-1 border-b border-gray-100">
        <button
          type="button"
          onClick={() => setTab("script")}
          className={`text-sm px-4 py-2 -mb-px rounded-t border-b-2 ${tab === "script" ? "border-blue-600 text-blue-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          One-click script
        </button>
        <button
          type="button"
          onClick={() => setTab("manual")}
          className={`text-sm px-4 py-2 -mb-px rounded-t border-b-2 ${tab === "manual" ? "border-blue-600 text-blue-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Manual config
        </button>
      </div>

      {tab === "script" ? (
        <div className="p-5 space-y-3">
          <p className="text-sm text-gray-600">{scriptDescription}</p>
          <CodeBlock value={script} language="sh" />
          <p className="text-xs text-gray-500">macOS / Linux only. Windows users should use the Manual tab.</p>
        </div>
      ) : (
        <div className="p-5 space-y-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Config file path</div>
          <div className="flex items-center gap-2 flex-wrap">
            <InlineCode>{configPath}</InlineCode>
            {configPathWindows && (
              <>
                <span className="text-xs text-gray-400">or</span>
                <InlineCode>{configPathWindows}</InlineCode>
              </>
            )}
            <CopyButton value={configPath} label="Copy path" />
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Contents</div>
          {emptyHint ? (
            <p className="text-sm text-gray-500 italic">{emptyHint}</p>
          ) : (
            <CodeBlock value={config} language={language} />
          )}
        </div>

        {envSnippet && (
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Shell environment</div>
            <CodeBlock value={envSnippet} language="sh" />
            <p className="text-xs text-gray-500 mt-2">
              Add this line to your shell rc (<InlineCode>~/.zshrc</InlineCode>, <InlineCode>~/.bashrc</InlineCode>, etc.) so the Codex provider block above can read the token.
            </p>
          </div>
        )}

        {modelHints && modelHints.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Run with</div>
            <div className="flex flex-wrap gap-2">
              {modelHints.map((m) => (
                <span key={m} className="text-xs font-mono px-2 py-1 rounded bg-gray-100 text-gray-800 border border-gray-200">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}


export default function AgentSetup() {
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { models, error: modelsError } = useAvailableModels();
  const role = getRole();
  const userName = getUserName();

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
    setToken(getToken());
  }, []);

  // Adapter for ModelPicker — it uses an in-band signaling trick to
  // pass "replace the whole set" through the same toggle callback.
  // Decode that here.
  const handleSelectionChange = (signal: string) => {
    if (signal.startsWith("__replace_set__")) {
      try {
        const arr = JSON.parse(signal.slice("__replace_set__".length));
        setSelected(new Set(Array.isArray(arr) ? arr : []));
      } catch {
        setSelected(new Set());
      }
      return;
    }
    // Plain toggle
    const next = new Set(selected);
    if (next.has(signal)) next.delete(signal); else next.add(signal);
    setSelected(next);
  };

  const anthropicSelected = useMemo(
    () => (models ?? []).filter((m) => m.protocols.has("anthropic") && selected.has(m.id)).map((m) => m.id),
    [models, selected]
  );
  const openaiSelected = useMemo(
    () => (models ?? []).filter((m) => m.protocols.has("openai") && selected.has(m.id)).map((m) => m.id),
    [models, selected]
  );

  // Five-slot model mapping for Claude Code. Defaults each slot to
  // the first Anthropic-protocol model the user has picked. Once
  // primed we no longer auto-fill - subsequent changes are explicit
  // user picks via the per-slot dropdown below.
  const [claudeSlots, setClaudeSlots] = useState<Record<ClaudeSlot, string>>({
    main: "", sonnet: "", haiku: "", opus: "", reasoning: "",
  });
  const [claudeSlotsPrimed, setClaudeSlotsPrimed] = useState(false);
  useEffect(() => {
    if (claudeSlotsPrimed) return;
    if (anthropicSelected.length === 0) return;
    const first = anthropicSelected[0];
    setClaudeSlots({ main: first, sonnet: first, haiku: first, opus: first, reasoning: first });
    setClaudeSlotsPrimed(true);
  }, [anthropicSelected, claudeSlotsPrimed]);

  const loggedIn = !!token;
  const userLabel = role === "admin" ? "Admin" : (userName ?? "User");

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h2 className="text-2xl font-bold text-gray-900">Agent Setup</h2>
        <p className="text-sm text-gray-600 mt-1">
          Connect Claude Code, OpenClaw, or Codex CLI to TokenParty. Confirm the connection details below, pick the models you want, then copy the config into the agent's config file.
        </p>
      </header>

      {!loggedIn && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-800">
          You are not signed in. <a href="/login" className="underline font-medium">Log in</a> first — the token below will populate automatically once you do.
        </div>
      )}

      <section className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Connection</h3>
          <p className="text-xs text-gray-500 mt-1">
            Both values below are auto-detected. You should not need to change them.
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">TokenParty URL</div>
          <div className="flex items-center gap-2">
            <InlineCode>{origin || "(loading)"}</InlineCode>
            <CopyButton value={origin} label="Copy URL" />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Read from <InlineCode>window.location.origin</InlineCode>. If you are behind a reverse proxy and the dashboard URL differs from the externally-visible URL, update your proxy config so they match.
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
            API token {userLabel ? <span className="text-gray-400 normal-case">— {userLabel}</span> : null}
          </div>
          {loggedIn ? (
            <div className="flex items-center gap-2">
              <InlineCode>{maskToken(token!)}</InlineCode>
              <CopyButton value={token!} label="Copy token" />
            </div>
          ) : (
            <div className="text-sm text-gray-400 italic">No token in storage. Sign in to populate.</div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        {modelsError && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-700">
            Could not load available models: {modelsError}
          </div>
        )}
        {models === null && !modelsError && (
          <div className="bg-white rounded-lg shadow p-6 text-sm text-gray-500">Loading models…</div>
        )}
        {models && (
          <ModelPicker models={models} selected={selected} onToggle={handleSelectionChange} />
        )}
      </section>

      {!loggedIn ? (
        <div className="text-sm text-gray-500 italic text-center py-6">
          Agent configs will render once you are signed in.
        </div>
      ) : (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Agent configs</h3>
          <AgentCard
            name="Claude Code"
            protocol="anthropic"
            configPath="~/.claude/settings.json"
            configPathWindows="%USERPROFILE%\\.claude\\settings.json"
            language="json"
            config={claudeCodeConfig(origin, token!, claudeSlots)}
            script={claudeOneClickScript(claudeCodeConfig(origin, token!, claudeSlots))}
            scriptDescription={"Run this in your terminal. It writes the JSON config to the standard Claude Code path so subsequent invocations route through TokenParty automatically."}
            modelHints={anthropicSelected.length > 0 ? anthropicSelected.map((m) => `claude --model ${m}`) : undefined}
            emptyHint={anthropicSelected.length === 0 ? "Pick at least one Anthropic-protocol model above to populate the per-slot mappings." : undefined}
            manualExtras={(
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Model mapping <span className="text-gray-400 normal-case">- bind each Claude Code preset slot to a TokenParty model</span>
                </div>
                {anthropicSelected.length === 0 ? (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    Pick at least one Anthropic-protocol model above to enable the per-slot dropdowns.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {CLAUDE_SLOTS.map((slot) => (
                      <label key={slot.id} className="block">
                        <div className="flex items-baseline justify-between">
                          <span className="text-xs font-medium text-gray-700">{slot.label}</span>
                          <span className="text-[10px] font-mono text-gray-400">{slot.hint}</span>
                        </div>
                        <select
                          value={claudeSlots[slot.id] || ""}
                          onChange={(e) => setClaudeSlots({ ...claudeSlots, [slot.id]: e.target.value })}
                          className="mt-1 w-full border rounded px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        >
                          {anthropicSelected.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <div className="mt-0.5 text-[11px] font-mono text-gray-400 truncate">{slot.envVar}</div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          />
          <AgentCard
            name="OpenClaw"
            protocol="anthropic"
            configPath="~/.openclaw/openclaw.json"
            configPathWindows="%USERPROFILE%\\.openclaw\\openclaw.json"
            language="json"
            config={openClawConfig(origin, token!, anthropicSelected)}
            script={openclawOneClickScript(openclawProviderBlock(origin, token!, anthropicSelected))}
            scriptDescription={"Run this in your terminal. It stages the TokenParty provider block to a temp file, then merges it under models.providers[\"token-party\"] of your existing openclaw.json so other providers and settings are preserved."}
            emptyHint={anthropicSelected.length === 0 ? "Pick at least one Anthropic-protocol model above to populate this config." : undefined}
          />
          <AgentCard
            name="Codex CLI"
            protocol="openai"
            configPath="~/.codex/config.toml"
            configPathWindows="%USERPROFILE%\\.codex\\config.toml"
            language="toml"
            config={codexConfig(origin)}
            script={codexOneClickScript(origin, token!)}
            scriptDescription={"Run this in your terminal. It writes config.toml to the standard Codex path AND exports TOKENPARTY_API_KEY into the current shell so the next codex invocation picks it up immediately."}
            envSnippet={codexEnvSnippet(token!)}
            modelHints={openaiSelected.length > 0 ? openaiSelected.map((m) => `codex --model ${m}`) : undefined}
          />
        </section>
      )}

      <footer className="text-xs text-gray-500 text-center pt-2 pb-6">
        TokenParty routes requests to the right upstream provider based on the model name — your local agent just sends the chosen model id to the base URL above.
      </footer>
    </div>
  );
}
