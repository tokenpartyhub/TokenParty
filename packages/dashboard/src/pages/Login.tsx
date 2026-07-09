import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, setAuth, getSavedAccounts, removeAccount, type SavedAccount } from "../lib/api";

export default function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [switchingToken, setSwitchingToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const saved = getSavedAccounts();
    setAccounts(saved);
    if (saved.length === 1 && !searchParams.has("switch")) {
      loginWithToken(saved[0].token);
    }
  }, []);

  const loginWithToken = async (t: string) => {
    setError("");
    setSwitchingToken(t);
    setLoading(true);
    try {
      const result = await api.verifyToken(t);
      if (result.valid && result.role) {
        setAuth(t, result.role as "admin" | "user", result.name);
        navigate(result.role === "admin" ? "/admin" : "/");
      } else {
        setError("Token expired or invalid");
        removeAccount(t);
        setAccounts(getSavedAccounts());
      }
    } catch {
      setError("Verification failed");
    } finally {
      setLoading(false);
      setSwitchingToken(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await loginWithToken(token.trim());
  };

  const handleRemoveAccount = (t: string) => {
    removeAccount(t);
    setAccounts(getSavedAccounts());
  };

  const maskToken = (t: string) => {
    if (t.length <= 8) return t.slice(0, 3) + "***";
    return t.slice(0, 6) + "***" + t.slice(-3);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-2">TokenParty</h1>
        <p className="text-sm text-gray-500 text-center mb-6">Enter your admin token or API key</p>

        {accounts.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-gray-400 mb-2">Quick switch</p>
            <div className="space-y-2">
              {accounts.map((acc) => (
                <div key={acc.token} className="flex items-center gap-2">
                  <button
                    onClick={() => loginWithToken(acc.token)}
                    disabled={loading}
                    className="flex-1 flex items-center justify-between border rounded px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    <span className="font-medium">{acc.name}</span>
                    <span className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${acc.role === "admin" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                        {acc.role}
                      </span>
                      <span className="text-xs text-gray-400 font-mono">{maskToken(acc.token)}</span>
                      {switchingToken === acc.token && (
                        <svg className="animate-spin h-3 w-3 text-indigo-500" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      )}
                    </span>
                  </button>
                  <button
                    onClick={() => handleRemoveAccount(acc.token)}
                    className="text-gray-300 hover:text-red-500 transition-colors p-1"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t mt-4 pt-3">
              <p className="text-xs text-gray-400 mb-2">Or login with a new token</p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="admin-xxx / tp-xxx"
            className="w-full border rounded px-3 py-2 text-sm mb-4"
            autoFocus={accounts.length === 0}
          />
          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="w-full bg-indigo-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "Verifying..." : "Login"}
          </button>
        </form>
        <p className="text-xs text-gray-400 text-center mt-4">
          Run <code className="bg-gray-100 px-1 rounded">tokenparty token</code> to view your admin token
        </p>
      </div>
    </div>
  );
}
