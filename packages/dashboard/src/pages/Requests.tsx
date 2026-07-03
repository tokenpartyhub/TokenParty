import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { formatCost, getSettings } from "./Settings";
import { getAdapterForAgent } from "../lib/agent-adapters";
import type { RequestContext } from "../lib/agent-adapters/types";

interface Filters {
  token_id: string;
  provider_id: string;
  model: string;
  status: string;
  tags: string;
  agent: string;
  date_from: string;
  date_to: string;
}

const emptyFilters: Filters = { token_id: "", provider_id: "", model: "", status: "", tags: "", agent: "", date_from: "", date_to: "" };

const KNOWN_AGENTS = ["claude-code", "codex", "openclaw"];

export default function Requests({ mode = "admin" }: { mode?: "admin" | "user" }) {
  // All view state is mirrored in URL search params so the page can be
  // refreshed, deep-linked, or shared without losing filters, pagination,
  // or the open detail panel.
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: Filters = {
    token_id: searchParams.get("token_id") ?? "",
    provider_id: searchParams.get("provider_id") ?? "",
    model: searchParams.get("model") ?? "",
    status: searchParams.get("status") ?? "",
    tags: searchParams.get("tags") ?? "",
    agent: searchParams.get("agent") ?? "",
    date_from: searchParams.get("date_from") ?? "",
    date_to: searchParams.get("date_to") ?? "",
  };
  const limit = Number(searchParams.get("limit") ?? 20);
  const offset = Number(searchParams.get("offset") ?? 0);
  const selectedId = searchParams.get("id");

  const setUrlParams = (patch: Record<string, string | number | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === undefined) next.delete(k);
        else next.set(k, String(v));
      }
      return next;
    }, { replace: true });
  };

  const updateFilter = (patch: Partial<Filters>) => {
    setUrlParams({ ...patch, offset: 0 });
  };
  const setLimit = (n: number) => setUrlParams({ limit: n, offset: 0 });
  const setOffset = (n: number) => setUrlParams({ offset: n });
  const setSelectedId = (id: string | null) => setUrlParams({ id });

  const [requests, setRequests] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<any>(null);
  const [reqSection, setReqSection] = useState("headers");
  const [resSection, setResSection] = useState("headers");
  const [reqCollapsed, setReqCollapsed] = useState(false);
  const [resCollapsed, setResCollapsed] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  // Restore detail selection from URL on mount / when id changes externally.
  useEffect(() => {
    if (selectedId && selected?.id !== selectedId) {
      loadDetail(selectedId);
    } else if (!selectedId && selected) {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!selected) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (detailRef.current?.contains(target)) return;
      const row = (target as Element).closest?.("tr[data-clickable]");
      if (row) return;
      setSelectedId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      e.preventDefault();
      const idx = requests.findIndex((r) => r.id === selected.id);
      if (idx === -1) return;
      const next = e.key === "ArrowUp" ? idx - 1 : idx + 1;
      if (next >= 0 && next < requests.length) setSelectedId(requests[next].id);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selected, requests]);
  const [keyNames, setKeyNames] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<{ key: string; name: string }[]>([]);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (mode === "admin") {
      api.getKeys().then((k) => {
        setKeys(k);
        const map: Record<string, string> = {};
        for (const item of k) map[item.key] = item.name;
        setKeyNames(map);
      }).catch(console.error);
      api.getProviders().then((p) => setProviders(p)).catch(console.error);
    }
    if (mode === "admin") {
      api.getModels().then((m) => setModels(m.map((x) => x.id))).catch(console.error);
    } else {
      api.getUserModels().then((m) => setModels(m.map((x) => x.id))).catch(console.error);
    }
  }, [mode]);

  useEffect(() => {
    const params: any = { limit, offset };
    if (filters.provider_id) params.provider_id = filters.provider_id;
    if (filters.model) params.model = filters.model;
    if (filters.status) params.status = filters.status;
    if (filters.tags) params.tags = filters.tags;
    if (filters.agent) params.agent = filters.agent;
    if (filters.date_from) params.date_from = filters.date_from;
    if (filters.date_to) params.date_to = filters.date_to;
    if (mode === "admin") {
      if (filters.token_id) params.token_id = filters.token_id;
      api.getRequests(params).then((res) => {
        setRequests(res.data);
        setTotal(res.total);
      }).catch(console.error);
    } else {
      api.getUserRequests(params).then((res) => {
        setRequests(res.data);
        setTotal(res.total);
      }).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, mode]);

  const hasFilters = Object.values(filters).some(Boolean);

  const loadDetail = async (id: string) => {
    const detail = mode === "admin" ? await api.getRequestDetail(id) : await api.getUserRequestDetail(id);
    if (!selected) {
      setReqSection("headers");
      setResSection("headers");
      setReqCollapsed(false);
      setResCollapsed(false);
    }
    setSelected(detail);
    window.dispatchEvent(new CustomEvent("collapse-nav"));
  };

  const reqLog = selected?.logs?.find((l: any) => l.type === "request");
  const resLog = selected?.logs?.find((l: any) => l.type === "response");
  const adapter = selected ? getAdapterForAgent(selected.agent) : null;
  const adapterCtx: RequestContext | null = selected ? {
    cost: selected.cost ?? 0,
    latencyMs: selected.latency_ms ?? 0,
    inputTokens: selected.input_tokens ?? 0,
    outputTokens: selected.output_tokens ?? 0,
    cacheReadTokens: selected.cache_read_tokens ?? 0,
    cacheWriteTokens: selected.cache_write_tokens ?? 0,
    model: selected.model ?? "",
    status: selected.status ?? 0,
    error: selected.error,
  } : null;

  return (
    <div className="h-full relative">
      {/* List */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Requests</h2>
        <div className="mb-4 space-y-2">
          {/* Row 1: request identity — who/what made the call */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-gray-400 w-14 shrink-0">Target</span>
            {mode === "admin" && (
              <select value={filters.token_id} onChange={(e) => updateFilter({ token_id: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
                <option value="">All Users</option>
                {keys.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
              </select>
            )}
            {mode === "admin" && (
              <select value={filters.provider_id} onChange={(e) => updateFilter({ provider_id: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
                <option value="">All Providers</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <select value={filters.model} onChange={(e) => updateFilter({ model: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
              <option value="">All Models</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {/* Row 2: request conditions — outcome, agent, tags, time */}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-gray-400 w-14 shrink-0">Filter</span>
            <select value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
              <option value="">All Status</option>
              <option value="ok">Success</option>
              <option value="error">Error</option>
            </select>
            <select value={filters.agent} onChange={(e) => updateFilter({ agent: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
              <option value="">All Agents</option>
              {KNOWN_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <input
              type="text"
              placeholder="Tags (comma separated)"
              value={filters.tags}
              onChange={(e) => updateFilter({ tags: e.target.value })}
              className="border rounded px-2 py-1.5 text-sm w-48"
            />
            <div className="flex items-center gap-1">
              {([["today", "Today"], ["7d", "Last 7d"], ["30d", "Last 30d"], ["all", "All"]] as const).map(([key, label]) => {
                const today = new Date();
                const toStr = (d: Date) => d.toISOString().slice(0, 10);
                let from = "", to = toStr(today);
                if (key === "today") from = to;
                else if (key === "7d") from = toStr(new Date(today.getTime() - 6 * 86400000));
                else if (key === "30d") from = toStr(new Date(today.getTime() - 29 * 86400000));
                else { from = ""; to = ""; }
                const active = (key === "all" && !filters.date_from && !filters.date_to) ||
                  (key !== "all" && filters.date_from === from && filters.date_to === to);
                return (
                  <button
                    key={key}
                    onClick={() => setUrlParams({ date_from: from, date_to: to, offset: 0 })}
                    className={`px-2 py-1 text-xs rounded border ${active ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={filters.date_from}
                onChange={(e) => updateFilter({ date_from: e.target.value })}
                className="border rounded px-2 py-1.5 text-sm"
              />
              <span className="text-gray-400 text-xs">~</span>
              <input
                type="date"
                value={filters.date_to}
                onChange={(e) => updateFilter({ date_to: e.target.value })}
                className="border rounded px-2 py-1.5 text-sm"
              />
            </div>
            {hasFilters && (
              <button onClick={() => setSearchParams(new URLSearchParams(), { replace: true })} className="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                Reset
              </button>
            )}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-right">Tokens</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Latency</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">Agent</th>
                <th className="px-3 py-2 text-left">Tags</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr
                  key={req.id}
                  data-clickable
                  onClick={() => setSelectedId(req.id)}
                  className={`border-t cursor-pointer hover:bg-gray-50 ${selected?.id === req.id ? "bg-indigo-50" : ""}`}
                >
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(req.timestamp).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">{keyNames[req.token_id] || req.token_id?.slice(0, 12)}</td>
                  <td className="px-3 py-2">{req.model}</td>
                  <td className="px-3 py-2 text-right">{(req.input_tokens ?? 0) + (req.output_tokens ?? 0)}</td>
                  <td className="px-3 py-2 text-right text-xs">{req.cost > 0 ? formatCost(req.cost) : "-"}</td>
                  <td className="px-3 py-2 text-right">{req.latency_ms}ms</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${req.status === 200 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                      {req.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs"><AgentBadge agent={req.agent} /></td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[200px]"><TagsCell value={req.custom_tags} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between mt-4 text-sm">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="px-3 py-1 border rounded disabled:opacity-50">Previous</button>
          <div className="flex items-center gap-2 text-gray-500">
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="border rounded px-1 py-0.5 text-sm"
            >
              {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <span>{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
            <span className="text-gray-300">|</span>
            <span>Page</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, Math.ceil(total / limit))}
              value={Math.floor(offset / limit) + 1}
              onChange={(e) => {
                const page = Math.max(1, Math.min(Math.ceil(total / limit), Number(e.target.value) || 1));
                setOffset((page - 1) * limit);
              }}
              onKeyDown={(e) => {
                // ▲ up arrow = previous page (-1); ▼ = next page (+1).
                // Native number input flips these, so intercept and re-map.
                const totalPages = Math.max(1, Math.ceil(total / limit));
                const current = Math.floor(offset / limit) + 1;
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setOffset((Math.max(1, current - 1) - 1) * limit);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOffset((Math.min(totalPages, current + 1) - 1) * limit);
                }
              }}
              className="w-14 border rounded px-2 py-0.5 text-center text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span>/ {Math.max(1, Math.ceil(total / limit))}</span>
          </div>
          <button disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} className="px-3 py-1 border rounded disabled:opacity-50">Next</button>
        </div>
      </div>

      {/* Detail Panel - overlay */}
      {selected && (
        <div ref={detailRef} className="fixed inset-y-0 right-0 w-3/4 bg-white shadow-xl flex flex-col overflow-hidden z-20">
          {/* Header */}
          <div className="px-5 py-3 border-b bg-gray-50 shrink-0 space-y-2">
            {/* Title row */}
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-3 min-w-0">
                <h3 className="font-bold text-base shrink-0">Detail</h3>
                <span className="text-xs text-gray-400 font-mono truncate">{selected.id}</span>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 ml-3 shrink-0">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Meta chips */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200"><span className="text-gray-400">Model</span> <span className="font-medium">{selected.model}</span></span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200"><span className="text-gray-400">Provider</span> {providers.find((p) => p.id === selected.provider_id)?.name ?? selected.provider_id}</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200"><span className="text-gray-400">Latency</span> {selected.latency_ms}ms</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${selected.status === 200 ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"}`}><span className="text-gray-400">Status</span> {selected.status}</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200"><span className="text-gray-400">Entry</span> {reqLog?.headers?.["x-entry-protocol"] ?? "-"}</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-gray-200"><span className="text-gray-400">Cost</span> {selected.cost > 0 ? formatCost(selected.cost) : "-"}</span>
              {resLog?.streaming && <span className="px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700">SSE</span>}
              {adapter && reqLog && adapter.renderMetaChips(reqLog)}
            </div>
            {/* Token bar */}
            {(selected.input_tokens > 0 || selected.output_tokens > 0) && (
              <TokenUsageBar input={selected.input_tokens} output={selected.output_tokens} cacheRead={selected.cache_read_tokens ?? 0} cacheWrite={selected.cache_write_tokens ?? 0} />
            )}
            {/* Route & cURL */}
            <div className="flex items-center gap-1 text-xs flex-wrap">
              {reqLog && (
                <CopyNode label="Client" text={buildCurlProxy(reqLog)} className="bg-blue-50 border-blue-200 text-blue-600 hover:bg-blue-100" />
              )}
              <span className="text-gray-300">&rarr;</span>
              {reqLog && (
                <CopyNode label="TokenParty" text={buildCurlUpstream(reqLog)} className="bg-indigo-50 border-indigo-200 text-indigo-600 hover:bg-indigo-100" />
              )}
              <RouteTrace trace={selected.route_trace} providers={providers} />
              <span className="text-gray-300">&rarr;</span>
              <span className="px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                {providers.find((p) => p.id === selected.provider_id)?.name ?? selected.provider_id}
              </span>
            </div>
          </div>

          {/* Error banner */}
          {resLog?.error && (
            <div className="px-4 py-1 bg-red-50 text-red-700 text-xs border-b shrink-0">Error: {resLog.error}</div>
          )}

          {/* Per-attempt cards (one per upstream hop, cURL replay) */}
          <AttemptsSection logs={selected.logs ?? []} providers={providers} />

          {/* Content: split panes */}
          <div className="flex-1 flex min-h-0">
            {/* Request pane */}
            {reqCollapsed ? (
              <button
                onClick={() => setReqCollapsed(false)}
                className="w-8 shrink-0 border-r bg-gray-50 flex flex-col items-center justify-center hover:bg-gray-100 text-xs text-gray-400"
                title="Expand Request"
              >
                <span className="writing-vertical">Request</span>
                <span className="mt-1">&#9654;</span>
              </button>
            ) : (
              <div className={`flex flex-col min-w-0 ${resCollapsed ? "flex-1" : "w-1/2"} border-r`}>
                <div className="flex items-center border-b bg-gray-50 shrink-0">
                  <button onClick={() => setReqCollapsed(true)} className="px-2 py-1.5 text-gray-400 hover:text-gray-600 text-xs" title="Collapse">&#9664;</button>
                  <span className="text-xs font-semibold text-gray-600 mr-2">Request</span>
                  <div className="flex gap-0.5 overflow-x-auto py-1">
                    {reqLog && (
                      <>
                        <TabButton id="headers" label="Headers" active={reqSection} onClick={setReqSection} />
                        <TabButton id="messages" label={`Messages (${reqLog.body?.messages?.length ?? 0})`} active={reqSection} onClick={setReqSection} />
                        {reqLog.body?.system && <TabButton id="system" label="System" active={reqSection} onClick={setReqSection} />}
                        {reqLog.body?.tools && <TabButton id="tools" label={`Tools (${reqLog.body.tools.length})`} active={reqSection} onClick={setReqSection} />}
                        {adapter && adapterCtx && adapter.getRequestSections(reqLog, resLog, adapterCtx).map((s) => (
                          <TabButton key={s.id} id={s.id} label={s.label} active={reqSection} onClick={setReqSection} />
                        ))}
                        <TabButton id="raw" label="Raw" active={reqSection} onClick={setReqSection} />
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-3 text-xs">
                  {reqLog && (
                    <>
                      {reqSection === "headers" && <HeadersTable headers={reqLog.headers} />}
                      {reqSection === "messages" && <MessageList messages={reqLog.body?.messages} />}
                      {reqSection === "system" && reqLog.body?.system && (
                        <div className="bg-amber-50 border border-amber-200 rounded p-3 whitespace-pre-wrap">
                          {typeof reqLog.body.system === "string"
                            ? reqLog.body.system
                            : Array.isArray(reqLog.body.system)
                              ? reqLog.body.system.map((block: any, i: number) => (
                                  <div key={i}>{block.text ?? JSON.stringify(block)}</div>
                                ))
                              : JSON.stringify(reqLog.body.system)}
                        </div>
                      )}
                      {reqSection === "tools" && reqLog.body?.tools && <ToolList tools={reqLog.body.tools} />}
                      {adapter && adapterCtx && adapter.renderSection(reqSection, reqLog, resLog, adapterCtx)}
                      {reqSection === "raw" && <CopyableJSON data={reqLog.body} />}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Response pane */}
            {resCollapsed ? (
              <button
                onClick={() => setResCollapsed(false)}
                className="w-8 shrink-0 bg-gray-50 flex flex-col items-center justify-center hover:bg-gray-100 text-xs text-gray-400"
                title="Expand Response"
              >
                <span className="writing-vertical">Response</span>
                <span className="mt-1">&#9664;</span>
              </button>
            ) : (
              <div className={`flex flex-col min-w-0 ${reqCollapsed ? "flex-1" : "w-1/2"}`}>
                <div className="flex items-center border-b bg-gray-50 shrink-0">
                  <span className="text-xs font-semibold text-gray-600 ml-3 mr-2">Response</span>
                  <div className="flex gap-0.5 overflow-x-auto py-1">
                    {resLog && (
                      <>
                        <TabButton id="headers" label="Headers" active={resSection} onClick={setResSection} />
                        <TabButton id="content" label="Content" active={resSection} onClick={setResSection} />
                        {resLog.streaming && resLog.body && Array.isArray(resLog.body) && resLog.body.length > 0 && (
                          <TabButton id="events" label={`SSE (${resLog.body.length})`} active={resSection} onClick={setResSection} />
                        )}
                        {!resLog.streaming && <TabButton id="raw" label="Raw" active={resSection} onClick={setResSection} />}
                      </>
                    )}
                  </div>
                  <div className="ml-auto">
                    <button onClick={() => setResCollapsed(true)} className="px-2 py-1.5 text-gray-400 hover:text-gray-600 text-xs" title="Collapse">&#9654;</button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto p-3 text-xs">
                  {resLog ? (
                    <>
                      {resSection === "headers" && <HeadersTable headers={resLog.headers} />}
                      {resSection === "content" && (
                        resLog.streaming ? (
                          <StreamingContent events={resLog.body} fallback={resLog.streamContent} />
                        ) : (
                          <>
                            {resLog.body?.content && <ResponseContent content={resLog.body.content} />}
                            {resLog.body?.choices?.[0]?.message?.content && (
                              <ContentBlocks blocks={parseThinkTags(resLog.body.choices[0].message.content)} />
                            )}
                            {resLog.body?.object === "response" && resLog.body?.output && (
                              <ResponsesApiOutput output={resLog.body.output} />
                            )}
                          </>
                        )
                      )}
                      {resSection === "events" && resLog.streaming && resLog.body && Array.isArray(resLog.body) && (
                        <div className="bg-gray-50 rounded overflow-auto divide-y divide-gray-200">
                          {resLog.body.map((event: any, i: number) => (
                            <SSEEventRow key={i} index={i} event={event} />
                          ))}
                        </div>
                      )}
                      {resSection === "raw" && <CopyableJSON data={resLog.body} />}
                    </>
                  ) : (
                    <div className="text-gray-400 italic">No response recorded</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Token Usage Bar ---

function TabButton({ id, label, active, onClick }: { id: string; label: string; active: string; onClick: (id: string) => void }) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`px-2 py-1 text-xs whitespace-nowrap rounded ${active === id ? "bg-white text-indigo-600 font-medium shadow-sm" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  );
}

const INTERNAL_HEADERS = new Set(["x-target-url", "x-entry-protocol", "x-provider-type", "x-api-key-index", "x-api-key-used", "x-method", "x-path"]);
const SKIP_HEADERS = new Set([...INTERNAL_HEADERS, "host", "connection", "content-length", "accept-encoding"]);

function buildCurlProxy(reqLog: any): string {
  const method = reqLog.headers?.["x-method"] ?? "POST";
  const path = reqLog.headers?.["x-path"] ?? "/v1/chat/completions";
  const parts = [`curl -X ${method}`, `'http://localhost:3456${path}'`];
  if (reqLog.headers) {
    for (const [k, v] of Object.entries(reqLog.headers)) {
      if (SKIP_HEADERS.has(k.toLowerCase())) continue;
      parts.push(`-H '${k}: ${v}'`);
    }
  }
  if (reqLog.body) {
    parts.push(`-d '${JSON.stringify(reqLog.body)}'`);
  }
  return parts.join(" \\\n  ");
}

function buildCurlUpstream(reqLog: any): string {
  const url = reqLog.headers?.["x-target-url"] ?? "";
  const parts = ["curl -X POST", `'${url}'`];
  if (reqLog.headers) {
    for (const [k, v] of Object.entries(reqLog.headers)) {
      if (SKIP_HEADERS.has(k.toLowerCase())) continue;
      parts.push(`-H '${k}: ${v}'`);
    }
  }
  if (reqLog.body) {
    parts.push(`-d '${JSON.stringify(reqLog.body)}'`);
  }
  return parts.join(" \\\n  ");
}

// Build a cURL command that replays a specific upstream attempt. The
// attempt_request log entry carries the exact targetUrl, headers (incl.
// the real api key), and body the proxy sent, so the user can copy and
// run it to reproduce that hop standalone.
function buildCurlAttempt(attemptReq: any): string {
  const url = attemptReq.attemptTargetUrl ?? "";
  const parts = ["curl -X POST", `'${url}'`];
  if (attemptReq.headers) {
    for (const [k, v] of Object.entries(attemptReq.headers)) {
      // hop-by-hop + transfer concerns; keep content-type so curl sends the body
      if (k.toLowerCase() === "content-length") continue;
      parts.push(`-H '${k}: ${v}'`);
    }
  }
  if (attemptReq.body) {
    parts.push(`-d '${JSON.stringify(attemptReq.body)}'`);
  }
  return parts.join(" \\\n  ");
}

function CopyNode({ label, text, className }: { label: string; text: string; className: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts where Clipboard API is unavailable.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 1500);
    }
  };
  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border cursor-pointer ${className}`}
      title="Click to copy cURL"
    >
      {label}
      {copied ? (
        <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : failed ? (
        <svg className="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
      ) : (
        <svg className="w-3 h-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      )}
    </button>
  );
}

function RouteTrace({ trace, providers }: { trace?: string; providers: { id: string; name: string }[] }) {
  if (!trace) return null;
  let nodes: { provider: string; status: number | null; latencyMs: number; reason?: string }[];
  try {
    nodes = JSON.parse(trace);
  } catch {
    return null;
  }
  if (!nodes || nodes.length <= 1) return null;

  const nameMap = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  const failedNodes = nodes.slice(0, -1);

  return (
    <span className="inline-flex items-center gap-1">
      {failedNodes.map((node, i) => {
        const name = nameMap[node.provider] ?? node.provider;
        return (
          <span key={i} className="inline-flex items-center gap-1">
            <span className="text-red-500">
              {name} {node.status ?? "err"}{node.reason ? ` (${node.reason})` : ""}
            </span>
            <span className="text-gray-300">&rarr;</span>
          </span>
        );
      })}
    </span>
  );
}

// Per-attempt detail cards. Each card is one upstream hop the proxy made.
// Gray border for failed/retryable attempts, green for the one that
// ultimately answered the client. Each card has a Copy cURL button that
// replays that exact attempt.
function AttemptsSection({ logs, providers }: { logs: any[]; providers: { id: string; name: string }[] }) {
  const attemptReqs = logs.filter((l) => l.type === "attempt_request");
  const attemptResps = logs.filter((l) => l.type === "attempt_response");
  if (attemptReqs.length === 0) return null;

  const nameMap = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  const finalProviderId = attemptResps.length > 0
    ? attemptResps[attemptResps.length - 1].attemptProvider
    : undefined;
  const finalStatus = attemptResps.length > 0
    ? attemptResps[attemptResps.length - 1].status
    : undefined;

  return (
    <div className="px-5 py-3 border-t bg-gray-50 shrink-0">
      <div className="text-xs font-semibold text-gray-600 mb-2">Attempts</div>
      <div className="space-y-2">
        {attemptReqs.map((reqLog) => {
          const idx = reqLog.attemptIndex ?? 0;
          const respLog = attemptResps.find((r) => r.attemptIndex === idx);
          const providerName = nameMap[reqLog.attemptProvider] ?? reqLog.attemptProvider;
          const isFinal = reqLog.attemptProvider === finalProviderId && respLog?.status === finalStatus;
          const isSuccess = isFinal && respLog && (respLog.status ?? 0) >= 200 && (respLog.status ?? 0) < 300;
          const borderClass = isSuccess
            ? "border-green-300 bg-green-50"
            : "border-gray-300 bg-gray-50";
          const statusBadge = respLog?.status
            ? (respLog.status >= 200 && respLog.status < 300
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-700")
            : "bg-gray-200 text-gray-700";
          const reason = respLog?.error
            ? (respLog.error.includes("ECONN") || respLog.error.includes("fetch failed") ? "network_error" : "error")
            : respLog?.status === 429 ? "rate_limited" : respLog?.status && respLog.status >= 500 ? "http_5xx" : undefined;

          return (
            <div key={idx} className={`border rounded ${borderClass}`}>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-xs text-gray-400 font-mono w-6">#{idx + 1}</span>
                <span className="text-sm font-medium text-gray-700">{providerName}</span>
                {respLog?.status ? (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadge}`}>{respLog.status}</span>
                ) : (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadge}`}>err</span>
                )}
                {reason && <span className="text-xs text-red-500">({reason})</span>}
                {isSuccess && <span className="text-xs text-green-600 font-medium">✓ final</span>}
                {respLog?.error && <span className="text-xs text-red-600 font-mono truncate">{respLog.error}</span>}
                <span className="ml-auto">
                  <CopyNode
                    label="Copy cURL"
                    text={buildCurlAttempt(reqLog)}
                    className="bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
                  />
                </span>
              </div>
              <details className="border-t border-gray-200">
                <summary className="px-3 py-1.5 text-xs text-gray-500 cursor-pointer hover:bg-white/50">
                  Show request & response details
                </summary>
                <div className="px-3 py-2 space-y-2 text-xs">
                  <div>
                    <div className="text-gray-500 font-semibold mb-1">→ Sent to {reqLog.attemptTargetUrl}</div>
                    <div className="bg-white border border-gray-200 rounded p-2 font-mono text-[11px] max-h-40 overflow-auto">
                      {reqLog.headers && Object.entries(reqLog.headers).map(([k, v]) => (
                        <div key={k}><span className="text-gray-400">{k}:</span> {String(v)}</div>
                      ))}
                      {reqLog.body && <pre className="mt-1 text-gray-700 whitespace-pre-wrap break-all">{JSON.stringify(reqLog.body, null, 2)}</pre>}
                    </div>
                  </div>
                  {respLog && (
                    <div>
                      <div className="text-gray-500 font-semibold mb-1">← Response {respLog.status ?? "err"}{respLog.error ? ` (${respLog.error})` : ""}</div>
                      <div className="bg-white border border-gray-200 rounded p-2 font-mono text-[11px] max-h-40 overflow-auto">
                        {respLog.headers && Object.entries(respLog.headers).map(([k, v]) => (
                          <div key={k}><span className="text-gray-400">{k}:</span> {String(v)}</div>
                        ))}
                        {respLog.body && <pre className="mt-1 text-gray-700 whitespace-pre-wrap break-all">{typeof respLog.body === "string" ? respLog.body : JSON.stringify(respLog.body, null, 2)}</pre>}
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TokenUsageBar({ input, output, cacheRead = 0, cacheWrite = 0 }: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  const total = input + output;
  if (total === 0) return null;
  const nonCachedInput = Math.max(0, input - cacheRead);
  const cacheReadPct = (cacheRead / total) * 100;
  const inputPct = (nonCachedInput / total) * 100;
  const outputPct = (output / total) * 100;

  return (
    <div>
      <div className="flex flex-wrap gap-x-3 text-xs text-gray-500 mb-1">
        <span>Input: {input.toLocaleString()}</span>
        {cacheRead > 0 && <span className="text-cyan-600">Cache Read: {cacheRead.toLocaleString()}</span>}
        {cacheWrite > 0 && <span className="text-amber-600">Cache Write: {cacheWrite.toLocaleString()}</span>}
        <span>Output: {output.toLocaleString()}</span>
        <span className="ml-auto">Total: {total.toLocaleString()}</span>
      </div>
      <div className="flex h-2 rounded overflow-hidden bg-gray-200">
        {cacheRead > 0 && <div className="bg-cyan-400" style={{ width: `${cacheReadPct}%` }} title={`Cache Read: ${cacheRead}`} />}
        <div className="bg-blue-500" style={{ width: `${inputPct}%` }} title={`Input (non-cached): ${nonCachedInput}`} />
        <div className="bg-green-500" style={{ width: `${outputPct}%` }} title={`Output: ${output}`} />
      </div>
    </div>
  );
}

// --- Message List (colored by role) ---

function MessageList({ messages }: { messages?: any[] }) {
  if (!messages || messages.length === 0) return <div className="text-gray-400 italic">No messages</div>;
  const reverse = getSettings().reverseMessages;
  const ordered = reverse ? [...messages].map((msg, i) => ({ msg, i })).reverse() : messages.map((msg, i) => ({ msg, i }));

  return (
    <div className="space-y-1">
      {ordered.map(({ msg, i }) => (
        <MessageItem key={i} msg={msg} index={i} />
      ))}
    </div>
  );
}

function getMessagePreview(msg: any): string {
  const content = msg.content;
  if (typeof content === "string") return content.slice(0, 80);
  if (Array.isArray(content)) {
    const textPart = content.find((p: any) => p.type === "text" && p.text);
    if (textPart) return textPart.text.slice(0, 80);
    return content.map((p: any) => p.type).join(", ");
  }
  return "";
}

function MessageItem({ msg, index }: { msg: any; index: number }) {
  const [open, setOpen] = useState(false);

  const roleColors: Record<string, string> = {
    user: "bg-blue-50 border-blue-200",
    assistant: "bg-green-50 border-green-200",
    system: "bg-amber-50 border-amber-200",
    tool: "bg-purple-50 border-purple-200",
  };

  const preview = getMessagePreview(msg);

  return (
    <div className={`rounded border ${roleColors[msg.role] ?? "bg-gray-50 border-gray-200"}`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <span className="text-xs text-gray-400">{open ? "▼" : "▶"}</span>
        <span className="font-medium text-gray-600 text-xs uppercase">{msg.role}</span>
        <span className="text-gray-300 text-xs">#{index + 1}</span>
        {!open && <span className="text-gray-400 text-xs truncate ml-1">{preview}</span>}
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {typeof msg.content === "string" ? (
            <div className="whitespace-pre-wrap">{msg.content}</div>
          ) : Array.isArray(msg.content) ? (
            msg.content.map((part: any, j: number) => (
              <MessagePart key={j} part={part} />
            ))
          ) : (
            <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(msg.content, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function MessagePart({ part }: { part: any }) {
  if (part.type === "thinking") {
    return (
      <div className="bg-gray-100 border border-gray-300 rounded p-2">
        <span className="px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 font-medium">Thinking</span>
        <div className="whitespace-pre-wrap text-gray-600 text-sm mt-1">{part.thinking}</div>
      </div>
    );
  }
  if (part.type === "text") {
    return <div className="whitespace-pre-wrap">{part.text}</div>;
  }
  if (part.type === "tool_use") {
    return (
      <div className="bg-purple-50 border border-purple-200 rounded p-2">
        <div className="font-medium text-purple-700 text-xs mb-1">Tool: {part.name}</div>
        <pre className="whitespace-pre-wrap text-xs overflow-auto max-h-48">{JSON.stringify(part.input, null, 2)}</pre>
      </div>
    );
  }
  if (part.type === "tool_result") {
    return (
      <div className="bg-purple-50 border border-purple-200 rounded p-2">
        <div className="font-medium text-purple-700 text-xs mb-1">Tool Result{part.tool_use_id ? ` (${part.tool_use_id})` : ""}</div>
        <div className="whitespace-pre-wrap text-sm">
          {typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map((c: any, k: number) => <div key={k}>{c.text ?? JSON.stringify(c)}</div>)
              : JSON.stringify(part.content)}
        </div>
      </div>
    );
  }
  if (part.type === "image" || part.type === "image_url") {
    return (
      <div className="bg-gray-100 border border-gray-200 rounded p-2 text-xs text-gray-500 italic">
        [Image]
      </div>
    );
  }
  return <pre className="whitespace-pre-wrap text-xs bg-gray-50 rounded p-2 overflow-auto max-h-48">{JSON.stringify(part, null, 2)}</pre>;
}

// --- Anthropic Response Content ---

function ResponseContent({ content }: { content: any[] }) {
  if (!content) return null;
  return (
    <div className="space-y-2">
      {content.map((block: any, i: number) => {
        if (block.type === "thinking") {
          return (
            <div key={i} className="bg-gray-50 border border-gray-300 rounded p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 font-medium">Thinking</span>
              </div>
              <div className="whitespace-pre-wrap text-gray-600 text-sm">{block.thinking}</div>
            </div>
          );
        }
        if (block.type === "text") {
          return <div key={i} className="bg-green-50 border border-green-200 rounded p-3 whitespace-pre-wrap">{block.text}</div>;
        }
        if (block.type === "tool_use") {
          return (
            <div key={i} className="bg-purple-50 border border-purple-200 rounded p-3">
              <div className="font-medium text-purple-700 mb-1">Tool: {block.name}</div>
              <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(block.input, null, 2)}</pre>
            </div>
          );
        }
        return <pre key={i} className="bg-gray-50 p-3 rounded whitespace-pre-wrap">{JSON.stringify(block, null, 2)}</pre>;
      })}
    </div>
  );
}

// --- Responses API Output ---

function ResponsesApiOutput({ output }: { output: any[] }) {
  if (!output || output.length === 0) return <div className="text-gray-400 italic">No output</div>;
  return (
    <div className="space-y-2">
      {output.map((item: any, i: number) => {
        if (item.type === "message" && item.content) {
          return (
            <div key={i}>
              {item.content.map((part: any, j: number) => {
                if (part.type === "output_text") {
                  return <div key={j} className="bg-green-50 border border-green-200 rounded p-3 whitespace-pre-wrap">{part.text}</div>;
                }
                if (part.type === "refusal") {
                  return <div key={j} className="bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap">{part.refusal}</div>;
                }
                return <pre key={j} className="bg-gray-50 p-3 rounded whitespace-pre-wrap">{JSON.stringify(part, null, 2)}</pre>;
              })}
            </div>
          );
        }
        if (item.type === "reasoning") {
          const summaryText = item.summary?.map((s: any) => s.text).filter(Boolean).join("\n");
          if (!summaryText) return null;
          return (
            <div key={i} className="bg-gray-50 border border-gray-300 rounded p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 font-medium">Reasoning</span>
              </div>
              <div className="whitespace-pre-wrap text-gray-600 text-sm">{summaryText}</div>
            </div>
          );
        }
        if (item.type === "function_call") {
          return (
            <div key={i} className="bg-purple-50 border border-purple-200 rounded p-3">
              <div className="font-medium text-purple-700 mb-1">Function: {item.name}</div>
              <pre className="whitespace-pre-wrap text-xs">{item.arguments}</pre>
            </div>
          );
        }
        return <pre key={i} className="bg-gray-50 p-3 rounded whitespace-pre-wrap text-xs">{JSON.stringify(item, null, 2)}</pre>;
      })}
    </div>
  );
}

// --- Streaming Content (reconstructed from SSE events) ---

function parseThinkTags(text: string): { type: string; content: string }[] {
  const blocks: { type: string; content: string }[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) blocks.push({ type: "text", content: before });
    }
    const thinking = match[1].trim();
    if (thinking) blocks.push({ type: "thinking", content: thinking });
    lastIndex = regex.lastIndex;
  }
  const rest = text.slice(lastIndex).trim();
  if (rest) blocks.push({ type: "text", content: rest });
  return blocks;
}

function StreamingContent({ events, fallback }: { events?: any[]; fallback?: string }) {
  if (!events || !Array.isArray(events) || events.length === 0) {
    if (!fallback) return <div className="text-gray-400 italic">No content captured</div>;
    return <ContentBlocks blocks={parseThinkTags(fallback)} />;
  }

  // Anthropic format: reconstruct from content_block_start/delta events
  const hasAnthropicBlocks = events.some((e) => e.type === "content_block_start");
  if (hasAnthropicBlocks) {
    const blocks: { type: string; content: string }[] = [];
    let currentIndex = -1;

    for (const evt of events) {
      if (evt.type === "content_block_start" && evt.content_block) {
        currentIndex = evt.index ?? blocks.length;
        blocks[currentIndex] = { type: evt.content_block.type ?? "text", content: "" };
      } else if (evt.type === "content_block_delta") {
        const idx = evt.index ?? currentIndex;
        if (idx >= 0 && blocks[idx]) {
          if (evt.delta?.text) blocks[idx].content += evt.delta.text;
          if (evt.delta?.thinking) blocks[idx].content += evt.delta.thinking;
        }
      }
    }

    const validBlocks = blocks.filter((b) => b && b.content);
    if (validBlocks.length > 0) return <ContentBlocks blocks={validBlocks} />;
  }

  // OpenAI Responses API: reconstruct from response.output_text.delta events
  const hasResponsesApi = events.some((e) => e.type?.startsWith("response."));
  if (hasResponsesApi) {
    let textContent = "";
    for (const evt of events) {
      if (evt.type === "response.output_text.delta" && evt.delta) {
        textContent += evt.delta;
      }
    }
    if (textContent) return <ContentBlocks blocks={[{ type: "text", content: textContent }]} />;
  }

  // OpenAI Chat Completions: aggregate content from choices, then parse <think> tags
  let fullContent = "";
  for (const evt of events) {
    const c = evt.choices?.[0]?.delta?.content;
    if (c) fullContent += c;
  }
  if (fullContent) return <ContentBlocks blocks={parseThinkTags(fullContent)} />;

  if (fallback) return <ContentBlocks blocks={parseThinkTags(fallback)} />;
  return <div className="text-gray-400 italic">No content captured</div>;
}

function ContentBlocks({ blocks }: { blocks: { type: string; content: string }[] }) {
  return (
    <div className="space-y-2">
      {blocks.map((block, i) =>
        block.type === "thinking" ? (
          <div key={i} className="bg-gray-50 border border-gray-300 rounded p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="px-1.5 py-0.5 rounded text-xs bg-gray-200 text-gray-600 font-medium">Thinking</span>
            </div>
            <div className="whitespace-pre-wrap text-gray-600 text-sm">{block.content}</div>
          </div>
        ) : (
          <div key={i} className="bg-green-50 border border-green-200 rounded p-3 whitespace-pre-wrap">{block.content}</div>
        )
      )}
    </div>
  );
}

// --- SSE Event Row ---

function SSEEventRow({ index, event }: { index: number; event: any }) {
  const [expanded, setExpanded] = useState(false);
  const eventType = event.type ?? event.object ?? "unknown";

  const typeColors: Record<string, string> = {
    message_start: "bg-blue-100 text-blue-700",
    content_block_start: "bg-cyan-100 text-cyan-700",
    content_block_delta: "bg-green-100 text-green-700",
    thinking_delta: "bg-gray-200 text-gray-700",
    content_block_stop: "bg-gray-100 text-gray-600",
    message_delta: "bg-amber-100 text-amber-700",
    message_stop: "bg-gray-100 text-gray-600",
    "chat.completion.chunk": "bg-indigo-100 text-indigo-700",
    "response.created": "bg-blue-100 text-blue-700",
    "response.in_progress": "bg-blue-100 text-blue-700",
    "response.completed": "bg-green-100 text-green-700",
    "response.failed": "bg-red-100 text-red-700",
    "response.output_item.added": "bg-cyan-100 text-cyan-700",
    "response.output_item.done": "bg-gray-100 text-gray-600",
    "response.content_part.added": "bg-cyan-100 text-cyan-700",
    "response.content_part.done": "bg-gray-100 text-gray-600",
    "response.output_text.delta": "bg-green-100 text-green-700",
    "response.output_text.done": "bg-gray-100 text-gray-600",
  };

  const preview = getEventPreview(event);

  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-gray-300 w-5 text-right shrink-0">#{index + 1}</span>
        <span className={`px-1.5 py-0.5 rounded text-xs shrink-0 ${typeColors[eventType] ?? "bg-gray-100 text-gray-600"}`}>
          {eventType}
        </span>
        <span className="text-gray-500 truncate">{preview}</span>
        <span className="text-gray-300 text-xs ml-auto shrink-0">{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && (
        <pre className="mt-1 ml-7 bg-white p-2 rounded border text-xs overflow-auto max-h-40 whitespace-pre-wrap">
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </div>
  );
}

function getEventPreview(event: any): string {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return event.delta.slice(0, 100);
  if (event.type === "response.completed" && event.response?.usage) return `tokens: in=${event.response.usage.input_tokens} out=${event.response.usage.output_tokens}`;
  if (event.type === "response.output_item.added" && event.item?.type) return event.item.type;
  if (event.type === "response.created" && event.response?.model) return event.response.model;
  if (event.delta?.thinking) return event.delta.thinking.slice(0, 100);
  if (event.delta?.text) return event.delta.text.slice(0, 100);
  if (event.delta?.content) return event.delta.content.slice(0, 100);
  if (event.choices?.[0]?.delta?.content) return event.choices[0].delta.content.slice(0, 100);
  if (event.delta?.stop_reason) return `stop: ${event.delta.stop_reason}`;
  if (event.content_block?.type) return event.content_block.type;
  if (event.message?.model) return event.message.model;
  if (event.usage) return `tokens: ${JSON.stringify(event.usage)}`;
  return "";
}

// --- Tool List ---

function ToolList({ tools }: { tools: any[] }) {
  return (
    <div className="space-y-1">
      {tools.map((tool, i) => <ToolItem key={i} tool={tool} />)}
    </div>
  );
}

function ToolItem({ tool }: { tool: any }) {
  const [open, setOpen] = useState(false);
  const name = tool.name || tool.function?.name || `Tool ${tool.type ?? ""}`;
  const desc = tool.description || tool.function?.description;
  const params = tool.input_schema || tool.function?.parameters;
  const properties = params?.properties;
  const required = new Set(params?.required ?? []);

  return (
    <div className="border border-gray-200 rounded">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className={`text-gray-400 text-xs transition-transform ${open ? "rotate-90" : ""}`}>&#9654;</span>
        <span className="font-mono font-medium text-indigo-700">{name}</span>
        {desc && <span className="text-gray-400 truncate ml-1">— {desc}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {desc && <div className="text-gray-600 text-xs">{desc}</div>}
          {properties && Object.keys(properties).length > 0 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
                  <th className="py-1 pr-2 text-left font-medium">Parameter</th>
                  <th className="py-1 pr-2 text-left font-medium">Type</th>
                  <th className="py-1 text-left font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(properties).map(([pName, pSchema]: [string, any]) => (
                  <tr key={pName} className="border-b border-gray-50">
                    <td className="py-1 pr-2 font-mono align-top">
                      {pName}
                      {required.has(pName) && <span className="text-red-400 ml-0.5">*</span>}
                    </td>
                    <td className="py-1 pr-2 text-gray-500 align-top whitespace-nowrap">
                      {pSchema.type}
                      {pSchema.enum && <span className="text-gray-400 ml-1">[{pSchema.enum.join(", ")}]</span>}
                    </td>
                    <td className="py-1 text-gray-600 break-all">{pSchema.description || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-gray-400 italic">No parameters</div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Copyable JSON block ---

function CopyableJSON({ data }: { data: any }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(data, null, 2);

  const copy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative">
      <button onClick={copy} className="absolute top-2 right-2 px-2 py-0.5 bg-white border rounded text-xs text-gray-500 hover:text-gray-700">
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="bg-gray-50 p-3 rounded overflow-auto max-h-96 whitespace-pre-wrap">{json}</pre>
    </div>
  );
}

// --- Collapsible Section ---

function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 mb-1 w-full text-left">
        <span className="text-xs text-gray-400">{open ? "▼" : "▶"}</span>
        {title}
      </button>
      {open && <div className="ml-4">{children}</div>}
    </div>
  );
}

// --- Tags Cell ---

const AGENT_COLORS: Record<string, string> = {
  "claude-code": "bg-orange-100 text-orange-700",
  codex: "bg-blue-100 text-blue-700",
  openclaw: "bg-purple-100 text-purple-700",
};

function AgentBadge({ agent }: { agent?: string }) {
  if (!agent) return null;
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${AGENT_COLORS[agent] ?? "bg-gray-100 text-gray-600"}`}>
      {agent}
    </span>
  );
}

function TagsCell({ value }: { value?: string }) {
  if (!value) return null;
  return <span className="truncate">{value}</span>;
}

// --- Headers Table ---

function HeadersTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div className="text-gray-400 italic">No headers recorded</div>;
  }
  return (
    <table className="w-full text-xs">
      <tbody>
        {Object.entries(headers).map(([key, value]) => (
          <tr key={key} className="border-b border-gray-100">
            <td className="py-1 pr-2 font-mono text-gray-500 whitespace-nowrap align-top">{key}</td>
            <td className="py-1 font-mono break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
