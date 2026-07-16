import { useEffect, useRef, useState, type ReactNode } from "react";
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
  responsesToChat?: boolean;
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
  const [view, setView] = useState<"providers" | "routing" | "aliases">("providers");
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
        <button
          onClick={() => setView("aliases")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${view === "aliases" ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
        >
          Model Aliases
        </button>
      </div>

      {view === "routing" ? (
        <RoutingView providers={providers} onEdit={(p) => { setEditing(p); setIsNew(false); setDetectMsg(null); }} />
      ) : view === "aliases" ? (
        <AliasesView providers={providers} />
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
                {editing.type === "openai" && (
                  <label className="flex items-start gap-2 text-sm text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={editing.responsesToChat ?? false}
                      onChange={(e) => setEditing({ ...editing, responsesToChat: e.target.checked })}
                      className="mt-0.5"
                    />
                    <span>
                      Responses → Chat Completions 转换
                      <span className="block text-xs text-gray-400">上游不支持 /v1/responses 时启用;将 Codex 等 Responses 客户端的请求转为 /chat/completions</span>
                    </span>
                  </label>
                )}
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

type AliasEntry = string | { id: string; priority?: number };

function getAliasId(e: AliasEntry): string {
  return typeof e === "string" ? e : e.id;
}

type DragSource =
  | { kind: "available"; modelId: string }
  | { kind: "pool"; aliasName: string; index: number }
  | { kind: "newpool"; index: number };

function AliasesView({ providers }: { providers: Provider[] }) {
  const [aliases, setAliases] = useState<{ name: string; models: AliasEntry[] }[]>([]);
  const [newPool, setNewPool] = useState<string[]>([]);
  const [newPoolName, setNewPoolName] = useState("");
  const [newPoolNameError, setNewPoolNameError] = useState(false);
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [savingNew, setSavingNew] = useState(false);
  // Map alias name → list of orphan (modelId, index) pairs. The dashboard
  // tints rows that reference an id no longer served by any provider and
  // shows a top-level banner listing affected aliases. Populated locally
  // when the user makes changes, plus when an API call returns orphans.
  const [orphansByAlias, setOrphansByAlias] = useState<Map<string, { modelId: string; index: number }[]>>(new Map());
  // alias name currently being renamed inline
  const [renamingAlias, setRenamingAlias] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const pendingSaveRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const allModelIds = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map(getModelId))
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort();

  // A real model id can appear in multiple alias pools (e.g. gpt-5 might
  // sit in both a "performance" and "daily" pool). The previous
  // usedInPools filter hid ids that were already in *any* pool, which
  // broke that legitimate use case. Now we only exclude ids that the user
  // has dragged into the *current new pool* — duplicate detection within
  // existing pools is handled by handleDrop's `models.includes(modelId)`
  // guard. Cross-pool reuse is allowed.
  const availableModels = allModelIds.filter((id) => !newPool.includes(id));

  const load = () =>
    api
      .getAliases()
      .then((rows) => {
        setAliases(rows);
        // Re-derive ghost entries on every load so removing a model from
        // a provider (without any explicit alias save) still surfaces here.
        const next = new Map<string, { modelId: string; index: number }[]>();
        const liveSet = new Set(allModelIds);
        for (const a of rows) {
          const ghosts: { modelId: string; index: number }[] = [];
          a.models.forEach((entry, i) => {
            const id = getAliasId(entry);
            if (!liveSet.has(id)) ghosts.push({ modelId: id, index: i });
          });
          if (ghosts.length > 0) next.set(a.name, ghosts);
        }
        setOrphansByAlias(next);
      })
      .catch(console.error);
  useEffect(() => { load(); /* re-run when allModelIds changes too */ }, [allModelIds.join("|")]);

  const remove = async (name: string) => {
    if (!confirm(`Delete alias "${name}"?`)) return;
    await api.deleteAlias(name);
    load();
  };

  const beginRename = (name: string) => {
    setRenamingAlias(name);
    setRenameDraft(name);
  };

  const cancelRename = () => {
    setRenamingAlias(null);
    setRenameDraft("");
  };

  const commitRename = async (oldName: string) => {
    const newName = renameDraft.trim();
    setRenamingAlias(null);
    setRenameDraft("");
    if (!newName || newName === oldName) return;
    if (aliases.some((a) => a.name === newName)) {
      alert(`Alias "${newName}" already exists`);
      return;
    }
    try {
      const res = await api.updateAlias(oldName, { name: newName });
      // Server is the source of truth — it returns the resolved name.
      setAliases((prev) => prev.map((a) => (a.name === oldName ? { ...a, name: res.name ?? newName } : a)));
      // Re-key the orphan map so warnings track the renamed alias.
      setOrphansByAlias((prev) => {
        if (!prev.has(oldName)) return prev;
        const next = new Map(prev);
        next.set(res.name ?? newName, next.get(oldName)!);
        next.delete(oldName);
        return next;
      });
      // Any pending debounced save for the old name must be cancelled —
      // it would otherwise fire with a stale URL and either no-op or 404.
      const timers = pendingSaveRef.current;
      const pending = timers.get(oldName);
      if (pending) {
        clearTimeout(pending);
        timers.delete(oldName);
      }
      load();
    } catch (e: any) {
      alert(`Rename failed: ${e.message}`);
    }
  };

  const updateAliasModels = (name: string, models: string[]) => {
    setAliases((prev) => prev.map((a) => (a.name === name ? { ...a, models } : a)));
    const timers = pendingSaveRef.current;
    const existing = timers.get(name);
    if (existing) clearTimeout(existing);
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        api.updateAlias(name, { models }).then((res) => {
          // If server reports a renamed key (rename + edit in flight), sync.
          if (res.name && res.name !== name) {
            setAliases((prev) => prev.map((a) => (a.name === name ? { ...a, name: res.name! } : a)));
          }
        }).catch((e: any) => {
          alert(`Update failed: ${e.message}`);
          load();
        });
      }, 400),
    );
  };

  const saveNewPool = async () => {
    if (!newPoolName.trim()) { setNewPoolNameError(true); return; }
    if (newPool.length === 0) return;
    setSavingNew(true);
    try {
      await api.createAlias({ name: newPoolName, models: newPool });
      setNewPool([]);
      setNewPoolName("");
      setNewPoolNameError(false);
      load();
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSavingNew(false);
    }
  };

  const cancelNewPool = () => {
    setNewPool([]);
    setNewPoolName("");
    setNewPoolNameError(false);
  };

  const removePoolItem = (aliasName: string, index: number) => {
    const alias = aliases.find((a) => a.name === aliasName);
    if (!alias) return;
    const next = alias.models.map(getAliasId).filter((_, i) => i !== index);
    updateAliasModels(aliasName, next);
  };

  const removeNewPoolItem = (index: number) => {
    setNewPool(newPool.filter((_, i) => i !== index));
  };

  const handleDrop = (target: string, targetIdx?: number) => {
    setDropTarget(null);
    if (!dragSource) return;

    if (dragSource.kind === "available") {
      const { modelId } = dragSource;
      if (target === "__newpool__") {
        if (!newPool.includes(modelId)) setNewPool([...newPool, modelId]);
      } else if (target !== "__available__") {
        const alias = aliases.find((a) => a.name === target);
        if (alias) {
          const models = alias.models.map(getAliasId);
          if (!models.includes(modelId)) {
            const insertAt = targetIdx !== undefined ? targetIdx : models.length;
            models.splice(insertAt, 0, modelId);
            updateAliasModels(target, models);
          }
        }
      }
    } else if (dragSource.kind === "pool") {
      const { aliasName, index } = dragSource;
      const srcAlias = aliases.find((a) => a.name === aliasName);
      if (!srcAlias) return;
      const modelId = getAliasId(srcAlias.models[index]);

      if (target === "__newpool__") {
        if (!newPool.includes(modelId)) {
          setNewPool([...newPool, modelId]);
          const srcModels = srcAlias.models.map(getAliasId).filter((_, i) => i !== index);
          updateAliasModels(aliasName, srcModels);
        }
      } else if (target === "__available__") {
        const srcModels = srcAlias.models.map(getAliasId).filter((_, i) => i !== index);
        updateAliasModels(aliasName, srcModels);
      } else {
        const dstAlias = aliases.find((a) => a.name === target);
        if (!dstAlias) return;
        const dstModels = dstAlias.models.map(getAliasId);
        if (aliasName === target) {
          if (index === targetIdx) return;
          const [moved] = dstModels.splice(index, 1);
          const insertAt = targetIdx !== undefined ? targetIdx : dstModels.length;
          dstModels.splice(insertAt, 0, moved);
          updateAliasModels(target, dstModels);
        } else {
          if (dstModels.includes(modelId)) return;
          const insertAt = targetIdx !== undefined ? targetIdx : dstModels.length;
          dstModels.splice(insertAt, 0, modelId);
          const srcModels = srcAlias.models.map(getAliasId).filter((_, i) => i !== index);
          updateAliasModels(aliasName, srcModels);
          updateAliasModels(target, dstModels);
        }
      }
    } else if (dragSource.kind === "newpool") {
      const { index } = dragSource;
      const modelId = newPool[index];
      if (target === "__newpool__") {
        if (targetIdx === undefined || targetIdx === index) return;
        const np = [...newPool];
        const [moved] = np.splice(index, 1);
        np.splice(targetIdx, 0, moved);
        setNewPool(np);
      } else if (target === "__available__") {
        setNewPool(newPool.filter((_, i) => i !== index));
      } else {
        const dstAlias = aliases.find((a) => a.name === target);
        if (!dstAlias) return;
        const dstModels = dstAlias.models.map(getAliasId);
        if (!dstModels.includes(modelId)) {
          const insertAt = targetIdx !== undefined ? targetIdx : dstModels.length;
          dstModels.splice(insertAt, 0, modelId);
          updateAliasModels(target, dstModels);
        }
        setNewPool(newPool.filter((_, i) => i !== index));
      }
    }

    setDragSource(null);
  };

  const onDragOver = (e: React.DragEvent, target: string) => {
    e.preventDefault();
    setDropTarget(target);
  };

  const onDragLeave = (e: React.DragEvent, target: string) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      if (dropTarget === target) setDropTarget(null);
    }
  };

  const orphanSummary = Array.from(orphansByAlias.entries());

  return (
    <div>
      <div className="mb-4">
        <p className="text-sm text-gray-500">
          Drag models between <b>Available Models</b> and <b>New Alias Pool</b> (next to each other) to build an alias.
          Array order = priority (first = preferred). Drop into an existing pool to add, or drag back to Available to remove.
          The same model can appear in multiple pools — e.g. <code className="font-mono">gpt-5</code> may sit in both a
          <code className="font-mono">performance</code> and a <code className="font-mono">daily</code> pool.
        </p>
      </div>

      {orphanSummary.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
          <span className="font-semibold">⚠ {orphanSummary.length} alias pool{orphanSummary.length === 1 ? "" : "s"} reference models that no provider serves.</span>{" "}
          Affected entries are tinted below. Use the ✕ on each row to remove the dead model, or click an alias name to rename it.
        </div>
      )}

      <div className="grid grid-cols-[1fr_300px_280px] gap-4 items-start">
        {/* LEFT: Configured alias pools */}
        <div className="space-y-3 min-h-[400px] max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
          {aliases.length === 0 && newPool.length === 0 && (
            <div className="text-center text-gray-400 py-12 border-2 border-dashed border-gray-200 rounded-lg">
              No aliases configured. Drag models from <b>Available</b> (right) into <b>New Alias Pool</b> (middle) to create one.
            </div>
          )}
          {aliases.map((alias) => {
            const models = alias.models.map(getAliasId);
            const isOver = dropTarget === alias.name;
            const aliasOrphans = orphansByAlias.get(alias.name) ?? [];
            const orphanIdSet = new Set(aliasOrphans.map((o) => o.modelId));
            return (
              <div
                key={alias.name}
                className={`border-2 border-dashed rounded-lg p-3 transition-colors ${
                  isOver ? "border-indigo-400 bg-indigo-50/50" : "border-gray-200 bg-white"
                }`}
                onDragOver={(e) => onDragOver(e, alias.name)}
                onDragLeave={(e) => onDragLeave(e, alias.name)}
                onDrop={() => handleDrop(alias.name)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {renamingAlias === alias.name ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(alias.name)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(alias.name);
                          if (e.key === "Escape") cancelRename();
                        }}
                        className="font-mono text-sm font-semibold border border-indigo-400 rounded px-1.5 py-0.5"
                      />
                    ) : (
                      <span
                        className="font-mono text-sm font-semibold text-gray-800 cursor-text hover:text-indigo-600"
                        title="Click to rename"
                        onClick={() => beginRename(alias.name)}
                      >
                        {alias.name}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">
                      {models.length} model{models.length !== 1 ? "s" : ""}
                    </span>
                    {aliasOrphans.length > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 bg-amber-200 text-amber-900 rounded uppercase tracking-wide font-semibold"
                        title={`${aliasOrphans.length} pool entr${aliasOrphans.length === 1 ? "y" : "ies"} reference models no provider serves`}
                      >
                        {aliasOrphans.length} ghost{aliasOrphans.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => remove(alias.name)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
                {models.length === 0 ? (
                  <div className="text-xs text-gray-400 text-center py-3 border border-dashed border-gray-200 rounded">
                    Drop models here
                  </div>
                ) : (
                  <div className="space-y-1">
                    {models.map((id, i) => {
                      const isGhost = orphanIdSet.has(id);
                      return (
                        <div
                          key={id}
                          draggable
                          onDragStart={() => setDragSource({ kind: "pool", aliasName: alias.name, index: i })}
                          onDragEnd={() => { setDragSource(null); setDropTarget(null); }}
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(alias.name); }}
                          onDrop={(e) => { e.stopPropagation(); handleDrop(alias.name, i); }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded border cursor-grab active:cursor-grabbing transition-colors select-none ${
                            isGhost
                              ? "bg-amber-50 border-amber-300 hover:bg-amber-100"
                              : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                          }`}
                        >
                          <span className="text-gray-300 text-xs select-none">⠿</span>
                          <span className="text-gray-400 text-[10px] w-4 text-center font-medium">{i + 1}</span>
                          <span
                            className={`font-mono text-xs flex-1 truncate ${isGhost ? "text-amber-900" : ""}`}
                            title={isGhost ? "Model no longer served by any provider — click ✕ to remove from pool" : undefined}
                          >
                            {id}
                          </span>
                          {isGhost && (
                            <span className="text-[9px] px-1 py-0.5 bg-amber-300 text-amber-900 rounded uppercase tracking-wide font-semibold">
                              ghost
                            </span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); removePoolItem(alias.name, i); }}
                            className="text-gray-400 hover:text-red-500 text-xs leading-none"
                            title="Remove from pool"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* RIGHT: New alias pool drop zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-3 min-h-[400px] transition-colors ${
            dropTarget === "__newpool__"
              ? "border-emerald-400 bg-emerald-50/50"
              : newPool.length > 0
                ? "border-amber-300 bg-amber-50/30"
                : "border-gray-200 bg-white"
          }`}
          onDragOver={(e) => onDragOver(e, "__newpool__")}
          onDragLeave={(e) => onDragLeave(e, "__newpool__")}
          onDrop={() => handleDrop("__newpool__")}
        >
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            New Alias Pool
          </h3>

          {newPool.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-10 border-2 border-dashed border-gray-200 rounded">
              Drop models here to<br />create a new alias
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Alias Name</label>
                <input
                  type="text"
                  value={newPoolName}
                  onChange={(e) => { setNewPoolName(e.target.value); setNewPoolNameError(false); }}
                  placeholder="e.g. minimax-latest"
                  autoFocus
                  className={`w-full border rounded px-2.5 py-1.5 text-sm font-mono ${
                    newPoolNameError ? "border-red-500 bg-red-50" : ""
                  }`}
                />
                {newPoolNameError && (
                  <p className="text-red-500 text-[10px] mt-1">Name is required</p>
                )}
              </div>
              <div className="space-y-1">
                {newPool.map((id, i) => (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => setDragSource({ kind: "newpool", index: i })}
                    onDragEnd={() => { setDragSource(null); setDropTarget(null); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget("__newpool__"); }}
                    onDrop={(e) => { e.stopPropagation(); handleDrop("__newpool__", i); }}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-white border border-amber-200 cursor-grab active:cursor-grabbing hover:bg-amber-50 transition-colors select-none"
                  >
                    <span className="text-gray-300 text-xs select-none">⠿</span>
                    <span className="text-gray-400 text-[10px] w-4 text-center font-medium">{i + 1}</span>
                    <span className="font-mono text-xs flex-1 truncate">{id}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNewPoolItem(i); }}
                      className="text-gray-400 hover:text-red-500 text-xs leading-none"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveNewPool}
                  disabled={savingNew || newPool.length === 0}
                  className="flex-1 px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {savingNew ? "Saving…" : "Save Alias"}
                </button>
                <button
                  onClick={cancelNewPool}
                  className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Available models — adjacent to New Alias Pool for short drags */}
        <div
          className={`border-2 border-dashed rounded-lg p-3 min-h-[400px] max-h-[calc(100vh-220px)] overflow-y-auto transition-colors ${
            dropTarget === "__available__" ? "border-indigo-400 bg-indigo-50/50" : "border-gray-200 bg-white"
          }`}
          onDragOver={(e) => onDragOver(e, "__available__")}
          onDragLeave={(e) => onDragLeave(e, "__available__")}
          onDrop={() => handleDrop("__available__")}
        >
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Available Models <span className="text-gray-400 normal-case">({availableModels.length})</span>
          </h3>
          {availableModels.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-8">
              All models are in pools
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {availableModels.map((id) => (
                <div
                  key={id}
                  draggable
                  onDragStart={() => setDragSource({ kind: "available", modelId: id })}
                  onDragEnd={() => { setDragSource(null); setDropTarget(null); }}
                  className="px-2 py-1 text-xs font-mono bg-gray-50 border border-gray-200 rounded cursor-grab active:cursor-grabbing hover:bg-indigo-50 hover:border-indigo-300 transition-colors select-none"
                >
                  {id}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
