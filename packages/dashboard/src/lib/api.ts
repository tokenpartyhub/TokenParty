const BASE = "/api";
const TOKEN_KEY = "tokenparty_admin_token";

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { headers, ...options });
  if (res.status === 401) {
    clearAdminToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getProviders: () => request<any[]>("/providers"),
  createProvider: (data: any) => request("/providers", { method: "POST", body: JSON.stringify(data) }),
  updateProvider: (id: string, data: any) => request(`/providers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProvider: (id: string) => request(`/providers/${id}`, { method: "DELETE" }),

  getKeys: () => request<any[]>("/keys"),
  createKey: (data: any) => request("/keys", { method: "POST", body: JSON.stringify(data) }),
  updateKey: (key: string, data: any) => request(`/keys/${key}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteKey: (key: string) => request(`/keys/${key}`, { method: "DELETE" }),

  getStats: (days?: number, tokenId?: string) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    if (tokenId) params.set("token_id", tokenId);
    return request<any[]>(`/stats?${params}`);
  },

  getRequests: (params?: { limit?: number; offset?: number; token_id?: string; provider_id?: string; model?: string; status?: string; tags?: string }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.offset) search.set("offset", String(params.offset));
    if (params?.token_id) search.set("token_id", params.token_id);
    if (params?.provider_id) search.set("provider_id", params.provider_id);
    if (params?.model) search.set("model", params.model);
    if (params?.status) search.set("status", params.status);
    if (params?.tags) search.set("tags", params.tags);
    return request<{ data: any[]; total: number }>(`/requests?${search}`);
  },

  getModels: () => request<{ id: string; providers: string[] }[]>("/models"),

  getRequestDetail: (id: string) => request<any>(`/requests/${id}`),

  getVersion: () => request<{ version: string }>("/version").then((r) => r.version),
  checkUpdate: () => request<{ current: string; latest: string | null; hasUpdate: boolean }>("/version/check"),

  getLogStorage: () => request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number }>("/settings/log-storage"),
  updateLogStorage: (maxSizeMB: number) =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; cleaned: { deletedDays: string[]; freedMB: number } }>(
      "/settings/log-storage", { method: "PUT", body: JSON.stringify({ maxSizeMB }) }
    ),
  triggerLogCleanup: () =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; cleaned: { deletedDays: string[]; freedMB: number } }>(
      "/settings/log-cleanup", { method: "POST" }
    ),
  clearAllLogs: () =>
    request<{ totalSizeMB: number; maxSizeMB: number; dayCount: number; cleared: { freedMB: number } }>(
      "/settings/log-storage", { method: "DELETE" }
    ),

  verifyToken: (token: string) =>
    fetch(`${BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((r) => r.json() as Promise<{ valid: boolean }>),
};
