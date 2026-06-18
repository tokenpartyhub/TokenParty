import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RequestContext } from "./types";

// Shared Anthropic-protocol view components used by agent detail adapters.
// Both claude-code and openclaw (and future Anthropic-protocol agents) consume
// these as peers; an adapter may override any section independently.

// --- Types ---

export interface ToolCount {
  name: string;
  count: number;
}

export interface FlowItem {
  type: "user" | "system-context" | "agent-delegation" | "tool-chain" | "assistant-text";
  preview: string;
  toolCounts?: Record<string, number>;
  totalTools?: number;
  msgRange: [number, number];
}

export interface DiagItem {
  level: "error" | "warning" | "info";
  title: string;
  detail: string;
}

// --- Helpers ---

export function analyzeToolUsage(messages: any[]): { tools: ToolCount[]; total: number; defined: number } {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool_use" && part.name) {
        counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
      }
    }
  }
  const tools = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const total = tools.reduce((s, t) => s + t.count, 0);
  return { tools, total, defined: 0 };
}

export function extractTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n");
  }
  return "";
}

export function buildConversationFlow(messages: any[]): FlowItem[] {
  const items: FlowItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "user") {
      const textContent = extractTextContent(msg.content);
      if (textContent.includes("<system-reminder>")) {
        items.push({ type: "system-context", preview: "System context injection", msgRange: [i, i] });
      } else if (/<message\s+from=/.test(textContent)) {
        const fromMatch = textContent.match(/<message\s+from="([^"]+)"/);
        const agentName = fromMatch?.[1] ?? "agent";
        const innerText = textContent.replace(/<message[^>]*>[\s\S]*?<\/message>/g, "").trim();
        const preview = innerText.slice(0, 100) || `Delegation from ${agentName}`;
        items.push({ type: "agent-delegation", preview: `[${agentName}] ${preview}`, msgRange: [i, i] });
      } else {
        const clean = textContent.replace(/<[^>]+>/g, "").trim();
        if (clean) {
          items.push({ type: "user", preview: clean.slice(0, 120), msgRange: [i, i] });
        }
      }
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      const content = msg.content;
      const startIdx = i;

      if (typeof content === "string") {
        if (content.trim()) {
          items.push({ type: "assistant-text", preview: content.slice(0, 120), msgRange: [i, i] });
        }
        i++;
        continue;
      }

      if (Array.isArray(content)) {
        const hasToolUse = content.some((p: any) => p.type === "tool_use");
        const textParts = content.filter((p: any) => p.type === "text" && p.text?.trim());

        if (textParts.length > 0 && !hasToolUse) {
          const text = textParts.map((p: any) => p.text).join(" ").trim();
          items.push({ type: "assistant-text", preview: text.slice(0, 120), msgRange: [i, i] });
          i++;
          continue;
        }

        if (hasToolUse) {
          const toolCounts: Record<string, number> = {};
          let totalTools = 0;
          let endIdx = i;

          // Count tools in this assistant message
          for (const p of content) {
            if (p.type === "tool_use" && p.name) {
              toolCounts[p.name] = (toolCounts[p.name] ?? 0) + 1;
              totalTools++;
            }
          }

          // Continue counting through subsequent tool_result → assistant(tool_use) pairs
          let j = i + 1;
          while (j < messages.length) {
            if (messages[j].role === "user") {
              const uc = messages[j].content;
              const allToolResults = Array.isArray(uc) && uc.every((p: any) => p.type === "tool_result");
              if (!allToolResults) break;
              endIdx = j;
              j++;
              if (j < messages.length && messages[j].role === "assistant") {
                const ac = messages[j].content;
                if (Array.isArray(ac) && ac.some((p: any) => p.type === "tool_use")) {
                  for (const p of ac) {
                    if (p.type === "tool_use" && p.name) {
                      toolCounts[p.name] = (toolCounts[p.name] ?? 0) + 1;
                      totalTools++;
                    }
                  }
                  endIdx = j;
                  j++;
                  continue;
                }
              }
              break;
            }
            break;
          }

          const textPreview = textParts.length > 0 ? textParts[0].text.slice(0, 60) + " → " : "";
          const topTools = Object.entries(toolCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([n, c]) => `${n}:${c}`)
            .join(", ");

          items.push({
            type: "tool-chain",
            preview: `${textPreview}${totalTools} calls (${topTools})`,
            toolCounts,
            totalTools,
            msgRange: [startIdx, endIdx],
          });

          i = endIdx + 1;
          continue;
        }
      }

      i++;
      continue;
    }

    i++;
  }

  return items;
}

// --- Pricing (per 1M tokens, USD) ---

export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-haiku-4": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-3-opus": { input: 15, output: 75, cacheRead: 1.5 },
};

export function getModelPricing(model: string) {
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key)) return pricing;
  }
  return null;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// --- Stop reason extraction ---

export function extractStopReason(resLog: any): string | null {
  if (!resLog) return null;
  if (resLog.streaming && Array.isArray(resLog.body)) {
    for (let i = resLog.body.length - 1; i >= 0; i--) {
      const evt = resLog.body[i];
      if (evt.type === "message_delta" && evt.delta?.stop_reason) return evt.delta.stop_reason;
    }
    return null;
  }
  return resLog.body?.stop_reason ?? null;
}

// --- Thinking extraction from response ---

export function extractThinkingFromResponse(resLog: any): { chars: number; blocks: number } {
  if (!resLog) return { chars: 0, blocks: 0 };
  let chars = 0;
  let blocks = 0;

  if (resLog.streaming && Array.isArray(resLog.body)) {
    let inThinking = false;
    for (const evt of resLog.body) {
      if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
        inThinking = true;
        blocks++;
      }
      if (evt.type === "content_block_stop") inThinking = false;
      if (evt.type === "content_block_delta" && evt.delta?.thinking) {
        chars += evt.delta.thinking.length;
      }
    }
  } else if (resLog.body?.content) {
    for (const block of resLog.body.content) {
      if (block.type === "thinking" && block.thinking) {
        blocks++;
        chars += block.thinking.length;
      }
    }
  }
  return { chars, blocks };
}

// --- Response tool calls extraction ---

export function extractResponseToolCalls(resLog: any): string[] {
  const tools: string[] = [];
  if (!resLog) return tools;

  if (resLog.streaming && Array.isArray(resLog.body)) {
    for (const evt of resLog.body) {
      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && evt.content_block.name) {
        tools.push(evt.content_block.name);
      }
    }
  } else if (resLog.body?.content) {
    for (const block of resLog.body.content) {
      if (block.type === "tool_use" && block.name) tools.push(block.name);
    }
  }
  return tools;
}

// --- Diagnostics ---

export function runDiagnostics(reqLog: any, resLog: any, ctx: RequestContext): DiagItem[] {
  const items: DiagItem[] = [];
  const stopReason = extractStopReason(resLog);
  const messages = reqLog?.body?.messages;
  const messageCount = Array.isArray(messages) ? messages.length : 0;

  if (ctx.status !== 200) {
    items.push({ level: "error", title: "Request Failed", detail: `HTTP ${ctx.status}${ctx.error ? `: ${ctx.error}` : ""}` });
  }

  if (stopReason === "max_tokens") {
    items.push({ level: "warning", title: "Output Truncated", detail: `Hit max_tokens (${formatTokens(reqLog?.body?.max_tokens ?? 0)}) — response was cut off` });
  }

  if (ctx.latencyMs > 30000) {
    const seconds = (ctx.latencyMs / 1000).toFixed(1);
    const thinking = reqLog?.body?.thinking?.type === "enabled";
    const reason = thinking ? "extended thinking active" : ctx.outputTokens > 10000 ? "large output" : "high context volume";
    items.push({ level: "info", title: "High Latency", detail: `${seconds}s — likely due to ${reason}` });
  }

  if (ctx.inputTokens > 100000) {
    items.push({ level: "info", title: "Large Context", detail: `${formatTokens(ctx.inputTokens)} input tokens across ${messageCount} messages` });
  }

  const system = reqLog?.body?.system;
  const systemBlocks = Array.isArray(system) ? system : [];
  const hasCacheHints = systemBlocks.some((b: any) => b.cache_control);
  if (hasCacheHints && ctx.cacheReadTokens === 0) {
    items.push({ level: "warning", title: "Cache Miss", detail: "System prompt has cache hints but 0 cache reads — first request in session or cache expired" });
  }

  if (reqLog?.body?.thinking?.type === "enabled") {
    const budget = reqLog.body.thinking.budget_tokens ?? 0;
    const thinking = extractThinkingFromResponse(resLog);
    const estimatedTokens = Math.round(thinking.chars / 4);
    if (budget > 0 && estimatedTokens > budget * 0.9) {
      items.push({ level: "info", title: "Thinking Near Limit", detail: `~${formatTokens(estimatedTokens)} used of ${formatTokens(budget)} budget` });
    }
  }

  return items;
}

// --- View components ---

export function ToolSummary({ reqLog }: { reqLog: any }) {
  const analysis = useMemo(() => {
    const messages = reqLog?.body?.messages ?? [];
    const result = analyzeToolUsage(messages);
    result.defined = reqLog?.body?.tools?.length ?? 0;
    return result;
  }, [reqLog]);

  if (analysis.tools.length === 0) return <div className="text-gray-400 italic text-xs">No tool calls</div>;

  const maxCount = analysis.tools[0].count;

  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs">
        <div className="bg-gray-50 rounded px-3 py-2">
          <div className="text-gray-400">Total Calls</div>
          <div className="text-lg font-bold">{analysis.total}</div>
        </div>
        <div className="bg-gray-50 rounded px-3 py-2">
          <div className="text-gray-400">Tools Used</div>
          <div className="text-lg font-bold">{analysis.tools.length}</div>
        </div>
        <div className="bg-gray-50 rounded px-3 py-2">
          <div className="text-gray-400">Tools Defined</div>
          <div className="text-lg font-bold">{analysis.defined}</div>
        </div>
      </div>
      <div className="space-y-1">
        {analysis.tools.map((tool) => (
          <div key={tool.name} className="flex items-center gap-2 text-xs">
            <span className="w-24 text-right font-mono text-gray-600 truncate shrink-0" title={tool.name}>{tool.name}</span>
            <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
              <div
                className="h-full bg-indigo-400 rounded-full"
                style={{ width: `${(tool.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right text-gray-500 shrink-0">{tool.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConversationFlow({ reqLog }: { reqLog: any }) {
  const flow = useMemo(() => buildConversationFlow(reqLog?.body?.messages ?? []), [reqLog]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (flow.length === 0) return <div className="text-gray-400 italic text-xs">No messages</div>;

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const typeStyles: Record<string, { border: string; bg: string; dot: string; label: string }> = {
    user: { border: "border-blue-200", bg: "bg-blue-50", dot: "bg-blue-400", label: "User" },
    "system-context": { border: "border-amber-200", bg: "bg-amber-50", dot: "bg-amber-400", label: "System" },
    "agent-delegation": { border: "border-cyan-200", bg: "bg-cyan-50", dot: "bg-cyan-400", label: "Agent" },
    "tool-chain": { border: "border-purple-200", bg: "bg-purple-50", dot: "bg-purple-400", label: "Tools" },
    "assistant-text": { border: "border-green-200", bg: "bg-green-50", dot: "bg-green-400", label: "Output" },
  };

  return (
    <div className="relative pl-4">
      <div className="absolute left-[7px] top-0 bottom-0 w-px bg-gray-200" />
      <div className="space-y-1">
        {flow.map((item, idx) => {
          const style = typeStyles[item.type] ?? typeStyles.user;
          const isExpanded = expanded.has(idx);

          return (
            <div key={idx} className="relative">
              <div className={`absolute left-[-13px] top-2 w-2.5 h-2.5 rounded-full ${style.dot} border-2 border-white`} />
              <div
                className={`${style.bg} border ${style.border} rounded px-3 py-1.5 cursor-pointer hover:opacity-80`}
                onClick={() => toggle(idx)}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className={`font-medium ${style.dot.replace("bg-", "text-").replace("400", "700")}`}>{style.label}</span>
                  <span className="text-gray-500 truncate">{item.preview}</span>
                  <span className="text-gray-300 ml-auto shrink-0">
                    [{item.msgRange[0]}-{item.msgRange[1]}]
                  </span>
                </div>
                {isExpanded && item.type === "tool-chain" && item.toolCounts && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(item.toolCounts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([name, count]) => (
                        <span key={name} className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-mono">
                          {name}: {count}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CostInsights({ reqLog, resLog, ctx }: { reqLog: any; resLog: any; ctx: RequestContext }) {
  const analysis = useMemo(() => {
    const pricing = getModelPricing(ctx.model);
    const totalInput = ctx.inputTokens + ctx.cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? (ctx.cacheReadTokens / totalInput) * 100 : 0;

    let cacheSavings = 0;
    if (pricing && ctx.cacheReadTokens > 0) {
      const fullCost = (ctx.cacheReadTokens / 1_000_000) * pricing.input;
      const cachedCost = (ctx.cacheReadTokens / 1_000_000) * pricing.cacheRead;
      cacheSavings = fullCost - cachedCost;
    }

    const system = reqLog?.body?.system;
    const systemBlocks = Array.isArray(system) ? system : (system ? [{ text: system }] : []);
    const cachedBlocks = systemBlocks.filter((b: any) => b.cache_control).length;
    const totalSystemChars = systemBlocks.reduce((s: number, b: any) => s + (b.text?.length ?? 0), 0);

    const thinkingConfig = reqLog?.body?.thinking;
    const thinkingEnabled = thinkingConfig?.type === "enabled";
    const thinkingBudget = thinkingConfig?.budget_tokens ?? 0;
    const thinking = extractThinkingFromResponse(resLog);

    return { cacheHitRate, cacheSavings, pricing, systemBlocks: systemBlocks.length, cachedBlocks, totalSystemChars, thinkingEnabled, thinkingBudget, thinking };
  }, [reqLog, resLog, ctx]);

  const statBox = "bg-gray-50 rounded px-3 py-2 text-xs";

  return (
    <div className="space-y-4">
      {/* Cache Analysis */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-2">Cache</div>
        <div className="flex gap-3 mb-2">
          <div className={statBox}>
            <div className="text-gray-400">Hit Rate</div>
            <div className={`text-lg font-bold ${analysis.cacheHitRate > 50 ? "text-green-600" : analysis.cacheHitRate > 0 ? "text-amber-600" : "text-gray-400"}`}>
              {analysis.cacheHitRate.toFixed(1)}%
            </div>
          </div>
          <div className={statBox}>
            <div className="text-gray-400">Cache Read</div>
            <div className="text-lg font-bold">{formatTokens(ctx.cacheReadTokens)}</div>
          </div>
          <div className={statBox}>
            <div className="text-gray-400">Cache Write</div>
            <div className="text-lg font-bold">{formatTokens(ctx.cacheWriteTokens)}</div>
          </div>
          {analysis.cacheSavings > 0 && (
            <div className={statBox}>
              <div className="text-gray-400">Saved</div>
              <div className="text-lg font-bold text-green-600">${analysis.cacheSavings.toFixed(4)}</div>
            </div>
          )}
        </div>
        {/* Cache bar */}
        {(ctx.inputTokens + ctx.cacheReadTokens) > 0 && (
          <div className="flex h-3 rounded overflow-hidden bg-gray-200">
            <div className="bg-green-400" style={{ width: `${analysis.cacheHitRate}%` }} title={`Cache hit: ${formatTokens(ctx.cacheReadTokens)}`} />
            <div className="bg-blue-400" style={{ width: `${100 - analysis.cacheHitRate}%` }} title={`Uncached: ${formatTokens(ctx.inputTokens)}`} />
          </div>
        )}
        {/* System prompt cache status */}
        {analysis.systemBlocks > 0 && (
          <div className="text-xs text-gray-500 mt-1">
            System: {analysis.systemBlocks} blocks ({(analysis.totalSystemChars / 1024).toFixed(1)} KB)
            {analysis.cachedBlocks > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-green-100 text-green-700">{analysis.cachedBlocks} cached</span>
            )}
          </div>
        )}
      </div>

      {/* Thinking Analysis */}
      {analysis.thinkingEnabled && (
        <div>
          <div className="text-xs font-medium text-gray-500 mb-2">Thinking</div>
          <div className="flex gap-3 mb-2">
            <div className={statBox}>
              <div className="text-gray-400">Budget</div>
              <div className="text-lg font-bold">{formatTokens(analysis.thinkingBudget)}</div>
            </div>
            <div className={statBox}>
              <div className="text-gray-400">Output</div>
              <div className="text-lg font-bold">{analysis.thinking.blocks > 0 ? `${(analysis.thinking.chars / 1024).toFixed(1)} KB` : "—"}</div>
            </div>
            <div className={statBox}>
              <div className="text-gray-400">Blocks</div>
              <div className="text-lg font-bold">{analysis.thinking.blocks}</div>
            </div>
          </div>
        </div>
      )}

      {/* Cost Breakdown Bar */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-2">Token Breakdown</div>
        {(() => {
          const parts = [
            { label: "Cache Read", tokens: ctx.cacheReadTokens, color: "bg-green-400" },
            { label: "Input", tokens: ctx.inputTokens, color: "bg-blue-400" },
            { label: "Cache Write", tokens: ctx.cacheWriteTokens, color: "bg-amber-400" },
            { label: "Output", tokens: ctx.outputTokens, color: "bg-purple-400" },
          ].filter(p => p.tokens > 0);
          const total = parts.reduce((s, p) => s + p.tokens, 0);
          if (total === 0) return null;
          return (
            <div>
              <div className="flex h-4 rounded overflow-hidden">
                {parts.map((p) => (
                  <div key={p.label} className={p.color} style={{ width: `${(p.tokens / total) * 100}%` }} title={`${p.label}: ${formatTokens(p.tokens)}`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-500">
                {parts.map((p) => (
                  <span key={p.label} className="flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${p.color}`} />
                    {p.label}: {formatTokens(p.tokens)}
                  </span>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

export function ConfigOverview({ reqLog, resLog }: { reqLog: any; resLog: any }) {
  const config = useMemo(() => {
    const body = reqLog?.body ?? {};
    const system = body.system;
    const systemBlocks = Array.isArray(system) ? system : (system ? [{ text: system }] : []);
    const toolCalls = extractResponseToolCalls(resLog);
    const stopReason = extractStopReason(resLog);

    let toolChoiceLabel = "auto";
    if (body.tool_choice) {
      if (typeof body.tool_choice === "string") toolChoiceLabel = body.tool_choice;
      else if (body.tool_choice.type === "tool") toolChoiceLabel = body.tool_choice.name ?? "specific";
      else toolChoiceLabel = body.tool_choice.type ?? "auto";
    }

    let thinkingLabel = "Disabled";
    if (body.thinking?.type === "enabled") {
      thinkingLabel = `Enabled (${formatTokens(body.thinking.budget_tokens ?? 0)})`;
    }

    return {
      model: body.model ?? "—",
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      topK: body.top_k,
      thinking: thinkingLabel,
      toolChoice: toolChoiceLabel,
      stream: body.stream,
      stopSequences: body.stop_sequences,
      systemBlocks,
      toolCalls,
      stopReason,
    };
  }, [reqLog, resLog]);

  const kvClass = "flex justify-between py-1 border-b border-gray-100 text-xs";

  return (
    <div className="space-y-4">
      {/* Model Parameters */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-2">Parameters</div>
        <div className="bg-gray-50 rounded px-3 py-1">
          <div className={kvClass}><span className="text-gray-400">Model</span><span className="font-mono">{config.model}</span></div>
          {config.maxTokens != null && <div className={kvClass}><span className="text-gray-400">max_tokens</span><span className="font-mono">{formatTokens(config.maxTokens)}</span></div>}
          <div className={kvClass}><span className="text-gray-400">temperature</span><span className="font-mono">{config.temperature ?? "default"}</span></div>
          {config.topP != null && <div className={kvClass}><span className="text-gray-400">top_p</span><span className="font-mono">{config.topP}</span></div>}
          {config.topK != null && <div className={kvClass}><span className="text-gray-400">top_k</span><span className="font-mono">{config.topK}</span></div>}
          <div className={kvClass}><span className="text-gray-400">thinking</span><span className="font-mono">{config.thinking}</span></div>
          <div className={kvClass}><span className="text-gray-400">tool_choice</span><span className="font-mono">{config.toolChoice}</span></div>
          <div className={kvClass}><span className="text-gray-400">stream</span><span className="font-mono">{String(config.stream ?? false)}</span></div>
          {config.stopSequences && <div className={kvClass}><span className="text-gray-400">stop_sequences</span><span className="font-mono">{config.stopSequences.join(", ")}</span></div>}
          {config.stopReason && <div className={kvClass}><span className="text-gray-400">stop_reason</span><span className={`font-mono ${config.stopReason === "max_tokens" ? "text-amber-600" : ""}`}>{config.stopReason}</span></div>}
        </div>
      </div>

      {/* System Prompt */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-2">System Prompt</div>
        <div className="space-y-1">
          {config.systemBlocks.map((block: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs bg-gray-50 rounded px-3 py-1.5">
              <span className="text-gray-400 shrink-0">#{i + 1}</span>
              <span className="text-gray-600">{((block.text?.length ?? 0) / 1024).toFixed(1)} KB</span>
              {block.cache_control && (
                <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs">cached</span>
              )}
              <span className="text-gray-400 truncate ml-auto">{(block.text ?? "").slice(0, 60)}</span>
            </div>
          ))}
          {config.systemBlocks.length === 0 && <div className="text-gray-400 italic text-xs">No system prompt</div>}
        </div>
      </div>

      {/* Response Tool Calls */}
      {config.toolCalls.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-500 mb-2">This Turn: Tool Calls</div>
          <div className="flex flex-wrap gap-1">
            {config.toolCalls.map((name, i) => (
              <span key={i} className="px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-mono">{name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Diagnostics({ reqLog, resLog, ctx }: { reqLog: any; resLog: any; ctx: RequestContext }) {
  const items = useMemo(() => runDiagnostics(reqLog, resLog, ctx), [reqLog, resLog, ctx]);

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded text-xs text-green-700">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        All checks passed
      </div>
    );
  }

  const levelStyles: Record<string, string> = {
    error: "bg-red-50 border-red-200 text-red-700",
    warning: "bg-amber-50 border-amber-200 text-amber-700",
    info: "bg-blue-50 border-blue-200 text-blue-700",
  };

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className={`px-3 py-2 rounded border text-xs ${levelStyles[item.level]}`}>
          <div className="font-medium">{item.title}</div>
          <div className="opacity-80 mt-0.5">{item.detail}</div>
        </div>
      ))}
    </div>
  );
}

// --- Section wiring (shared by adapters that want the standard panel) ---

export function getSharedRequestSections(reqLog: any, resLog: any, ctx: RequestContext): { id: string; label: string }[] {
  const sections: { id: string; label: string }[] = [];
  const messages = reqLog?.body?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const hasTools = messages.some((m: any) =>
      Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_use")
    );
    if (hasTools) sections.push({ id: "tool-summary", label: "Tool Summary" });
    sections.push({ id: "conv-flow", label: "Flow" });
  }
  sections.push({ id: "cost-insights", label: "Cost" });
  sections.push({ id: "config-overview", label: "Config" });
  const diagCount = runDiagnostics(reqLog, resLog, ctx).length;
  sections.push({ id: "diagnostics", label: diagCount > 0 ? `Diag (${diagCount})` : "Diag" });
  return sections;
}

export function getSharedResponseSections(): { id: string; label: string }[] {
  return [];
}

export function renderSharedSection(sectionId: string, reqLog: any, resLog: any, ctx: RequestContext): ReactNode | null {
  if (sectionId === "tool-summary") return <ToolSummary reqLog={reqLog} />;
  if (sectionId === "conv-flow") return <ConversationFlow reqLog={reqLog} />;
  if (sectionId === "cost-insights") return <CostInsights reqLog={reqLog} resLog={resLog} ctx={ctx} />;
  if (sectionId === "config-overview") return <ConfigOverview reqLog={reqLog} resLog={resLog} />;
  if (sectionId === "diagnostics") return <Diagnostics reqLog={reqLog} resLog={resLog} ctx={ctx} />;
  return null;
}
