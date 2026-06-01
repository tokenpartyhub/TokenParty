import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAdminToken } from "../lib/api";

export default function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { valid } = await api.verifyToken(token.trim());
      if (valid) {
        setAdminToken(token.trim());
        navigate("/");
      } else {
        setError("Invalid token");
      }
    } catch {
      setError("Verification failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center mb-2">TokenParty</h1>
        <p className="text-sm text-gray-500 text-center mb-6">Enter admin token to continue</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="admin-xxxxxxxxxxxx"
            className="w-full border rounded px-3 py-2 text-sm mb-4"
            autoFocus
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
          Run <code className="bg-gray-100 px-1 rounded">tokenparty --token</code> to view your token
        </p>
      </div>
    </div>
  );
}
