import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface SettingsData {
  displayCurrency: "USD" | "CNY";
  exchangeRate: number;
}

const STORAGE_KEY = "tokenparty_settings";
const DEFAULT_RATE = 7.2;

function loadSettings(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { displayCurrency: "USD", exchangeRate: DEFAULT_RATE };
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

interface LogStorageInfo {
  totalSizeMB: number;
  maxSizeMB: number;
  dayCount: number;
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData>(loadSettings);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState("");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [checking, setChecking] = useState(false);
  const [logStorage, setLogStorage] = useState<LogStorageInfo | null>(null);
  const [maxSizeInput, setMaxSizeInput] = useState("");
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    api.getVersion().then((v) => setVersion(v)).catch(console.error);
    api.getLogStorage().then((s) => {
      setLogStorage(s);
      setMaxSizeInput(String(s.maxSizeMB));
    }).catch(console.error);
  }, []);

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

      <div className="bg-white rounded-lg shadow p-6 max-w-lg space-y-6 mt-6">
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
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Max Storage Size (MB)</label>
          <p className="text-xs text-gray-500 mb-2">When exceeded, oldest day's logs are deleted automatically. Minimum: 50 MB.</p>
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
                api.updateLogStorage(val).then((res) => {
                  setLogStorage({ totalSizeMB: res.totalSizeMB, maxSizeMB: res.maxSizeMB, dayCount: res.dayCount });
                  setSaved(true);
                  setTimeout(() => setSaved(false), 1500);
                  if (res.cleaned.deletedDays.length > 0) {
                    alert(`Cleaned up ${res.cleaned.deletedDays.length} day(s), freed ${res.cleaned.freedMB} MB`);
                  }
                }).catch(console.error);
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>

        <div>
          <button
            disabled={cleaning}
            onClick={() => {
              if (!confirm("This will permanently delete ALL request logs and usage statistics. Continue?")) return;
              setCleaning(true);
              api.clearAllLogs().then((res) => {
                setLogStorage({ totalSizeMB: res.totalSizeMB, maxSizeMB: res.maxSizeMB, dayCount: res.dayCount });
                alert(`All logs cleared, freed ${res.cleared.freedMB} MB`);
              }).catch(console.error).finally(() => setCleaning(false));
            }}
            className="px-4 py-2 bg-red-50 text-red-600 rounded text-sm hover:bg-red-100 border border-red-200"
          >
            {cleaning ? "Clearing..." : "Clear All Logs"}
          </button>
        </div>
      </div>

      {version && (
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
              <code className="block bg-white px-2 py-1 rounded border text-xs font-mono">npm update -g @zhouzhengchang/token-party</code>
              <p className="text-gray-500">Restart the service after updating.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
