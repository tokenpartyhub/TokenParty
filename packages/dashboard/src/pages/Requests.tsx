import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatCost } from "./Settings";

interface Filters {
  token_id: string;
  provider_id: string;
  model: string;
  status: string;
  tags: string;
}

const emptyFilters: Filters = { token_id: "", provider_id: "", model: "", status: "", tags: "" };

export default function Requests({ mode = "admin" }: { mode?: "admin" | "user" }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"request" | "response">("request");
  const [activeSection, setActiveSection] = useState("headers");
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const handler = (e: MouseEvent) => {
      if (detailRef.current && !detailRef.current.contains(e.target as Node)) {
        setSelected(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selected]);
  const [keyNames, setKeyNames] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<{ key: string; name: string }[]>([]);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const limit = 20;

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
  }, [offset, filters, mode]);

  const updateFilter = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setOffset(0);
  };

  const hasFilters = Object.values(filters).some(Boolean);

  const loadDetail = async (id: string) => {
    const detail = mode === "admin" ? await api.getRequestDetail(id) : await api.getUserRequestDetail(id);
    setSelected(detail);
    setActiveTab("request");
    setActiveSection("headers");
    window.dispatchEvent(new CustomEvent("collapse-nav"));
  };

  const reqLog = selected?.logs?.find((l: any) => l.type === "request");
  const resLog = selected?.logs?.find((l: any) => l.type === "response");

  return (
    <div className="h-full relative">
      {/* List */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Requests</h2>
        <div className="flex flex-wrap gap-2 mb-4 items-end">
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
          <select value={filters.status} onChange={(e) => updateFilter({ status: e.target.value })} className="border rounded px-2 py-1.5 text-sm">
            <option value="">All Status</option>
            <option value="ok">Success</option>
            <option value="error">Error</option>
          </select>
          <input
            type="text"
            placeholder="Tags (comma separated)"
            value={filters.tags}
            onChange={(e) => updateFilter({ tags: e.target.value })}
            className="border rounded px-2 py-1.5 text-sm w-48"
          />
          {hasFilters && (
            <button onClick={() => { setFilters(emptyFilters); setOffset(0); }} className="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-700">
              Reset
            </button>
          )}
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
                <th className="px-3 py-2 text-left">Tags</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr
                  key={req.id}
                  onClick={() => loadDetail(req.id)}
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
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[150px] truncate">{req.custom_tags || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between mt-4 text-sm">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="px-3 py-1 border rounded disabled:opacity-50">Previous</button>
          <span className="text-gray-500">{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
          <button disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} className="px-3 py-1 border rounded disabled:opacity-50">Next</button>
        </div>
      </div>

      {/* Detail Panel - overlay */}
      {selected && (
        <div ref={detailRef} className="fixed inset-y-0 right-0 w-3/4 bg-white shadow-xl flex flex-col overflow-hidden z-20">
          {/* Header: title + meta + tabs in compact layout */}
          <div className="px-4 py-2 border-b bg-gray-50 shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-3 min-w-0 text-xs">
                <span className="font-bold text-sm shrink-0">Detail</span>
                <span className="text-gray-400 font-mono truncate">{selected.id}</span>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none ml-2 shrink-0">&times;</button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
              <span><span className="text-gray-400">Model</span> {selected.model}</span>
              <span><span className="text-gray-400">Provider</span> {selected.provider_id}</span>
              <span><span className="text-gray-400">Latency</span> {selected.latency_ms}ms</span>
              <span><span className="text-gray-400">Status</span> <span className={selected.status === 200 ? "text-green-600" : "text-red-600"}>{selected.status}</span></span>
              <span><span className="text-gray-400">Entry</span> {reqLog?.headers?.["x-entry-protocol"] ?? "-"}</span>
              <span><span className="text-gray-400">Cost</span> {selected.cost > 0 ? formatCost(selected.cost) : "-"}</span>
              {resLog?.streaming && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">SSE</span>}
            </div>
            {(selected.input_tokens > 0 || selected.output_tokens > 0) && (
              <div className="mt-1.5">
                <TokenUsageBar input={selected.input_tokens} output={selected.output_tokens} cacheRead={selected.cache_read_tokens ?? 0} cacheWrite={selected.cache_write_tokens ?? 0} />
              </div>
            )}
          </div>

          {/* Error banner */}
          {resLog?.error && (
            <div className="px-4 py-1 bg-red-50 text-red-700 text-xs border-b shrink-0">Error: {resLog.error}</div>
          )}

          {/* Content: side nav + detail */}
          <div className="flex-1 flex min-h-0">
            {/* Section side nav */}
            <div className="w-28 shrink-0 border-r bg-gray-50 flex flex-col py-1 overflow-y-auto text-xs">
              {/* Request / Response toggle */}
              <div className="flex border-b mb-1">
                <button onClick={() => { setActiveTab("request"); setActiveSection("headers"); }} className={`flex-1 py-1.5 text-center font-medium ${activeTab === "request" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-gray-400"}`}>Req</button>
                <button onClick={() => { setActiveTab("response"); setActiveSection("headers"); }} className={`flex-1 py-1.5 text-center font-medium ${activeTab === "response" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-gray-400"}`}>Res</button>
              </div>
              {/* Section items */}
              {activeTab === "request" && reqLog && (
                <>
                  <SectionNavItem id="headers" label="Headers" active={activeSection} onClick={setActiveSection} />
                  <SectionNavItem id="messages" label={`Messages (${reqLog.body?.messages?.length ?? 0})`} active={activeSection} onClick={setActiveSection} />
                  {reqLog.body?.system && <SectionNavItem id="system" label="System" active={activeSection} onClick={setActiveSection} />}
                  {reqLog.body?.tools && <SectionNavItem id="tools" label={`Tools (${reqLog.body.tools.length})`} active={activeSection} onClick={setActiveSection} />}
                  <SectionNavItem id="raw" label="Raw JSON" active={activeSection} onClick={setActiveSection} />
                </>
              )}
              {activeTab === "response" && resLog && (
                <>
                  <SectionNavItem id="headers" label="Headers" active={activeSection} onClick={setActiveSection} />
                  <SectionNavItem id="content" label="Content" active={activeSection} onClick={setActiveSection} />
                  {resLog.streaming && resLog.body && Array.isArray(resLog.body) && resLog.body.length > 0 && (
                    <SectionNavItem id="events" label={`SSE (${resLog.body.length})`} active={activeSection} onClick={setActiveSection} />
                  )}
                  {!resLog.streaming && <SectionNavItem id="raw" label="Raw JSON" active={activeSection} onClick={setActiveSection} />}
                </>
              )}
            </div>

            {/* Section content */}
            <div className="flex-1 overflow-auto p-3 text-xs min-w-0">
              {activeTab === "request" && reqLog && (
                <>
                  {activeSection === "headers" && <HeadersTable headers={reqLog.headers} />}
                  {activeSection === "messages" && <MessageList messages={reqLog.body?.messages} />}
                  {activeSection === "system" && reqLog.body?.system && (
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
                  {activeSection === "tools" && reqLog.body?.tools && <ToolList tools={reqLog.body.tools} />}
                  {activeSection === "raw" && <CopyableJSON data={reqLog.body} />}
                </>
              )}

              {activeTab === "response" && resLog && (
                <>
                  {activeSection === "headers" && <HeadersTable headers={resLog.headers} />}
                  {activeSection === "content" && (
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
                  {activeSection === "events" && resLog.streaming && resLog.body && Array.isArray(resLog.body) && (
                    <div className="bg-gray-50 rounded overflow-auto divide-y divide-gray-200">
                      {resLog.body.map((event: any, i: number) => (
                        <SSEEventRow key={i} index={i} event={event} />
                      ))}
                    </div>
                  )}
                  {activeSection === "raw" && <CopyableJSON data={resLog.body} />}
                </>
              )}

              {activeTab === "response" && !resLog && (
                <div className="text-gray-400 italic">No response recorded</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Token Usage Bar ---

function SectionNavItem({ id, label, active, onClick }: { id: string; label: string; active: string; onClick: (id: string) => void }) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`text-left px-3 py-1.5 text-xs truncate ${active === id ? "bg-white text-indigo-600 font-medium border-r-2 border-indigo-600" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"}`}
    >
      {label}
    </button>
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

  return (
    <div className="space-y-1">
      {messages.map((msg, i) => (
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

// --- Headers Table ---

function HeadersTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div className="text-gray-400 italic">No headers recorded</div>;
  }
  const entries = Object.entries(headers);
  const mid = Math.ceil(entries.length / 2);
  const cols = [entries.slice(0, mid), entries.slice(mid)];
  return (
    <div className="grid grid-cols-2 gap-x-4">
      {cols.map((col, ci) => (
        <table key={ci} className="w-full text-xs">
          <tbody>
            {col.map(([key, value]) => (
              <tr key={key} className="border-b border-gray-100">
                <td className="py-1 pr-2 font-mono text-gray-500 whitespace-nowrap align-top">{key}</td>
                <td className="py-1 font-mono break-all">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
