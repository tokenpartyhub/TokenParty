const BASE = "/api";
const TOKEN_KEY = "tokenparty_token";
const ROLE_KEY = "tokenparty_role";
const NAME_KEY = "tokenparty_user_name";
const ACCOUNTS_KEY = "tokenparty_accounts";

export interface SavedAccount {
  token: string;
  role: "admin" | "user";
  name: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem("tokenparty_admin_token");
}

export function getRole(): "admin" | "user" | null {
  return localStorage.getItem(ROLE_KEY) as "admin" | "user" | null;
}

export function getUserName(): string | null {
  return localStorage.getItem(NAME_KEY);
}

export function getSavedAccounts(): SavedAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveAccount(token: string, role: "admin" | "user", name: string) {
  const accounts = getSavedAccounts().filter((a) => a.token !== token);
  accounts.unshift({ token, role, name });
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function removeAccount(token: string) {
  const accounts = getSavedAccounts().filter((a) => a.token !== token);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function setAuth(token: string, role: "admin" | "user", name?: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  if (name) localStorage.setItem(NAME_KEY, name);
  localStorage.removeItem("tokenparty_admin_token");
  saveAccount(token, role, name || (role === "admin" ? "Admin" : "User"));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem("tokenparty_admin_token");
}

export const getAdminToken = getToken;
export const setAdminToken = (t: string) => setAuth(t, "admin");
export const clearAdminToken = clearAuth;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { headers, ...options });
  if (res.status === 401) {
    clearAuth();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let detail = `API error: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.detail ? `${body.error}: ${body.detail}` : body.error;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  // --- Admin APIs ---
  getProviders: () => request<any[]>("/providers"),
  createProvider: (data: any) => request("/providers", { method: "POST", body: JSON.stringify(data) }),
  updateProvider: (id: string, data: any) => request(`/providers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProvider: (id: string) => request(`/providers/${id}`, { method: "DELETE" }),
  detectModels: (id: string) => request<{ models: string[] }>(`/providers/${id}/detect-models`, { method: "POST" }),

  getKeys: () => request<any[]>("/keys"),
  getKeysUsageSummary: () => request<any[]>("/keys/usage-summary"),
  createKey: (data: any) => request("/keys", { method: "POST", body: JSON.stringify(data) }),
  updateKey: (key: string, data: any) => request(`/keys/${key}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteKey: (key: string) => request(`/keys/${key}`, { method: "DELETE" }),

  getStats: (days?: number, tokenId?: string) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    if (tokenId) params.set("token_id", tokenId);
    return request<any[]>(`/stats?${params}`);
  },

  getRequests: (params?: { limit?: number; offset?: number; token_id?: string; provider_id?: string; model?: string; status?: string; tags?: string; agent?: string; date_from?: string; date_to?: string }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    if (params?.token_id) search.set("token_id", params.token_id);
    if (params?.provider_id) search.set("provider_id", params.provider_id);
    if (params?.model) search.set("model", params.model);
    if (params?.status) search.set("status", params.status);
    if (params?.tags) search.set("tags", params.tags);
    if (params?.agent) search.set("agent", params.agent);
    if (params?.date_from) search.set("date_from", params.date_from);
    if (params?.date_to) search.set("date_to", params.date_to);
    return request<{ data: any[]; total: number }>(`/requests?${search}`);
  },

  getModels: () => request<{ id: string; providers: string[] }[]>("/models"),

  getRequestDetail: (id: string) => request<any>(`/requests/${id}`),

  getVersion: () => request<{ version: string }>("/version").then((r) => r.version),
  checkUpdate: () => request<{ current: string; latest: string | null; hasUpdate: boolean }>("/version/check"),

  getLogStorage: () => request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; retentionPeriod: "1week" | "1month" | "2month" }>("/settings/log-storage"),
  updateLogStorage: (data: { retentionPeriod?: "1week" | "1month" | "2month"; retentionMaxSizeMB?: number }) =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; retentionPeriod: "1week" | "1month" | "2month"; cleaned: { deletedDays: string[]; freedMB: number } }>(
      "/settings/log-storage", { method: "PUT", body: JSON.stringify(data) }
    ),
  triggerLogCleanup: () =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; retentionPeriod: "1week" | "1month" | "2month"; cleaned: { deletedDays: string[]; freedMB: number } }>(
      "/settings/log-cleanup", { method: "POST" }
    ),
  clearAllLogs: () =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; retentionPeriod: "1week" | "1month" | "2month"; cleared: { freedMB: number } }>(
      "/settings/log-storage", { method: "DELETE" }
    ),

  restart: () => request<{ status: string }>("/restart", { method: "POST" }),

  // --- User APIs ---
  getUserProfile: () => request<any>("/user/profile"),
  getUserStats: (days?: number) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    return request<any[]>(`/user/stats?${params}`);
  },
  getUserRequests: (params?: { limit?: number; offset?: number; provider_id?: string; model?: string; status?: string; tags?: string; agent?: string; date_from?: string; date_to?: string }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    if (params?.provider_id) search.set("provider_id", params.provider_id);
    if (params?.model) search.set("model", params.model);
    if (params?.status) search.set("status", params.status);
    if (params?.tags) search.set("tags", params.tags);
    if (params?.agent) search.set("agent", params.agent);
    if (params?.date_from) search.set("date_from", params.date_from);
    if (params?.date_to) search.set("date_to", params.date_to);
    return request<{ data: any[]; total: number }>(`/user/requests?${search}`);
  },
  getUserRequestDetail: (id: string) => request<any>(`/user/requests/${id}`),
  getUserModels: () => request<{ id: string; protocols: string[] }[]>("/user/models"),

  // --- Auth ---
  verifyToken: (token: string) =>
    fetch(`${BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((r) => r.json() as Promise<{ valid: boolean; role?: string; name?: string }>),
};
