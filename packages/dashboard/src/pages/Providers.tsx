import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";

type ModelConfig = string | { id: string; inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number; priority?: number };

interface Provider {
  id: string;
  type: string;
  name: string;
  apiKey: string | string[];
  baseUrl: string;
  models: ModelConfig[];
  enabled: boolean;
  group?: string;
  currency?: string;
}

function getModelId(m: ModelConfig): string {
  return typeof m === "string" ? m : m.id;
}

// Mirror of router.ts sort keys: priority asc (unset=Infinity), then price asc (unset=Infinity)
function getModelPriority(m: ModelConfig): number {
  if (typeof m === "object" && m.priority !== undefined) return m.priority;
  return Infinity;
}

function getModelCost(m: ModelConfig): number {
  if (typeof m === "string") return Infinity;
  const input = m.inputPrice ?? Infinity;
  const output = m.outputPrice ?? Infinity;
  const cost = input + output;
  return Number.isFinite(cost) ? cost : Infinity;
}

function getModelPricing(m: ModelConfig): { inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number } | undefined {
  if (typeof m === "string") return undefined;
  if (m.inputPrice === undefined && m.outputPrice === undefined && m.cacheReadPrice === undefined && m.cacheWritePrice === undefined) return undefined;
  return { inputPrice: m.inputPrice, outputPrice: m.outputPrice, cacheReadPrice: m.cacheReadPrice, cacheWritePrice: m.cacheWritePrice };
}

function normalizeModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((m) => {
    if (typeof m === "string") return m;
    // Keep as object if any field is set (price or priority)
    if (m.inputPrice === undefined && m.outputPrice === undefined && m.cacheReadPrice === undefined && m.cacheWritePrice === undefined && m.priority === undefined) return m.id;
    return m;
  });
}

const UNGROUPED = "__ungrouped__";

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [emptyGroups, setEmptyGroups] = useState<Set<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [view, setView] = useState<"providers" | "routing">("providers");
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = () => api.getProviders().then(setProviders).catch(console.error);
  useEffect(() => { load(); }, []);

  const providerGroups = [...new Set(providers.map((p) => p.group).filter(Boolean))] as string[];
  const allGroups = [...new Set([...providerGroups, ...emptyGroups])].sort();

  const groupedProviders = (group: string) =>
    group === UNGROUPED
      ? providers.filter((p) => !p.group)
      : providers.filter((p) => p.group === group);

  const save = async () => {
    if (!editing) return;
    const data = { ...editing };
    if (Array.isArray(data.apiKey)) {
      const keys = data.apiKey.filter((k) => k.trim());
      data.apiKey = keys.length === 1 ? keys[0] : keys;
    }
    data.models = normalizeModels(data.models ?? []);
    try {
      if (isNew) {
        await api.createProvider(data);
      } else {
        await api.updateProvider(data.id!, data);
      }
      setEditing(null);
      load();
    } catch (e: any) {
      alert(`保存失败：${e.message}`);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this provider?")) return;
    await api.deleteProvider(id);
    load();
  };

  const updateModel = (index: number, field: string, value: any) => {
    const models = [...(editing?.models ?? [])];
    let model = models[index];
    if (typeof model === "string") {
      model = { id: model };
    }
    (model as any)[field] = value;
    models[index] = model;
    setEditing({ ...editing, models });
  };

  const addModel = () => {
    setEditing({ ...editing, models: [...(editing?.models ?? []), ""] });
  };

  const removeModel = (index: number) => {
    const models = [...(editing?.models ?? [])];
    models.splice(index, 1);
    setEditing({ ...editing, models });
  };

  // Fetch available models from the upstream provider and merge them into the
  // current model list. Existing model entries keep their config (price,
  // priority); newly detected ones are appended as bare strings.
  const detectModels = async () => {
    if (!editing?.id) {
      setDetectMsg({ kind: "err", text: "Save the provider first before detecting models." });
      return;
    }
    setDetecting(true);
    setDetectMsg(null);
    try {
      const { models: detected } = await api.detectModels(editing.id);
      const existing = [...(editing.models ?? [])];
      const existingIds = new Set(existing.map(getModelId));
      const added: string[] = [];
      for (const id of detected) {
        if (!existingIds.has(id)) {
          existing.push(id);
          added.push(id);
        }
      }
      setEditing({ ...editing, models: existing });
      setDetectMsg({
        kind: "ok",
        text: added.length > 0
          ? `Detected ${detected.length} model(s), added ${added.length} new: ${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""}`
          : `Detected ${detected.length} model(s), all already configured.`,
      });
    } catch (e: any) {
      setDetectMsg({ kind: "err", text: e.message || "Detection failed" });
    } finally {
      setDetecting(false);
    }
  };

  const createGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    setEmptyGroups((prev) => new Set([...prev, name]));
    setNewGroupName("");
    setShowNewGroupInput(false);
  };

  const renameGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) { setEditingGroup(null); return; }
    const inGroup = providers.filter((p) => p.group === oldName);
    for (const p of inGroup) {
      await api.updateProvider(p.id, { group: trimmed });
    }
    setEmptyGroups((prev) => {
      const next = new Set(prev);
      next.delete(oldName);
      next.add(trimmed);
      return next;
    });
    setEditingGroup(null);
    load();
  };

  const deleteGroup = async (group: string) => {
    const inGroup = providers.filter((p) => p.group === group);
    if (inGroup.length > 0 && !confirm(`Move ${inGroup.length} provider(s) to Ungrouped and delete group "${group}"?`)) return;
    for (const p of inGroup) {
      await api.updateProvider(p.id, { group: null });
    }
    setEmptyGroups((prev) => {
      const next = new Set(prev);
      next.delete(group);
      return next;
    });
    load();
  };

  const handleDrop = async (targetGroup: string) => {
    setDragOverGroup(null);
    if (!draggedId) return;
    const provider = providers.find((p) => p.id === draggedId);
    if (!provider) return;
    const newGroup = targetGroup === UNGROUPED ? null : targetGroup;
    if (provider.group === (newGroup ?? undefined)) return;
    await api.updateProvider(provider.id, { group: newGroup });
    load();
    setDraggedId(null);
  };

  const renderGroupSection = (group: string, label: string, isUngrouped: boolean) => {
    const items = groupedProviders(group);
    const isOver = dragOverGroup === group;
    return (
      <div
        key={group}
        className={`rounded-lg border-2 border-dashed p-4 transition-colors ${isOver ? "border-indigo-400 bg-indigo-50/50" : "border-gray-200 bg-white"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOverGroup(group); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOverGroup(null); }}
        onDrop={(e) => { e.preventDefault(); handleDrop(group); }}
      >
        <div className="flex items-center justify-between mb-3">
          {!isUngrouped && editingGroup === group ? (
            <input
              autoFocus
              type="text"
              value={editingGroupName}
              onChange={(e) => setEditingGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") renameGroup(group, editingGroupName); if (e.key === "Escape") setEditingGroup(null); }}
              onBlur={() => renameGroup(group, editingGroupName)}
              className="text-sm font-semibold text-gray-700 uppercase tracking-wide border-b border-indigo-400 outline-none bg-transparent px-0 py-0"
            />
          ) : (
            <h3
              className={`text-sm font-semibold text-gray-700 uppercase tracking-wide ${!isUngrouped ? "cursor-pointer hover:text-indigo-600" : ""}`}
              onClick={() => { if (!isUngrouped) { setEditingGroup(group); setEditingGroupName(group); } }}
            >
              {label}
            </h3>
          )}
          {!isUngrouped && editingGroup !== group && (
            <button onClick={() => deleteGroup(group)} className="text-xs text-red-500 hover:text-red-700">Delete Group</button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded">
            Drag providers here
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map((p) => (
              <div
                key={p.id}
                draggable
                onDragStart={() => setDraggedId(p.id)}
                onDragEnd={() => { setDraggedId(null); setDragOverGroup(null); }}
                className={`bg-gray-50 rounded-lg p-3 flex items-center justify-between cursor-grab active:cursor-grabbing border ${draggedId === p.id ? "opacity-50 border-indigo-300" : "border-transparent hover:border-gray-300"}`}
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm">{p.name}</div>
                  <div className="text-xs text-gray-500 truncate">{p.type} &middot; {p.baseUrl}</div>
                  <div className="text-xs text-gray-400 font-mono mt-0.5">
                    {Array.isArray(p.apiKey) ? `${p.apiKey.length} keys` : p.apiKey}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Models: {p.models?.map((m) => getModelId(m)).join(", ") || "none"}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-3 shrink-0">
                  <span className={`px-2 py-0.5 rounded text-xs ${p.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {p.enabled ? "Active" : "Disabled"}
                  </span>
                  <button onClick={() => { setEditing(p); setIsNew(false); setDetectMsg(null); }} className="text-xs text-indigo-600 hover:underline">Edit</button>
                  <button onClick={() => remove(p.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Providers</h2>
        <div className="flex gap-2">
          {view === "providers" && (
            <>
              {showNewGroupInput ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") createGroup(); if (e.key === "Escape") setShowNewGroupInput(false); }}
                    placeholder="Group name"
                    className="border rounded px-2 py-1.5 text-sm w-36"
                  />
                  <button onClick={createGroup} className="px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700">Add</button>
                  <button onClick={() => setShowNewGroupInput(false)} className="px-2 py-1.5 border rounded text-sm">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewGroupInput(true)}
                  className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50"
                >
                  New Group
                </button>
              )}
              <button
                onClick={() => { setEditing({ type: "openai", models: [], enabled: true }); setIsNew(true); setDetectMsg(null); }}
                className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
              >
                Add Provider
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b">
        <button
          onClick={() => setView("providers")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${view === "providers" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Providers
        </button>
        <button
          onClick={() => setView("routing")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${view === "routing" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Model Routing
        </button>
      </div>

      {view === "routing" ? (
        <RoutingView providers={providers} onEdit={(p) => { setEditing(p); setIsNew(false); setDetectMsg(null); }} />
      ) : (
        <div className="space-y-4">
          {allGroups.map((g) => renderGroupSection(g, g, false))}
          {renderGroupSection(UNGROUPED, "Ungrouped", true)}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-[900px] max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">{isNew ? "Add" : "Edit"} Provider</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.enabled ?? true}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="flex gap-6">
              {/* Left: Connection */}
              <div className="flex-1 space-y-3 min-w-0">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <Field label="Name" value={editing.name ?? ""} onChange={(v) => setEditing({ ...editing, name: v })} />
                  </div>
                  <div className="w-32">
                    <label className="block text-sm text-gray-600 mb-1">Type</label>
                    <select
                      value={editing.type ?? "openai"}
                      onChange={(e) => setEditing({ ...editing, type: e.target.value })}
                      className="w-full border rounded px-3 py-2 text-sm"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </div>
                </div>
                <Field label="Base URL" value={editing.baseUrl ?? ""} onChange={(v) => setEditing({ ...editing, baseUrl: v })} />
                <div>
                  <label className="block text-sm text-gray-600 mb-1">API Keys</label>
                  <div className="space-y-1.5">
                    {(Array.isArray(editing.apiKey) ? editing.apiKey : [editing.apiKey ?? ""]).map((key, i, arr) => (
                      <div key={i} className="flex gap-1.5">
                        <input
                          type="text"
                          value={key}
                          onChange={(e) => {
                            const keys = [...arr];
                            keys[i] = e.target.value;
                            setEditing({ ...editing, apiKey: keys.length === 1 ? keys[0] : keys });
                          }}
                          placeholder="sk-your-api-key"
                          className="flex-1 border rounded px-3 py-1.5 text-sm font-mono"
                        />
                        {arr.length > 1 && (
                          <button
                            onClick={() => {
                              const keys = arr.filter((_, j) => j !== i);
                              setEditing({ ...editing, apiKey: keys.length === 1 ? keys[0] : keys });
                            }}
                            className="text-red-400 hover:text-red-600 px-1.5 text-sm"
                          >×</button>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        const keys = Array.isArray(editing.apiKey) ? [...editing.apiKey, ""] : [editing.apiKey ?? "", ""];
                        setEditing({ ...editing, apiKey: keys });
                      }}
                      className="text-xs text-indigo-600 hover:underline"
                    >+ Add key</button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Multiple keys enable load balancing</p>
                </div>
              </div>

              {/* Divider */}
              <div className="w-px bg-gray-200 shrink-0" />

              {/* Right: Models */}
              <div className="flex-1 space-y-3 min-w-0">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-gray-600 font-medium">Models</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={detectModels}
                      disabled={detecting || !editing.id}
                      title={editing.id ? "Fetch available models from the upstream /v1/models endpoint" : "Save the provider first"}
                      className="text-xs text-indigo-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                    >
                      {detecting ? "Detecting…" : "Detect Models"}
                    </button>
                    <label className="text-xs text-gray-500">Currency</label>
                    <select
                      value={editing.currency ?? "USD"}
                      onChange={(e) => setEditing({ ...editing, currency: e.target.value })}
                      className="border rounded px-2 py-1 text-xs"
                    >
                      <option value="USD">$ USD</option>
                      <option value="CNY">¥ CNY</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  {(editing.models ?? []).map((m, i) => {
                    const sym = (editing.currency ?? "USD") === "CNY" ? "¥" : "$";
                    return (
                      <div key={i} className="border rounded p-2 space-y-1.5">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={getModelId(m)}
                            onChange={(e) => updateModel(i, "id", e.target.value)}
                            placeholder="model-id"
                            className="flex-1 border rounded px-2 py-1.5 text-sm font-mono"
                          />
                          <button onClick={() => removeModel(i)} className="text-red-500 hover:text-red-700 px-2 py-1.5 text-sm">×</button>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5">
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.priority ?? "") : ""}
                            onChange={(e) => updateModel(i, "priority", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder="Prio"
                            title="Priority (lower = higher priority, for multi-provider same-model fallback chain)"
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.inputPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "inputPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`In ${sym}/1M`}
                            title={`Input price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.outputPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "outputPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`Out ${sym}/1M`}
                            title={`Output price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.cacheReadPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "cacheReadPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`CR ${sym}/1M`}
                            title={`Cache read price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.cacheWritePrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "cacheWritePrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`CW ${sym}/1M`}
                            title={`Cache write price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                        </div>
                      </div>
                    );
                  })}
                  <button onClick={addModel} type="button" className="text-sm text-indigo-600 hover:underline">+ Add model</button>
                  <div className="text-xs text-gray-400">Priority: lower number = higher priority. When multiple providers serve the same model, they are ordered by priority (then price). On 429/5xx/network error, the next provider is tried automatically. Prices per 1M tokens (optional).</div>
                  {detectMsg && (
                    <div className={`text-xs rounded px-2 py-1.5 ${detectMsg.kind === "ok" ? "bg-green-50 text-green-700 border border-green-100" : "bg-red-50 text-red-700 border border-red-100"}`}>
                      {detectMsg.text}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border rounded text-sm">Cancel</button>
              <button onClick={save} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Model-centric routing view: groups providers by (model id, protocol)
// since 0.0.22 the proxy no longer auto-converts between Anthropic
// and OpenAI wire formats. Each entry endpoint only reaches providers
// that match its protocol, so a model with both `type=anthropic` and
// `type=openai` providers has TWO independent fallback chains — one
// per entry endpoint. Showing them in one chain would imply a
// fallback that can no longer happen.
function RoutingView({ providers, onEdit }: { providers: Provider[]; onEdit: (p: Provider) => void }) {
  // Aggregate: (modelId, type) -> list of { provider, modelConfig }
  const byChain = new Map<string, { provider: Provider; model: ModelConfig; type: string }[]>();
  for (const p of providers) {
    for (const m of p.models ?? []) {
      const id = getModelId(m);
      if (!id) continue;
      const key = `${p.type}::${id}`;
      if (!byChain.has(key)) byChain.set(key, []);
      byChain.get(key)!.push({ provider: p, model: m, type: p.type });
    }
  }

  // Sort each chain's candidates the same way router.ts does
  for (const list of byChain.values()) {
    list.sort((a, b) => {
      const prioDiff = getModelPriority(a.model) - getModelPriority(b.model);
      if (prioDiff !== 0) return prioDiff;
      return getModelCost(a.model) - getModelCost(b.model);
    });
  }

  // Chains with more (enabled) providers first — those are the ones with
  // real fallback chains worth attention.
  const chainEntries = [...byChain.entries()].sort((a, b) => {
    const ae = a[1].filter((x) => x.provider.enabled).length;
    const be = b[1].filter((x) => x.provider.enabled).length;
    if (be !== ae) return be - ae;
    return a[0].localeCompare(b[0]);
  });

  if (chainEntries.length === 0) {
    return <div className="text-sm text-gray-400 text-center py-12">No models configured.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500 bg-indigo-50 border border-indigo-100 rounded px-3 py-2">
        Each row is one <b>(model, entry protocol)</b> pair. Same model across anthropic and openai
        providers is shown as two rows because cross-protocol fallback is no longer supported —
        an <code>/anthropic</code> request can only hit anthropic-type providers.
        Solid arrow = primary path; dashed arrow = tried on <b>429 / 5xx / network error</b>.
        Disabled providers are dimmed.
      </div>
      {chainEntries.map(([key, list]) => {
        const [type, modelId] = key.split("::");
        const entry = type === "anthropic" ? "/anthropic/v1/messages" : "/v1/chat/completions";
        const enabledCount = list.filter((x) => x.provider.enabled).length;
        return (
          <div key={key} className="border rounded-lg bg-white overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border-b">
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                type === "anthropic"
                  ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
                  : "bg-emerald-100 text-emerald-700 border border-emerald-200"
              }`}>{type}</span>
              <span className="font-mono font-semibold text-sm">{modelId}</span>
              <span className="text-xs text-gray-400">·</span>
              <span className="text-xs text-gray-500">
                {enabledCount} provider{enabledCount !== 1 ? "s" : ""}
                {enabledCount > 1 && <span className="ml-1 text-indigo-600">→ fallback chain</span>}
              </span>
              <span className="text-xs text-gray-400 ml-auto font-mono">{entry}</span>
            </div>
            <div className="px-4 py-4 overflow-x-auto">
              <div className="flex items-stretch gap-0 min-w-max">
                {/* Client node */}
                <FlowNode label="Client" sub="request" tone="client" />
                <FlowArrow label="route" dashed={false} />
                {list.map((entry, idx) => {
                  const { provider, model } = entry;
                  const isPrimary = idx === 0 && provider.enabled;
                  const pricing = getModelPricing(model);
                  const prio = getModelPriority(model);
                  const sym = (provider.currency ?? "USD") === "CNY" ? "¥" : "$";
                  const isLast = idx === list.length - 1;
                  return (
                    <FlowFragment
                      key={provider.id}
                      idx={idx}
                      isPrimary={isPrimary}
                      provider={provider}
                      prio={prio}
                      pricing={pricing}
                      sym={sym}
                      enabled={provider.enabled}
                      onEdit={() => onEdit(provider)}
                      isLast={isLast}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A provider node plus the arrow that follows it (if not last).
function FlowFragment({
  idx, isPrimary, provider, prio, pricing, sym, enabled, onEdit, isLast,
}: {
  idx: number;
  isPrimary: boolean;
  provider: Provider;
  prio: number;
  pricing: { inputPrice?: number; outputPrice?: number } | undefined;
  sym: string;
  enabled: boolean;
  onEdit: () => void;
  isLast: boolean;
}) {
  return (
    <>
      <FlowNode
        label={provider.name}
        sub={provider.id}
        tone={isPrimary ? "primary" : enabled ? "fallback" : "off"}
        badge={
          <>
            <span className="text-[10px]" title="Priority">
              <span className="text-gray-400">p</span>
              <span className={prio !== Infinity ? "text-indigo-600 font-medium" : "text-gray-400"}>{prio !== Infinity ? prio : "—"}</span>
            </span>
            {pricing ? (
              <span className="text-[10px] font-mono text-gray-500" title="input / output per 1M">
                {sym}{pricing.inputPrice ?? "—"}/{sym}{pricing.outputPrice ?? "—"}
              </span>
            ) : (
              <span className="text-[10px] text-gray-400" title="No price">no $</span>
            )}
          </>
        }
        order={idx + 1}
        onClick={onEdit}
      />
      {!isLast && <FlowArrow label={enabled ? "on fail" : ""} dashed />}
    </>
  );
}

type FlowTone = "client" | "primary" | "fallback" | "off";

function FlowNode({
  label, sub, tone, badge, order, onClick,
}: {
  label: string;
  sub?: string;
  tone: FlowTone;
  badge?: ReactNode;
  order?: number;
  onClick?: () => void;
}) {
  const toneStyles: Record<FlowTone, { box: string; dot: string; text: string }> = {
    client: { box: "border-gray-300 bg-gray-50", dot: "bg-gray-500", text: "text-gray-700" },
    primary: { box: "border-green-400 bg-green-50", dot: "bg-green-500", text: "text-green-700" },
    fallback: { box: "border-indigo-300 bg-indigo-50/60", dot: "bg-indigo-400", text: "text-indigo-700" },
    off: { box: "border-gray-200 bg-gray-50 opacity-50", dot: "bg-gray-300", text: "text-gray-500" },
  };
  const s = toneStyles[tone];
  return (
    <div
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center w-32 min-h-[72px] border-2 rounded-lg px-2 py-1.5 text-center ${s.box} ${onClick ? "cursor-pointer hover:shadow-sm" : ""}`}
    >
      {order !== undefined && (
        <span className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-white border border-gray-300 text-[10px] font-medium flex items-center justify-center text-gray-600">
          {order}
        </span>
      )}
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
        <span className={`text-xs font-medium truncate max-w-[100px] ${s.text}`} title={label}>{label}</span>
      </div>
      {sub && <span className="text-[10px] text-gray-400 font-mono truncate max-w-[110px]" title={sub}>{sub}</span>}
      {badge && <div className="flex items-center gap-1.5 mt-0.5">{badge}</div>}
    </div>
  );
}

function FlowArrow({ label, dashed }: { label?: string; dashed?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center w-12 shrink-0">
      {label ? <span className="text-[10px] text-gray-400 mb-0.5 whitespace-nowrap">{label}</span> : <span className="h-[14px]" />}
      <div className={`h-0.5 w-full ${dashed ? "border-t-2 border-dashed border-amber-400" : "bg-gray-300"} relative`}>
        <span className={`absolute right-0 top-1/2 -translate-y-1/2 text-xs ${dashed ? "text-amber-400" : "text-gray-400"}`}>▶</span>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border rounded px-3 py-2 text-sm"
      />
    </div>
  );
}
