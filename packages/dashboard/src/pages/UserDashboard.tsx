import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "../lib/api";
import { formatCost } from "./Settings";

interface Profile {
  name: string;
  monthlyBudget: number | null;
  monthlySpent: number;
  monthlyRequests: number;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyCacheReadTokens: number;
  dailySpent: number;
  dailyRequests: number;
}

export default function UserDashboard() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<any[]>([]);
  const [days, setDays] = useState(7);

  useEffect(() => {
    api.getUserProfile().then(setProfile).catch(console.error);
  }, []);

  useEffect(() => {
    api.getUserStats(days).then(setStats).catch(console.error);
  }, [days]);

  const dailyData = stats.reduce((acc: any[], row) => {
    const existing = acc.find((d) => d.date === row.date);
    if (existing) {
      existing.cost += row.cost ?? 0;
      existing.request_count += row.request_count;
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
    } else {
      acc.push({ date: row.date, cost: row.cost ?? 0, request_count: row.request_count, input_tokens: row.input_tokens, output_tokens: row.output_tokens });
    }
    return acc;
  }, []).sort((a, b) => a.date.localeCompare(b.date));

  const byModel = (() => {
    const map = new Map<string, { requests: number; input: number; output: number; cost: number }>();
    for (const row of stats) {
      const existing = map.get(row.model) ?? { requests: 0, input: 0, output: 0, cost: 0 };
      existing.requests += row.request_count;
      existing.input += row.input_tokens;
      existing.output += row.output_tokens;
      existing.cost += row.cost ?? 0;
      map.set(row.model, existing);
    }
    return Array.from(map.entries())
      .map(([model, val]) => ({ model, ...val }))
      .sort((a, b) => b.cost - a.cost);
  })();

  const cacheHitRate = profile
    ? (profile.monthlyInputTokens + profile.monthlyCacheReadTokens) > 0
      ? ((profile.monthlyCacheReadTokens / (profile.monthlyInputTokens + profile.monthlyCacheReadTokens)) * 100).toFixed(1)
      : "0.0"
    : "0.0";

  const budgetPct = profile?.monthlyBudget
    ? Math.min(100, (profile.monthlySpent / profile.monthlyBudget) * 100)
    : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          {profile ? `Welcome, ${profile.name}` : "Dashboard"}
        </h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="border rounded px-3 py-1 text-sm">
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {profile && (
        <>
          <div className="grid grid-cols-4 gap-4 mb-4">
            <StatCard label="Today's Spend" value={formatCost(profile.dailySpent)} />
            <StatCard label="This Month" value={formatCost(profile.monthlySpent)} />
            <StatCard
              label="Budget Remaining"
              value={profile.monthlyBudget
                ? formatCost(Math.max(0, profile.monthlyBudget - profile.monthlySpent))
                : "No Limit"
              }
            />
            <StatCard label="Cache Hit Rate" value={`${cacheHitRate}%`} />
          </div>

          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard label="Input Tokens" value={profile.monthlyInputTokens.toLocaleString()} />
            <StatCard label="Output Tokens" value={profile.monthlyOutputTokens.toLocaleString()} />
            <StatCard label="Cache Read" value={profile.monthlyCacheReadTokens.toLocaleString()} />
            <StatCard label="Requests" value={profile.monthlyRequests.toLocaleString()} />
          </div>

          {budgetPct !== null && (
            <div className="bg-white rounded-lg shadow p-4 mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Monthly Budget</span>
                <span className="text-sm text-gray-500">
                  {formatCost(profile.monthlySpent)} / {formatCost(profile.monthlyBudget!)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all ${budgetPct > 90 ? "bg-red-500" : budgetPct > 70 ? "bg-yellow-500" : "bg-green-500"}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
              <div className="text-xs text-gray-400 mt-1">{budgetPct.toFixed(1)}% used</div>
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold text-sm text-gray-700 mb-2">Daily Cost</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${v.toFixed(2)}`} width={50} />
                <Tooltip formatter={(v: number) => formatCost(v)} labelFormatter={(l) => l} />
                <Bar dataKey="cost" name="Cost" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold text-sm text-gray-700 mb-2">Daily Requests</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip labelFormatter={(l) => l} />
                <Bar dataKey="request_count" name="Requests" fill="#6366f1" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <h3 className="font-semibold text-sm text-gray-700 px-4 py-3 border-b">Cost by Model</h3>
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs text-gray-500">Model</th>
              <th className="px-4 py-2 text-right text-xs text-gray-500">Requests</th>
              <th className="px-4 py-2 text-right text-xs text-gray-500">Input Tokens</th>
              <th className="px-4 py-2 text-right text-xs text-gray-500">Output Tokens</th>
              <th className="px-4 py-2 text-right text-xs text-gray-500">Cost</th>
            </tr>
          </thead>
          <tbody>
            {byModel.map((row) => (
              <tr key={row.model} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{row.model}</td>
                <td className="px-4 py-2 text-right text-xs">{row.requests.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-xs">{row.input.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-xs">{row.output.toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-xs">{formatCost(row.cost)}</td>
              </tr>
            ))}
            {byModel.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-xs">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
