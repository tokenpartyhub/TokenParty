import { useEffect, useState } from "react";
import { api, getToken, getRole, getUserName } from "../lib/api";

// AgentSetup — copy-paste-ready Coding Agent configuration.
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

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
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
      className="text-xs px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600"
    >{copied ? "Copied" : label}</button>
  );
}

function CodeBlock({ value, language }: { value: string; language: "json" | "toml" | "sh" }) {
  return (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 rounded-md p-4 text-xs leading-relaxed overflow-x-auto whitespace-pre">{value}</pre>
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

function maskToken(t: string): string {
  if (t.length <= 10) return t.slice(0, 3) + "****";
  return t.slice(0, 6) + "****" + t.slice(-4);
}

// Fetches the available model list once on mount. The picker is
// purely informational on this page (OpenClaw/Codex configs use the
// full list, and Claude Code\'s slot mapping gets its options from
// the Anthropic subset) - no client-side selection state is needed.
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

// Read-only model availability list for Common Setup. One row per
// model, with a small protocol badge so the user can see at a glance
// which agent each model can be used with.
function AvailableModelsList({ models }: { models: AvailableModel[] }) {
  if (models.length === 0) {
    return <p className="text-sm text-gray-400 italic">No models are configured. Add a provider in Settings first.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {models.map((m) => (
        <span key={m.id} className="inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded border border-gray-200 bg-gray-50 text-gray-800">
          {m.id}
          {m.protocols.has("anthropic") && (
            <span className="text-[9px] uppercase tracking-wide text-purple-600 bg-purple-50 rounded px-1">A</span>
          )}
          {m.protocols.has("openai") && (
            <span className="text-[9px] uppercase tracking-wide text-green-600 bg-green-50 rounded px-1">O</span>
          )}
        </span>
      ))}
    </div>
  );
}

// Reusable checkbox list of model ids. Used by the OpenClaw and
// Codex cards so the user can scope which models the generated
// config + curl command actually reference. Default state is set
// by the caller (we seed with everything available).
function ModelCheckboxGroup({
  title, subtitle, color, models, selected, onChange,
}: {
  title: string;
  subtitle: string;
  color: "purple" | "green";
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
  const badge = color === "purple" ? "bg-purple-100 text-purple-700" : "bg-green-100 text-green-700";
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
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className={"text-xs px-2 py-0.5 rounded-full font-medium " + badge}>{title}</span>
          <span className="ml-2 text-xs text-gray-500">{subtitle}</span>
        </div>
        <button type="button" onClick={toggleAll} className="text-xs text-blue-600 hover:text-blue-800">
          {allOn ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {models.map((m) => (
          <label key={m} className="flex items-center gap-2 px-3 py-2 border rounded hover:bg-gray-50 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(m)}
              onChange={() => toggle(m)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm font-mono text-gray-800 truncate">{m}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Claude Code maps its internal model presets to upstream models via
// five named env vars. The dropdowns in the Claude card let the user
// point each at one of the available Anthropic-protocol models.
type ClaudeSlot = "main" | "sonnet" | "haiku" | "opus" | "reasoning";

const CLAUDE_SLOTS: { id: ClaudeSlot; envVar: string; label: string; hint: string }[] = [
  { id: "main", envVar: "ANTHROPIC_MODEL", label: "Main", hint: "Default when no model is given" },
  { id: "sonnet", envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet preset", hint: "/model sonnet" },
  { id: "haiku", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku preset", hint: "/model haiku" },
  { id: "opus", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus preset", hint: "/model opus" },
  { id: "reasoning", envVar: "ANTHROPIC_REASONING_MODEL", label: "Reasoning preset", hint: "extended thinking" },
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

function codexConfig(origin: string) {
  return "[model_providers.tokenparty]\n" +
    "name = \"TokenParty\"\n" +
    "base_url = \"" + origin + "/v1\"\n" +
    "env_key = \"TOKENPARTY_API_KEY\"\n" +
    "wire_api = \"chat\"\n" +
    "requires_openai_auth = false\n" +
    "request_max_retries = 4\n" +
    "stream_max_retries = 10\n" +
    "stream_idle_timeout_ms = 300000";
}

function codexEnvSnippet(token: string) {
  return "export TOKENPARTY_API_KEY=\"" + token + "\"";
}

// One-click commands. The script tab is a single line: curl the
// TokenParty instance\'s /setup/<agent> endpoint, which is expected
// (future work) to read the user\'s existing config, patch only the
// TokenParty fields, and leave the rest alone. We URL-encode values
// for query-string safety.

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

type AgentTab = "manual" | "oneclick";

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
  const badge = protocol === "anthropic"
    ? "bg-purple-100 text-purple-700"
    : "bg-green-100 text-green-700";
  const protocolLabel = protocol === "anthropic" ? "Anthropic protocol" : "OpenAI protocol";

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{name}</h3>
          <span className={"inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium " + badge}>{protocolLabel}</span>
        </div>
      </div>

      <div className="px-5 pt-4 flex gap-1 border-b border-gray-100">
        <button
          type="button"
          onClick={() => setTab("manual")}
          className={"text-sm px-4 py-2 -mb-px rounded-t border-b-2 " + (tab === "manual" ? "border-blue-600 text-blue-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700")}
        >
          Manual config
        </button>
        <button
          type="button"
          onClick={() => setTab("oneclick")}
          className={"text-sm px-4 py-2 -mb-px rounded-t border-b-2 " + (tab === "oneclick" ? "border-blue-600 text-blue-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700")}
        >
          One-click script
        </button>
      </div>

      {tab === "manual" ? (
        <div className="p-5 space-y-4">
          {manualExtras}
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
            <CodeBlock value={config} language={language} />
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
        </div>
      ) : (
        <div className="p-5 space-y-3">
          <p className="text-sm text-gray-600">{oneClickHint}</p>
          <CodeBlock value={oneClickCommand} language="sh" />
          <p className="text-xs text-gray-500">
            The endpoint is expected to merge the TokenParty settings into the agent\'s existing config and leave everything else alone.
          </p>
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

  // Available models filtered by protocol. Used by OpenClaw\'s config
  // (anthropic) and Claude Code\'s slot dropdowns (anthropic).
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
  // under the user's control afterwards. The selected set drives the
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
      <header>
        <h2 className="text-2xl font-bold text-gray-900">Agent Setup</h2>
        <p className="text-sm text-gray-600 mt-1">
          Connect Claude Code, OpenClaw, or Codex CLI to TokenParty. Confirm the connection, tweak Claude\'s 5 model slots if needed, then copy the config or run the one-click script.
        </p>
      </header>

      {!loggedIn && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-800">
          You are not signed in. <a href="/login" className="underline font-medium">Log in</a> first - the token below will populate automatically once you do.
        </div>
      )}

      <section className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Common Setup</h3>
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
            API token {userLabel ? <span className="text-gray-400 normal-case">- {userLabel}</span> : null}
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
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Available models</div>
          {modelsError && <p className="text-sm text-red-700">Could not load models: {modelsError}</p>}
          {models === null && !modelsError && <p className="text-sm text-gray-400">Loading models...</p>}
          {models && (
            <>
              <AvailableModelsList models={models} />
              <p className="text-xs text-gray-500 mt-2">
                <span className="text-purple-600 font-semibold">A</span> = Anthropic protocol (Claude Code, OpenClaw). <span className="text-green-600 font-semibold">O</span> = OpenAI protocol (Codex CLI). Models you can route to TokenParty are the ones listed here.
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
        <section className="space-y-4">
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
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Model mapping <span className="text-gray-400 normal-case">- bind each Claude Code preset slot to a TokenParty model</span>
                </div>
                {availableAnthropic.length === 0 ? (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    No Anthropic-protocol models are available. Add a provider in Settings first.
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
                          {availableAnthropic.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <div className="mt-0.5 text-[11px] font-mono text-gray-400 truncate">{slot.envVar}</div>
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
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Models <span className="text-gray-400 normal-case">- which Anthropic-protocol models to include in the providers block</span>
                </div>
                <ModelCheckboxGroup
                  title="Anthropic protocol"
                  subtitle="visible to OpenClaw"
                  color="purple"
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
            config={codexConfig(origin)}
            envSnippet={codexEnvSnippet(token!)}
            oneClickCommand={codexOneClickCommand(origin, token!, [...codexSelected])}
            oneClickHint={"Run this in your terminal. The endpoint writes config.toml to the standard Codex path AND exports TOKENPARTY_API_KEY into the current shell so the next codex invocation works immediately."}
            manualExtras={
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Models <span className="text-gray-400 normal-case">- which OpenAI-protocol models to register with the /setup endpoint</span>
                </div>
                <ModelCheckboxGroup
                  title="OpenAI protocol"
                  subtitle="visible to Codex CLI"
                  color="green"
                  models={availableOpenai}
                  selected={codexSelected}
                  onChange={setCodexSelected}
                />
                <p className="text-xs text-gray-500 mt-2">
                  Codex\'s config.toml does not list models directly - they are picked at runtime via <InlineCode>codex --model &lt;id&gt;</InlineCode>. The selection above drives what gets passed to the setup endpoint; the displayed config.toml is the same minimal provider block.
                </p>
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
