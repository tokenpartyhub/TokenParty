import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatCost } from "./Settings";

interface TokenKey {
  key: string;
  name: string;
  allowedProviders: string[];
  rateLimit: number | null;
  monthlyBudget?: number;
  enabled: boolean;
}

interface UsageSummary {
  token_id: string;
  monthly_cost: number;
  monthly_requests: number;
  monthly_input_tokens: number;
  monthly_output_tokens: number;
}

export default function Users() {
  const [keys, setKeys] = useState<TokenKey[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [editing, setEditing] = useState<Partial<TokenKey> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [usageMap, setUsageMap] = useState<Record<string, UsageSummary>>({});

  const load = () => {
    api.getKeys().then(setKeys).catch(console.error);
    api.getProviders().then(setProviders).catch(console.error);
    api.getKeysUsageSummary().then((rows) => {
      const map: Record<string, UsageSummary> = {};
      for (const r of rows) map[r.token_id] = r;
      setUsageMap(map);
    }).catch(console.error);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    if (isNew) {
      await api.createKey(editing);
    } else {
      await api.updateKey(editing.key!, editing);
    }
    setEditing(null);
    load();
  };

  const remove = async (key: string) => {
    if (!confirm("Delete this user?")) return;
    await api.deleteKey(key);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Users</h2>
        <button
          onClick={() => { setEditing({ allowedProviders: [], enabled: true }); setIsNew(true); }}
          className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
        >
          Create User
        </button>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Key</th>
              <th className="px-4 py-2 text-left">Providers</th>
              <th className="px-4 py-2 text-right">Budget</th>
              <th className="px-4 py-2 text-right">Monthly Spend</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const usage = usageMap[k.key];
              const spent = usage?.monthly_cost ?? 0;
              const budgetPct = k.monthlyBudget ? (spent / k.monthlyBudget) * 100 : null;
              return (
                <tr key={k.key} className="border-t">
                  <td className="px-4 py-2 font-medium">{k.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{k.key}</td>
                  <td className="px-4 py-2 text-xs">
                    {k.allowedProviders.includes("*")
                      ? <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">All</span>
                      : k.allowedProviders.map((r, i) => (
                          <span key={i} className={`inline-block mr-1 px-1.5 py-0.5 rounded ${r.startsWith("group:") ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600"}`}>
                            {r.startsWith("group:") ? r.slice(6) : r}
                          </span>
                        ))
                    }
                  </td>
                  <td className="px-4 py-2 text-right text-xs">
                    {k.monthlyBudget ? formatCost(k.monthlyBudget) : <span className="text-gray-400">Unlimited</span>}
                  </td>
                  <td className="px-4 py-2 text-right text-xs">
                    <span className={budgetPct !== null && budgetPct > 90 ? "text-red-600 font-medium" : budgetPct !== null && budgetPct > 70 ? "text-yellow-600" : ""}>
                      {formatCost(spent)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${k.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                      {k.enabled ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => { setEditing(k); setIsNew(false); }} className="text-indigo-600 hover:underline mr-2">Edit</button>
                    <button onClick={() => remove(k.key)} className="text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-[480px] max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold mb-4">{isNew ? "Create" : "Edit"} User</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Name</label>
                <input
                  type="text"
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              {!isNew && (
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Key</label>
                  <div className="font-mono text-sm bg-gray-50 px-3 py-2 rounded">{editing.key}</div>
                </div>
              )}
              <ProviderSelector
                providers={providers}
                value={editing.allowedProviders ?? []}
                onChange={(v) => setEditing({ ...editing, allowedProviders: v })}
              />
              <div>
                <label className="block text-sm text-gray-600 mb-1">Monthly Budget (USD, empty = unlimited)</label>
                <p className="text-xs text-gray-500 mb-1">Requests will be rejected when the monthly cost exceeds this limit.</p>
                <input
                  type="number"
                  step="0.01"
                  value={editing.monthlyBudget ?? ""}
                  onChange={(e) => setEditing({ ...editing, monthlyBudget: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Rate Limit (req/min, empty = unlimited)</label>
                <input
                  type="number"
                  value={editing.rateLimit ?? ""}
                  onChange={(e) => setEditing({ ...editing, rateLimit: e.target.value ? Number(e.target.value) : null })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
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

type ProviderMode = "all" | "group" | "manual";

function detectMode(value: string[]): ProviderMode {
  if (value.includes("*")) return "all";
  if (value.some((v) => v.startsWith("group:"))) return "group";
  return "manual";
}

function ProviderSelector({ providers, value, onChange }: {
  providers: any[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const mode = detectMode(value);
  const groups = [...new Set(providers.map((p: any) => p.group as string).filter(Boolean))];
  const hasGroups = groups.length > 0;

  const setMode = (m: ProviderMode) => {
    if (m === "all") onChange(["*"]);
    else if (m === "group") onChange(groups.map((g) => `group:${g}`));
    else onChange([]);
  };

  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">Allowed Providers</label>
      <div className="flex gap-2 mb-2">
        {(["all", "group", "manual"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={m === "group" && !hasGroups}
            className={`px-3 py-1 rounded text-xs border ${mode === m ? "bg-indigo-600 text-white border-indigo-600" : m === "group" && !hasGroups ? "bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed" : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"}`}
          >
            {m === "all" ? "All" : m === "group" ? "By Group" : "Manual"}
          </button>
        ))}
      </div>
      {mode === "all" && (
        <div className="text-xs text-gray-500">All providers (including future ones)</div>
      )}
      {mode === "group" && (
        <div className="space-y-1">
          {groups.map((g) => (
            <label key={g} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.includes(`group:${g}`)}
                onChange={(e) => {
                  const rule = `group:${g}`;
                  onChange(e.target.checked ? [...value, rule] : value.filter((v) => v !== rule));
                }}
              />
              {g}
            </label>
          ))}
        </div>
      )}
      {mode === "manual" && (
        <div className="space-y-1">
          {providers.map((p: any) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.includes(p.id)}
                onChange={(e) => {
                  onChange(e.target.checked ? [...value, p.id] : value.filter((v) => v !== p.id));
                }}
              />
              {p.name} ({p.id})
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
