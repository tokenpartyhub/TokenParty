import { useEffect, useState } from "react";
import { api } from "../lib/api";

type ModelConfig = string | { id: string; inputPrice?: number; outputPrice?: number; cacheReadPrice?: number; cacheWritePrice?: number };

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
  _apiKeysText?: string;
}

function getModelId(m: ModelConfig): string {
  return typeof m === "string" ? m : m.id;
}

function normalizeModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((m) => {
    if (typeof m === "string") return m;
    if (m.inputPrice === undefined && m.outputPrice === undefined && m.cacheReadPrice === undefined && m.cacheWritePrice === undefined) return m.id;
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
    const { _apiKeysText, ...data } = editing;
    data.models = normalizeModels(data.models ?? []);
    if (isNew) {
      await api.createProvider(data);
    } else {
      await api.updateProvider(data.id!, data);
    }
    setEditing(null);
    load();
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
      await api.updateProvider(p.id, { ...p, group: trimmed });
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
      await api.updateProvider(p.id, { ...p, group: undefined });
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
    const newGroup = targetGroup === UNGROUPED ? undefined : targetGroup;
    if (provider.group === newGroup) return;
    await api.updateProvider(provider.id, { ...provider, group: newGroup });
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
                  <button onClick={() => { setEditing(p); setIsNew(false); }} className="text-xs text-indigo-600 hover:underline">Edit</button>
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
            onClick={() => { setEditing({ type: "openai", models: [], enabled: true }); setIsNew(true); }}
            className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
          >
            Add Provider
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {allGroups.map((g) => renderGroupSection(g, g, false))}
        {renderGroupSection(UNGROUPED, "Ungrouped", true)}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-[560px] max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold mb-4">{isNew ? "Add" : "Edit"} Provider</h3>
            <div className="space-y-3">
              <Field label="Name" value={editing.name ?? ""} onChange={(v) => setEditing({ ...editing, name: v })} />
              <div>
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
              <Field label="Base URL" value={editing.baseUrl ?? ""} onChange={(v) => setEditing({ ...editing, baseUrl: v })} />
              <div>
                <label className="block text-sm text-gray-600 mb-1">API Keys (one per line, multiple keys enable load balancing)</label>
                <textarea
                  value={editing._apiKeysText ?? (Array.isArray(editing.apiKey) ? editing.apiKey.join("\n") : (editing.apiKey ?? ""))}
                  onChange={(e) => {
                    const text = e.target.value;
                    const keys = text.split("\n").map(s => s.trim()).filter(Boolean);
                    setEditing({ ...editing, _apiKeysText: text, apiKey: keys.length === 1 ? keys[0] : keys });
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  rows={3}
                  placeholder="sk-your-api-key"
                  className="w-full border rounded px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Currency</label>
                <select
                  value={editing.currency ?? "USD"}
                  onChange={(e) => setEditing({ ...editing, currency: e.target.value })}
                  className="w-32 border rounded px-3 py-2 text-sm"
                >
                  <option value="USD">$ USD</option>
                  <option value="CNY">¥ CNY</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Models</label>
                <div className="space-y-3">
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
                        <div className="grid grid-cols-4 gap-1.5">
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.inputPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "inputPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`Input ${sym}/1M`}
                            title={`Input price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.outputPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "outputPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`Output ${sym}/1M`}
                            title={`Output price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.cacheReadPrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "cacheReadPrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`Cache Read ${sym}/1M`}
                            title={`Cached read price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="number"
                            value={typeof m === "object" ? (m.cacheWritePrice ?? "") : ""}
                            onChange={(e) => updateModel(i, "cacheWritePrice", e.target.value ? Number(e.target.value) : undefined)}
                            placeholder={`Cache Write ${sym}/1M`}
                            title={`Cache write price (${sym} per 1M tokens)`}
                            className="border rounded px-2 py-1 text-xs"
                          />
                        </div>
                      </div>
                    );
                  })}
                  <button onClick={addModel} type="button" className="text-sm text-indigo-600 hover:underline">+ Add model</button>
                  <div className="text-xs text-gray-400">Prices per 1M tokens (optional). Unconfigured prices are treated as free and routed with highest priority.</div>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.enabled ?? true}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border rounded text-sm">Cancel</button>
              <button onClick={save} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Save</button>
            </div>
          </div>
        </div>
      )}
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
