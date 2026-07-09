import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface SettingsData {
  displayCurrency: "USD" | "CNY";
  exchangeRate: number;
  reverseMessages: boolean;
}

const STORAGE_KEY = "tokenparty_settings";
const DEFAULT_RATE = 7.2;

function loadSettings(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { displayCurrency: "USD", exchangeRate: DEFAULT_RATE, reverseMessages: false };
}

function saveSettings(data: SettingsData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getSettings(): SettingsData {
  return loadSettings();
}

export function formatCost(usdCost: number): string {
  const s = loadSettings();
  if (s.displayCurrency === "CNY") {
    return `¥${(usdCost * s.exchangeRate).toFixed(4)}`;
  }
  return `$${usdCost.toFixed(4)}`;
}

type RetentionPeriod = "1week" | "1month" | "2month";

interface LogStorageInfo {
  totalSizeMB: number;
  maxSizeMB: number;
  dayCount: number;
  retentionPeriod: RetentionPeriod;
}

const RETENTION_LABELS: Record<RetentionPeriod, string> = {
  "1week": "1 周",
  "1month": "1 个月",
  "2month": "2 个月",
};

export default function Settings({ mode = "admin" }: { mode?: "admin" | "user" }) {
  const [settings, setSettings] = useState<SettingsData>(loadSettings);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState("");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [checking, setChecking] = useState(false);
  const [logStorage, setLogStorage] = useState<LogStorageInfo | null>(null);
  const [maxSizeInput, setMaxSizeInput] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (mode === "admin") {
      api.getVersion().then((v) => setVersion(v)).catch(console.error);
      api.getLogStorage().then((s) => {
        setLogStorage(s);
        setMaxSizeInput(String(s.maxSizeMB));
      }).catch(console.error);
    }
  }, [mode]);

  const update = (patch: Partial<SettingsData>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="bg-white rounded-lg shadow p-6 max-w-lg space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Display Currency</label>
          <p className="text-xs text-gray-500 mb-2">All costs are stored in USD internally. Switching to CNY converts using the exchange rate below.</p>
          <select
            value={settings.displayCurrency}
            onChange={(e) => update({ displayCurrency: e.target.value as "USD" | "CNY" })}
            className="w-48 border rounded px-3 py-2 text-sm"
          >
            <option value="USD">$ USD</option>
            <option value="CNY">¥ CNY</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Exchange Rate (1 USD = ? CNY)</label>
          <p className="text-xs text-gray-500 mb-2">Used when displaying costs in CNY. Default: {DEFAULT_RATE}</p>
          <input
            type="number"
            step="0.01"
            value={settings.exchangeRate}
            onChange={(e) => update({ exchangeRate: Number(e.target.value) || DEFAULT_RATE })}
            className="w-48 border rounded px-3 py-2 text-sm"
          />
        </div>

        {saved && (
          <div className="text-sm text-green-600">Settings saved</div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-6 max-w-lg space-y-4 mt-6">
        <h3 className="text-lg font-semibold">Request Detail</h3>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.reverseMessages ?? false}
            onChange={(e) => update({ reverseMessages: e.target.checked })}
            className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <div>
            <div className="text-sm font-medium text-gray-700">Messages Reverse Order</div>
            <div className="text-xs text-gray-500">Show newest messages first in request detail</div>
          </div>
        </label>
      </div>

      {mode === "admin" && <div className="bg-white rounded-lg shadow p-6 max-w-lg space-y-6 mt-6">
        <h3 className="text-lg font-semibold">Log Storage</h3>

        {logStorage && (
          <div className="text-sm text-gray-600 space-y-1">
            <p>Current usage: <span className="font-medium text-gray-900">{logStorage.totalSizeMB} MB</span> / {logStorage.maxSizeMB} MB</p>
            <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
              <div
                className={`h-2 rounded-full ${logStorage.totalSizeMB / logStorage.maxSizeMB > 0.9 ? "bg-red-500" : logStorage.totalSizeMB / logStorage.maxSizeMB > 0.7 ? "bg-yellow-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, (logStorage.totalSizeMB / logStorage.maxSizeMB) * 100)}%` }}
              />
            </div>
            <p className="mt-1">Days stored: <span className="font-medium text-gray-900">{logStorage.dayCount}</span></p>
            <p className="mt-1">
              Current retention:{" "}
              <span className="font-medium text-gray-900">{RETENTION_LABELS[logStorage.retentionPeriod]}</span>
              <span className="text-gray-400"> · Overview 汇总数据不受影响</span>
            </p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">请求日志留存时长</label>
          <p className="text-xs text-gray-500 mb-2">每天自动清理过期请求详情；Overview 用量汇总会单独保留，不受清理影响。</p>
          <div className="flex gap-2">
            {(["1week", "1month", "2month"] as RetentionPeriod[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  api.updateLogStorage({ retentionPeriod: p }).then((res) => {
                    setLogStorage({
                      totalSizeMB: res.totalSizeMB,
                      maxSizeMB: res.maxSizeMB,
                      dayCount: res.dayCount,
                      retentionPeriod: res.retentionPeriod,
                    });
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1500);
                    if (res.cleaned.deletedDays.length > 0) {
                      alert(`已清理 ${res.cleaned.deletedDays.length} 天过期日志，释放 ${res.cleaned.freedMB} MB`);
                    }
                  }).catch(console.error);
                }}
                className={`px-4 py-2 rounded text-sm border ${logStorage?.retentionPeriod === p ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
              >
                {RETENTION_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <details>
          <summary className="text-sm text-gray-700 cursor-pointer">容量上限（高级）</summary>
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Storage Size (MB)</label>
            <p className="text-xs text-gray-500 mb-2">当总占用超过此上限时，按日期从旧到新逐天删除，直至低于上限（今天始终保留）。最小 50 MB。</p>
            <div className="flex gap-2">
              <input
                type="number"
                min={50}
                step={50}
                value={maxSizeInput}
                onChange={(e) => setMaxSizeInput(e.target.value)}
                className="w-32 border rounded px-3 py-2 text-sm"
              />
              <button
                onClick={() => {
                  const val = Number(maxSizeInput);
                  if (val < 50) return;
                  api.updateLogStorage({ retentionMaxSizeMB: val }).then((res) => {
                    setLogStorage({
                      totalSizeMB: res.totalSizeMB,
                      maxSizeMB: res.maxSizeMB,
                      dayCount: res.dayCount,
                      retentionPeriod: res.retentionPeriod,
                    });
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1500);
                    if (res.cleaned.deletedDays.length > 0) {
                      alert(`已清理 ${res.cleaned.deletedDays.length} 天过期日志，释放 ${res.cleaned.freedMB} MB`);
                    }
                  }).catch(console.error);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        </details>

        <div className="flex flex-wrap gap-2">
          <button
            disabled={cleaning}
            onClick={() => {
              setCleaning(true);
              api.triggerLogCleanup().then((res) => {
                setLogStorage({
                  totalSizeMB: res.totalSizeMB,
                  maxSizeMB: res.maxSizeMB,
                  dayCount: res.dayCount,
                  retentionPeriod: res.retentionPeriod,
                });
                if (res.cleaned.deletedDays.length === 0) {
                  alert("当前没有需要清理的过期日志。");
                } else {
                  alert(`已清理 ${res.cleaned.deletedDays.length} 天，释放 ${res.cleaned.freedMB} MB`);
                }
              }).catch(console.error).finally(() => setCleaning(false));
            }}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 border border-gray-300"
          >
            {cleaning ? "清理中..." : "立即清理过期日志"}
          </button>
          <button
            disabled={cleaning}
            onClick={() => {
              if (!confirm("这将永久删除全部请求日志和用量汇总数据。继续？")) return;
              setCleaning(true);
              api.clearAllLogs().then((res) => {
                setLogStorage({
                  totalSizeMB: res.totalSizeMB,
                  maxSizeMB: res.maxSizeMB,
                  dayCount: res.dayCount,
                  retentionPeriod: res.retentionPeriod,
                });
                alert(`已清空全部日志，释放 ${res.cleared.freedMB} MB`);
              }).catch(console.error).finally(() => setCleaning(false));
            }}
            className="px-4 py-2 bg-red-50 text-red-600 rounded text-sm hover:bg-red-100 border border-red-200"
          >
            {cleaning ? "清空中..." : "清空全部日志"}
          </button>
        </div>
      </div>}

      {mode === "admin" && version && (
        <div className="bg-white rounded-lg shadow p-6 max-w-lg mt-6">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-gray-600">TokenParty <span className="font-medium text-gray-900">v{version}</span></span>
              {hasUpdate && latestVersion && (
                <span className="ml-2 px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">v{latestVersion} available</span>
              )}
              {checking && <span className="ml-2 text-xs text-gray-400">Checking...</span>}
              {!hasUpdate && latestVersion && !checking && (
                <span className="ml-2 text-xs text-green-600">Up to date</span>
              )}
            </div>
            <button
              disabled={checking}
              onClick={() => {
                setChecking(true);
                api.checkUpdate().then((res) => {
                  setLatestVersion(res.latest);
                  setHasUpdate(res.hasUpdate);
                }).catch(console.error).finally(() => setChecking(false));
              }}
              className="px-3 py-1.5 text-xs border rounded hover:bg-gray-50"
            >
              Check for Updates
            </button>
          </div>
          {hasUpdate && latestVersion && (
            <div className="mt-3 p-3 bg-blue-50 rounded text-xs text-gray-700 space-y-1">
              <p className="font-medium">Update to v{latestVersion}:</p>
              <code className="block bg-white px-2 py-1 rounded border text-xs font-mono">npm update -g @tokenparty/tokenparty</code>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              disabled={restarting}
              onClick={() => {
                setRestarting(true);
                api.restart().then(() => {
                  setTimeout(() => window.location.reload(), 3000);
                }).catch(() => setRestarting(false));
              }}
              className="px-3 py-1.5 text-xs border rounded hover:bg-gray-50 text-orange-600 border-orange-200 hover:bg-orange-50"
            >
              {restarting ? "Restarting..." : "Restart Service"}
            </button>
            {restarting && <span className="text-xs text-gray-400">Page will reload in a few seconds...</span>}
          </div>
        </div>
      )}
    </div>
  );
}
