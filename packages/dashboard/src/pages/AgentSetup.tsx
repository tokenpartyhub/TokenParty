import { useEffect, useState } from "react";
import { api, getToken, getRole, getUserName } from "../lib/api";

// AgentSetup - copy-paste-ready Coding Agent configuration.
//
// Three things are auto-discovered:
//   1. The TokenParty URL (from window.location.origin - the dashboard
//      itself is served by the same instance the agent will talk to).
//   2. The user\'s API token (from auth storage via getToken()).
//   3. The list of models TokenParty currently routes for, fetched via
//      api.getModels() + api.getProviders() so each model is tagged
//      with the protocols (anthropic / openai) it can be served over.
//
// The user only has to:
//   - confirm the connection details
//   - tweak Claude Code\'s 5 model slots (only Claude needs explicit
//     slot-to-model mapping; OpenClaw and Codex take the available list
//     as-is)
//   - copy the resulting config or the one-line curl script

type Protocol = "anthropic" | "openai";

interface ProviderInfo { id: string; type: Protocol }
interface AvailableModel { id: string; protocols: Set<Protocol> }

function maskToken(t: string): string {
  if (t.length <= 10) return t.slice(0, 3) + "****";
  return t.slice(0, 6) + "****" + t.slice(-4);
}

// --- Tiny inline SVG icons. We keep these in-file rather than pulling
// in an icon library so the page ships with zero new dependencies. ---

function ClipboardIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  );
}

function CheckIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function LinkIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13.828 10.172a4 4 0 015.656 5.656l-3 3a4 4 0 01-5.656-5.656m-1.656-1.656a4 4 0 01-5.656-5.656l3-3a4 4 0 015.656 5.656" />
    </svg>
  );
}

function KeyIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  );
}

function CopyButton({ value, label = "Copy", className = "text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 inline-flex items-center gap-1.5" }: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch {
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
      className={"transition-colors duration-150 " + className}
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>;
}

function CodeBlock({ value, language }: { value: string; language: "json" | "toml" | "sh" }) {
  return (
    <div className="relative group">
      <pre className="bg-gray-900 text-gray-100 rounded-md p-4 text-sm leading-relaxed overflow-x-auto whitespace-pre font-mono">{value}</pre>
      <div className="absolute top-2 right-2 flex gap-2">
        <span className="text-[10px] uppercase tracking-wide text-gray-300 bg-gray-700 rounded px-1.5 py-0.5">{language}</span>
        <CopyButton value={value} className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 inline-flex items-center gap-1.5 opacity-70 group-hover:opacity-100 transition-opacity duration-150" />
      </div>
    </div>
  );
}

// macOS-Terminal-styled block for the One-click tab. Three colored
// dots on top, a copy button on the right, the command in the body.
function TerminalBlock({ value, language = "sh" }: { value: string; language?: "sh" }) {
  return (
    <div className="rounded-md overflow-hidden border border-gray-800 shadow-md">
      <div className="bg-gray-800 px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500"></span>
          <span className="w-3 h-3 rounded-full bg-yellow-500"></span>
          <span className="w-3 h-3 rounded-full bg-green-500"></span>
          <span className="ml-2 text-xs text-gray-400 font-mono">terminal</span>
        </div>
        <CopyButton value={value} className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 inline-flex items-center gap-1.5" />
      </div>
      <pre className="bg-gray-900 text-green-300 p-4 text-sm font-mono overflow-x-auto whitespace-pre">{value}</pre>
      <div className="bg-gray-800/50 px-3 py-1.5 text-[10px] text-gray-400 font-mono">[{language}]</div>
    </div>
  );
}

// Information card row - icon + label + value + copy. Used for URL
// and Token display in the Common Setup section.
function InfoCard({
  icon, label, value, copyValue, copyLabel = "Copy",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  copyValue: string;
  copyLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-white rounded-md border border-gray-200 hover:border-gray-300 transition-colors duration-150">
      <div className="shrink-0 w-9 h-9 rounded-md bg-indigo-50 text-indigo-600 flex items-center justify-center">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{label}</div>
        <div className="text-sm font-mono text-gray-800 truncate">{value}</div>
      </div>
      <CopyButton value={copyValue} label={copyLabel} />
    </div>
  );
}

// 3-step header indicator. Tells the user at a glance what they need
// to do. The current step is the one matching what the page is
// currently doing (we don\'t track an explicit step state - the
// 3 steps all live on a single page and the user scrolls through
// them, so we just show the progression).
function StepGuide() {
  const steps = [
    { n: 1, title: "Confirm connection", desc: "URL and token are auto-filled from your browser session." },
    { n: 2, title: "Choose models", desc: "Tick the models to expose; map Claude\'s slots if you use Claude Code." },
    { n: 3, title: "Copy config or run script", desc: "Manual config for transparency; one-click curl to write it for you." },
  ];
  return (
    <ol className="flex flex-col sm:flex-row gap-3 sm:gap-0 mt-4">
      {steps.map((s, i) => (
        <li key={s.n} className="flex-1 flex items-start gap-3 sm:pr-4">
          <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xs font-bold flex items-center justify-center shadow-sm">{s.n}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900">{s.title}</div>
            <div className="text-xs text-gray-500 mt-0.5 leading-snug">{s.desc}</div>
          </div>
          {i < steps.length - 1 && (
            <div className="hidden sm:block w-8 h-px bg-gray-200 self-center"></div>
          )}
        </li>
      ))}
    </ol>
  );
}

// Per-protocol color set, used by both the chip list and the agent
// color strips. Keeps the visual language consistent.
const PROTOCOL_THEME: Record<Protocol, { dot: string; chip: string; label: string; bg: string; text: string; ring: string }> = {
  anthropic: {
    dot: "bg-purple-500",
    chip: "border-purple-200 bg-purple-50 text-purple-800",
    label: "Anthropic",
    bg: "bg-purple-50",
    text: "text-purple-700",
    ring: "ring-purple-200",
  },
  openai: {
    dot: "bg-green-500",
    chip: "border-green-200 bg-green-50 text-green-800",
    label: "OpenAI",
    bg: "bg-green-50",
    text: "text-green-700",
    ring: "ring-green-200",
  },
};

// Bigger, hover-aware model chip with full-word protocol labels.
function ModelChip({ model }: { model: AvailableModel }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm font-mono px-3 py-1.5 rounded-md border border-gray-200 bg-white text-gray-800 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition-all duration-150 cursor-default"
      title={model.id}
    >
      <span className="truncate max-w-[16rem]">{model.id}</span>
      {model.protocols.has("anthropic") && (
        <span className={"shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded " + PROTOCOL_THEME.anthropic.chip}>Anthropic</span>
      )}
      {model.protocols.has("openai") && (
        <span className={"shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded " + PROTOCOL_THEME.openai.chip}>OpenAI</span>
      )}
    </span>
  );
}

function AvailableModelsList({ models }: { models: AvailableModel[] }) {
  if (models.length === 0) {
    return <p className="text-sm text-gray-400 italic">No models are configured. Add a provider in Settings first.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {models.map((m) => <ModelChip key={m.id} model={m} />)}
    </div>
  );
}

// Fetches the available model list once on mount. The list is
// purely informational on this page (OpenClaw/Codex configs use the
// user-curated subset, and Claude Code\'s slot mapping gets its
// options from the Anthropic subset) - so we only need it as
// "available to choose from".
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

// Per-card model selection list. Each model is a small card; clicking
// anywhere on it toggles selection. Selected state has a clear visual
// (border + background + checkmark in the top-right corner).
function ModelCheckboxGroup({
  title, subtitle, color, models, selected, onChange,
}: {
  title: string;
  subtitle: string;
  color: Protocol;
  models: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  if (models.length === 0) {
    return (
      <p className="text-sm text-gray-400 italic">
        No models are available for this protocol. Add a provider in Settings first.
      </p>
    );
  }
  const allOn = models.every((m) => selected.has(m));
  const theme = PROTOCOL_THEME[color];
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const toggleAll = () => {
    if (allOn) onChange(new Set());
    else onChange(new Set(models));
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={"text-xs px-2 py-0.5 rounded-full font-semibold " + theme.chip}>{title}</span>
          <span className="text-xs text-gray-500">{subtitle}</span>
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className={"text-xs font-medium px-3 py-1 rounded-md border transition-colors duration-150 " +
            (allOn
              ? "border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
              : "border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100")}
        >
          {allOn ? "Clear all" : "Select all"}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {models.map((m) => {
          const isOn = selected.has(m);
          return (
            <button
              type="button"
              key={m}
              onClick={() => toggle(m)}
              className={
                "relative text-left px-3 py-2.5 rounded-md border-2 transition-all duration-150 " +
                (isOn
                  ? "border-indigo-500 " + theme.bg + " shadow-sm"
                  : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50")
              }
            >
              {isOn && (
                <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center">
                  <CheckIcon className="w-3 h-3" />
                </span>
              )}
              <span className={"text-sm font-mono pr-6 block truncate " + (isOn ? "text-gray-900 font-medium" : "text-gray-700")}>
                {m}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Claude Code maps its internal model presets to upstream models via
// five named env vars. The dropdowns in the Claude card let the user
// point each at one of the available Anthropic-protocol models.
type ClaudeSlot = "main" | "sonnet" | "haiku" | "opus" | "reasoning";

const CLAUDE_SLOTS: { id: ClaudeSlot; envVar: string; label: string; description: string }[] = [
  { id: "main", envVar: "ANTHROPIC_MODEL", label: "Main model", description: "Used when no model is specified" },
  { id: "sonnet", envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet preset", description: "Triggered by /model sonnet" },
  { id: "haiku", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku preset", description: "Triggered by /model haiku" },
  { id: "opus", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus preset", description: "Triggered by /model opus" },
  { id: "reasoning", envVar: "ANTHROPIC_REASONING_MODEL", label: "Reasoning preset", description: "Used for extended thinking" },
];

// Per-agent config generators. All take only the values they actually
// need - no implicit "selected" state. The manual-config body is
// built at render time from these strings.

function claudeCodeConfig(origin: string, token: string, slots: Record<ClaudeSlot, string>) {
  // Always include base URL + auth so the file is self-sufficient even
  // when no model slot has been picked.
  const lines: string[] = [
    "    \"ANTHROPIC_BASE_URL\": \"" + origin + "/anthropic\"",
    "    \"ANTHROPIC_AUTH_TOKEN\": \"" + token + "\"",
  ];
  for (const slot of CLAUDE_SLOTS) {
    const v = slots[slot.id];
    if (!v) continue;
    lines.push("    \"" + slot.envVar + "\": \"" + v + "\"");
  }
  return "{\n  \"env\": {\n" + lines.join(",\n") + "\n  }\n}";
}

function openClawConfig(origin: string, token: string, modelIds: string[]) {
  const modelsBlock = modelIds.map((id) =>
    "          {\n" +
    "            \"id\": \"" + id + "\",\n" +
    "            \"name\": \"" + id + "\",\n" +
    "            \"input\": [\"text\"],\n" +
    "            \"maxTokens\": 8192\n" +
    "          }"
  ).join(",\n");
  return "{\n  \"models\": {\n" +
    "    \"mode\": \"merge\",\n" +
    "    \"providers\": {\n" +
    "      \"token-party\": {\n" +
    "        \"baseUrl\": \"" + origin + "/anthropic\",\n" +
    "        \"apiKey\": \"" + token + "\",\n" +
    "        \"api\": \"anthropic-messages\",\n" +
    "        \"models\": [\n" + modelsBlock + "\n        ]\n" +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "}";
}

function codexConfig(origin: string, modelIds: string[]) {
  // TOML list-of-strings for the provider\'s available models. The
  // selection above drives this directly. Empty array renders as
  // `models = []` (the user just unchecked everything) - emitting
  // `[""]` would be invalid TOML.
  const modelsLine = modelIds.length === 0
    ? "models = []"
    : "models = [\"" + modelIds.join("\", \"") + "\"]";
  return "[model_providers.tokenparty]\n" +
    "name = \"TokenParty\"\n" +
    "base_url = \"" + origin + "/v1\"\n" +
    "env_key = \"TOKENPARTY_API_KEY\"\n" +
    "requires_openai_auth = false\n" +
    "request_max_retries = 4\n" +
    "stream_max_retries = 10\n" +
    "stream_idle_timeout_ms = 300000\n" +
    modelsLine;
}

function codexEnvSnippet(token: string) {
  return "export TOKENPARTY_API_KEY=\"" + token + "\"";
}

function urlEncode(s: string): string {
  return encodeURIComponent(s);
}

function claudeOneClickCommand(origin: string, token: string, slots: Record<ClaudeSlot, string>) {
  const params: string[] = [
    "token=" + urlEncode(token),
    "base_url=" + urlEncode(origin + "/anthropic"),
  ];
  for (const slot of CLAUDE_SLOTS) {
    const v = slots[slot.id];
    if (v) params.push("model_" + slot.id + "=" + urlEncode(v));
  }
  return "curl -sSL \"" + origin + "/setup/claude?" + params.join("&") + "\" | bash";
}

function openclawOneClickCommand(origin: string, token: string, modelIds: string[]) {
  const params = [
    "token=" + urlEncode(token),
    "base_url=" + urlEncode(origin + "/anthropic"),
    "models=" + urlEncode(modelIds.join(",")),
  ];
  return "curl -sSL \"" + origin + "/setup/openclaw?" + params.join("&") + "\" | bash";
}

function codexOneClickCommand(origin: string, token: string, modelIds: string[]) {
  const params = [
    "token=" + urlEncode(token),
    "base_url=" + urlEncode(origin + "/v1"),
  ];
  if (modelIds.length > 0) params.push("models=" + urlEncode(modelIds.join(",")));
  return "curl -sSL \"" + origin + "/setup/codex?" + params.join("&") + "\" | bash";
}

// Per-agent accent color and short label for the header strip.
const AGENT_THEME: Record<string, { gradient: string; textOn: string; dot: string; emoji: string; shortLabel: string }> = {
  "Claude Code": { gradient: "from-orange-500 via-pink-500 to-purple-500", textOn: "text-white", dot: "bg-white", emoji: "C", shortLabel: "Claude Code" },
  "OpenClaw": { gradient: "from-blue-500 to-cyan-500", textOn: "text-white", dot: "bg-white", emoji: "O", shortLabel: "OpenClaw" },
  "Codex CLI": { gradient: "from-green-500 to-emerald-500", textOn: "text-white", dot: "bg-white", emoji: "X", shortLabel: "Codex CLI" },
};

function AgentHeader({ name, protocol }: { name: string; protocol: Protocol }) {
  const theme = AGENT_THEME[name] ?? { gradient: "from-gray-500 to-gray-600", textOn: "text-white", dot: "bg-white", emoji: "?", shortLabel: name };
  const proto = PROTOCOL_THEME[protocol];
  return (
    <div className={"rounded-t-lg bg-gradient-to-r " + theme.gradient + " px-5 py-3 flex items-center justify-between gap-3"}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={"shrink-0 w-9 h-9 rounded-md bg-white/20 backdrop-blur-sm flex items-center justify-center font-bold text-lg " + theme.textOn}>
          {theme.emoji}
        </div>
        <div className="min-w-0">
          <h3 className={"text-lg font-semibold " + theme.textOn}>{theme.shortLabel}</h3>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={"w-1.5 h-1.5 rounded-full " + theme.dot}></span>
            <span className={"text-xs " + theme.textOn + " opacity-90"}>{proto.label} protocol</span>
          </div>
        </div>
      </div>
    </div>
  );
}

type AgentTab = "manual" | "oneclick";

function AgentTabBar({ tab, onChange }: { tab: AgentTab; onChange: (t: AgentTab) => void }) {
  const items: { id: AgentTab; label: string }[] = [
    { id: "manual", label: "Manual config" },
    { id: "oneclick", label: "One-click script" },
  ];
  return (
    <div className="px-5 pt-4 flex gap-1 border-b border-gray-100 bg-gray-50/50">
      {items.map((it) => (
        <button
          type="button"
          key={it.id}
          onClick={() => onChange(it.id)}
          className={
            "relative text-sm px-4 py-2.5 font-medium transition-colors duration-150 " +
            (tab === it.id
              ? "text-indigo-700"
              : "text-gray-500 hover:text-gray-700")
          }
        >
          {it.label}
          <span
            className={
              "absolute left-0 right-0 bottom-0 h-0.5 rounded-t transition-all duration-200 " +
              (tab === it.id ? "bg-indigo-600" : "bg-transparent")
            }
          ></span>
        </button>
      ))}
    </div>
  );
}

function AgentCard({
  name, protocol, configPath, configPathWindows, language,
  config, envSnippet, oneClickCommand, oneClickHint,
  manualExtras,
}: {
  name: string;
  protocol: Protocol;
  configPath: string;
  configPathWindows?: string;
  language: "json" | "toml" | "sh";
  config: string;
  envSnippet?: string;
  // The single curl | bash line shown in the One-click Script tab.
  oneClickCommand: string;
  oneClickHint: string;
  // Optional node rendered at the top of the Manual tab. Claude Code
  // uses this for the 5-slot model mapping UI; OpenClaw/Codex omit it.
  manualExtras?: React.ReactNode;
}) {
  const [tab, setTab] = useState<AgentTab>("manual");
  return (
    <div className="bg-white rounded-lg shadow-sm hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <AgentHeader name={name} protocol={protocol} />
      <AgentTabBar tab={tab} onChange={setTab} />

      {tab === "manual" ? (
        <div className="p-5 space-y-5">
          {manualExtras}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Config file path</div>
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
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Contents</div>
            <CodeBlock value={config} language={language} />
          </div>
          {envSnippet && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Shell environment</div>
              <CodeBlock value={envSnippet} language="sh" />
              <p className="text-xs text-gray-500 mt-2">
                Add this line to your shell rc (<InlineCode>~/.zshrc</InlineCode>, <InlineCode>~/.bashrc</InlineCode>, etc.) so the Codex provider block above can read the token.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600 leading-relaxed">{oneClickHint}</p>
          <TerminalBlock value={oneClickCommand} language="sh" />
          <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md">
            <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center mt-0.5">!</span>
            <div className="text-xs text-amber-900">
              <span className="font-semibold">Copy &amp; run:</span> the command above contacts your TokenParty instance at <InlineCode>{`{origin}`}/setup/&lt;agent&gt;</InlineCode>. Make sure that endpoint is reachable from the machine you\'re setting up.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentSetup() {
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const { models, error: modelsError } = useAvailableModels();
  const role = getRole();
  const userName = getUserName();

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
    setToken(getToken());
  }, []);

  // Available models filtered by protocol. Drives both the chip list
  // and the per-card selection state.
  const availableAnthropic = (models ?? []).filter((m) => m.protocols.has("anthropic")).map((m) => m.id);
  const availableOpenai = (models ?? []).filter((m) => m.protocols.has("openai")).map((m) => m.id);

  // Claude Code 5-slot model mapping. Defaults every slot to the
  // first Anthropic-protocol model as soon as the list is available,
  // then leaves the user\'s explicit picks alone afterwards.
  const [claudeSlots, setClaudeSlots] = useState<Record<ClaudeSlot, string>>({
    main: "", sonnet: "", haiku: "", opus: "", reasoning: "",
  });
  const [claudeSlotsPrimed, setClaudeSlotsPrimed] = useState(false);
  useEffect(() => {
    if (claudeSlotsPrimed) return;
    if (availableAnthropic.length === 0) return;
    const first = availableAnthropic[0];
    setClaudeSlots({ main: first, sonnet: first, haiku: first, opus: first, reasoning: first });
    setClaudeSlotsPrimed(true);
  }, [availableAnthropic, claudeSlotsPrimed]);

  // OpenClaw + Codex model selection. Both default to "everything
  // available" the moment the model list first arrives, and stay
  // under the user\'s control afterwards. The selected set drives the
  // rendered config body (OpenClaw only) and the curl command for
  // both agents.
  const [openclawSelected, setOpenclawSelected] = useState<Set<string>>(new Set());
  const [openclawPrimed, setOpenclawPrimed] = useState(false);
  useEffect(() => {
    if (openclawPrimed) return;
    if (availableAnthropic.length === 0) return;
    setOpenclawSelected(new Set(availableAnthropic));
    setOpenclawPrimed(true);
  }, [availableAnthropic, openclawPrimed]);

  const [codexSelected, setCodexSelected] = useState<Set<string>>(new Set());
  const [codexPrimed, setCodexPrimed] = useState(false);
  useEffect(() => {
    if (codexPrimed) return;
    if (availableOpenai.length === 0) return;
    setCodexSelected(new Set(availableOpenai));
    setCodexPrimed(true);
  }, [availableOpenai, codexPrimed]);

  const loggedIn = !!token;
  const userLabel = role === "admin" ? "Admin" : (userName ?? "User");

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header className="bg-white rounded-lg shadow-sm p-6 border-l-4 border-indigo-500">
        <h2 className="text-2xl font-bold text-gray-900">Agent Setup</h2>
        <p className="text-sm text-gray-600 mt-1">
          Connect Claude Code, OpenClaw, or Codex CLI to TokenParty. Confirm the connection, tweak Claude\'s 5 model slots if needed, then copy the config or run the one-click script.
        </p>
        <StepGuide />
      </header>

      {!loggedIn && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-800">
          You are not signed in. <a href="/login" className="underline font-medium">Log in</a> first - the token below will populate automatically once you do.
        </div>
      )}

      <section className="bg-gradient-to-br from-indigo-50 via-white to-purple-50 rounded-lg shadow-sm p-6 border border-indigo-100 space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Common Setup</h3>
          <p className="text-xs text-gray-500 mt-1">
            Both values below are auto-detected. You should not need to change them.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <InfoCard
            icon={<LinkIcon className="w-4 h-4" />}
            label="TokenParty URL"
            value={origin || "(loading)"}
            copyValue={origin}
            copyLabel="Copy URL"
          />
          {loggedIn ? (
            <InfoCard
              icon={<KeyIcon className="w-4 h-4" />}
              label={"API token" + (userLabel ? " - " + userLabel : "")}
              value={maskToken(token!)}
              copyValue={token!}
              copyLabel="Copy token"
            />
          ) : (
            <div className="flex items-center gap-3 px-4 py-3 bg-white rounded-md border border-dashed border-gray-300">
              <div className="shrink-0 w-9 h-9 rounded-md bg-gray-100 text-gray-400 flex items-center justify-center"><KeyIcon className="w-4 h-4" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">API token</div>
                <div className="text-sm text-gray-400 italic">No token in storage. Sign in to populate.</div>
              </div>
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Available models</div>
          {modelsError && <p className="text-sm text-red-700">Could not load models: {modelsError}</p>}
          {models === null && !modelsError && <p className="text-sm text-gray-400">Loading models...</p>}
          {models && (
            <>
              <AvailableModelsList models={models} />
              <p className="text-xs text-gray-500 mt-3">
                <span className={"text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded mr-1.5 " + PROTOCOL_THEME.anthropic.chip}>Anthropic</span>
                routed by Claude Code and OpenClaw.
                <span className={"text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded mx-1.5 " + PROTOCOL_THEME.openai.chip}>OpenAI</span>
                routed by Codex CLI.
              </p>
            </>
          )}
        </div>
      </section>

      {!loggedIn ? (
        <div className="text-sm text-gray-500 italic text-center py-6">
          Agent configs will render once you are signed in.
        </div>
      ) : (
        <section className="space-y-5">
          <h3 className="text-lg font-semibold text-gray-900">Agent configs</h3>

          <AgentCard
            name="Claude Code"
            protocol="anthropic"
            configPath="~/.claude/settings.json"
            configPathWindows="%USERPROFILE%\\.claude\\settings.json"
            language="json"
            config={claudeCodeConfig(origin, token!, claudeSlots)}
            oneClickCommand={claudeOneClickCommand(origin, token!, claudeSlots)}
            oneClickHint={"Run this in your terminal. The endpoint reads your existing settings.json, patches only the TokenParty fields (auth token, base URL, and the 5 model slots), and leaves the rest of your config alone."}
            manualExtras={
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Model mapping</span>
                  <span className="text-xs text-gray-400">bind each Claude Code preset slot to a TokenParty model</span>
                </div>
                {availableAnthropic.length === 0 ? (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    No Anthropic-protocol models are available. Add a provider in Settings first.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {CLAUDE_SLOTS.map((slot) => (
                      <label key={slot.id} className="block">
                        <div className="flex items-baseline justify-between mb-1">
                          <span className="text-sm font-medium text-gray-800">{slot.label}</span>
                          <span className="text-[10px] font-mono text-gray-400">{slot.envVar}</span>
                        </div>
                        <select
                          value={claudeSlots[slot.id] || ""}
                          onChange={(e) => setClaudeSlots({ ...claudeSlots, [slot.id]: e.target.value })}
                          className="w-full border-2 border-gray-200 rounded-md px-3 py-2 text-sm font-mono bg-white hover:border-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-colors duration-150 cursor-pointer"
                        >
                          {availableAnthropic.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500 leading-snug">{slot.description}</p>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            }
          />

          <AgentCard
            name="OpenClaw"
            protocol="anthropic"
            configPath="~/.openclaw/openclaw.json"
            configPathWindows="%USERPROFILE%\\.openclaw\\openclaw.json"
            language="json"
            config={openClawConfig(origin, token!, [...openclawSelected])}
            oneClickCommand={openclawOneClickCommand(origin, token!, [...openclawSelected])}
            oneClickHint={"Run this in your terminal. The endpoint merges the TokenParty provider block into models.providers[\"token-party\"] of your existing openclaw.json, leaving other providers and settings intact."}
            manualExtras={
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Models</span>
                  <span className="text-xs text-gray-400">which Anthropic-protocol models to include in the providers block</span>
                </div>
                <ModelCheckboxGroup
                  title="Anthropic protocol"
                  subtitle="visible to OpenClaw"
                  color="anthropic"
                  models={availableAnthropic}
                  selected={openclawSelected}
                  onChange={setOpenclawSelected}
                />
              </div>
            }
          />

          <AgentCard
            name="Codex CLI"
            protocol="openai"
            configPath="~/.codex/config.toml"
            configPathWindows="%USERPROFILE%\\.codex\\config.toml"
            language="toml"
            config={codexConfig(origin, [...codexSelected])}
            envSnippet={codexEnvSnippet(token!)}
            oneClickCommand={codexOneClickCommand(origin, token!, [...codexSelected])}
            oneClickHint={"Run this in your terminal. The endpoint writes config.toml to the standard Codex path AND exports TOKENPARTY_API_KEY into the current shell so the next codex invocation works immediately."}
            manualExtras={
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Models</span>
                  <span className="text-xs text-gray-400">which OpenAI-protocol models to register with the /setup endpoint</span>
                </div>
                <ModelCheckboxGroup
                  title="OpenAI protocol"
                  subtitle="visible to Codex CLI"
                  color="openai"
                  models={availableOpenai}
                  selected={codexSelected}
                  onChange={setCodexSelected}
                />
              </div>
            }
          />
        </section>
      )}

      <footer className="text-xs text-gray-500 text-center pt-2 pb-6">
        TokenParty routes requests to the right upstream provider based on the model name. The local agent just sends the chosen model id to the base URL above.
      </footer>
    </div>
  );
}
