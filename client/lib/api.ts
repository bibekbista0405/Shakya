const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TOKEN_KEY = "sakhya_token";
const TOKEN_VERSION_KEY = "sakhya_auth_version";
const AUTH_STORAGE_VERSION = "2";
const DEVICE_KEY_PREFIX = "sakhya_device_id:";
const ACTIVE_DEVICE_ACCOUNT_KEY = "sakhya_active_device_account";

function deviceStorageKey(account?: string): string {
  if (typeof window === "undefined") return DEVICE_KEY_PREFIX + "server";
  const scope = account || localStorage.getItem(ACTIVE_DEVICE_ACCOUNT_KEY) || "default";
  return DEVICE_KEY_PREFIX + encodeURIComponent(scope.trim().toLowerCase());
}

export function getDeviceId(account?: string): string {
  if (typeof window === "undefined") return "server-device";
  const key = deviceStorageKey(account);
  let id = localStorage.getItem(key);
  if (!id || !/^[A-Za-z0-9_-]{16,100}$/.test(id)) {
    id = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(key, id);
  }
  return id;
}

export function setDeviceId(id: string, account?: string): void {
  if (typeof window === "undefined") return;
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return;
  if (account) localStorage.setItem(ACTIVE_DEVICE_ACCOUNT_KEY, account.trim().toLowerCase());
  localStorage.setItem(deviceStorageKey(account), id);
}

export function getDeviceName(): string {
  if (typeof window === "undefined") return "Web browser";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Web browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Device";
  return `${browser} on ${os}`;
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  const version = localStorage.getItem(TOKEN_VERSION_KEY) || sessionStorage.getItem(TOKEN_VERSION_KEY);
  if (version !== AUTH_STORAGE_VERSION) {
    // Tokens created by older Sakhya builds may have incompatible session/JWT
    // state. Clear them before the first authenticated request instead of
    // generating a noisy /api/auth/me 401 during startup.
    clearToken();
    return null;
  }
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status);
  }

  return data as T;
}

export const api = {
  devices: {
    list: () => request<{ devices: Array<{ id: string; name: string; userAgent: string; createdAt: string; lastSeenAt: string; revokedAt: string | null }> }>("/devices", { method: "GET" }),
    revoke: (deviceId: string) => request<{ ok: boolean }>(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
    revokeOthers: () => request<{ ok: boolean }>("/devices/revoke-others", { method: "POST" }),
  },
  cryptoKeys: {
    me: () => request<{ key: { publicKey: string; signingPublicKey?: string | null; algorithm: string; version: number } | null; prekeys: unknown[] }>("/keys/me", { method: "GET" }),
    save: (publicKey: JsonWebKey, signingPublicKey?: JsonWebKey) =>
      request<{ key: { publicKey: string; signingPublicKey?: string | null; algorithm: string; version: number } }>("/keys/me", {
        method: "PUT",
        body: JSON.stringify({ publicKey: JSON.stringify(publicKey), signingPublicKey: signingPublicKey ? JSON.stringify(signingPublicKey) : undefined }),
      }),
    uploadBundle: (bundle: unknown) => request<{ ok: boolean; oneTimePrekeysAccepted: number }>("/keys/bundle", { method: "PUT", body: JSON.stringify(bundle) }),
    uploadDeviceBundle: (bundle: unknown) => request<{ ok: boolean; deviceId: string; oneTimePrekeysAccepted: number }>("/keys/device/bundle", { method: "PUT", body: JSON.stringify(bundle) }),
    devices: (userId: string) => request<{ devices: Array<any> }>(`/keys/devices/${encodeURIComponent(userId)}`, { method: "GET" }),
    consumeDevicePrekey: (deviceId: string, id: string) => request<{ prekey: { id: string; publicKey: string }; deviceId: string; userId: string }>(`/keys/device/${encodeURIComponent(deviceId)}/consume`, { method: "POST", body: JSON.stringify({ id }) }),
    getBundle: (userId: string) => request<{ bundle: { identityPublicKey: string; signingPublicKey: string; signedPrekey: { id: string; publicKey: string; signature: string }; oneTimePrekey: { id: string; publicKey: string } | null } }>(`/keys/bundle/${encodeURIComponent(userId)}`, { method: "GET" }),
    consumePrekey: (userId: string, id: string) => request<{ prekey: { id: string; publicKey: string } }>(`/keys/bundle/${encodeURIComponent(userId)}/consume`, { method: "POST", body: JSON.stringify({ id }) }),
    get: (userId: string) => request<{ key: { publicKey: string; signingPublicKey?: string | null; algorithm: string; version: number } }>(`/keys/${encodeURIComponent(userId)}`, { method: "GET" }),
  },

  media: {
    upload: async (mediaId: string, receiverId: string, blob: Blob) => {
      const token = getToken();
      const res = await fetch(`${API_URL}/media/${encodeURIComponent(mediaId)}`, { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/octet-stream", "X-Sakhya-Receiver": receiverId }, body: blob });
      let data: unknown = null; try { data = await res.json(); } catch {}
      if (!res.ok) throw new ApiError(data && typeof data === "object" && "error" in data ? String((data as {error:unknown}).error) : `Upload failed with status ${res.status}`, res.status);
      return data as { mediaId: string; bytes: number };
    },
    download: async (mediaId: string) => {
      const token = getToken();
      const res = await fetch(`${API_URL}/media/${encodeURIComponent(mediaId)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) { let message = `Media download failed with status ${res.status}`; try { const data = await res.json(); if (data?.error) message = String(data.error); } catch {} throw new ApiError(message, res.status); }
      return res.blob();
    },
  },

  messages: {
    claimViewOnce: (friendId: string, messageId: string) => request<{ ok: boolean }>(`/messages/${encodeURIComponent(friendId)}/view-once/${encodeURIComponent(messageId)}/claim`, { method: "POST" }),
  },

  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function setToken(token: string, remember = true): void {
  localStorage.setItem(TOKEN_VERSION_KEY, AUTH_STORAGE_VERSION);
  sessionStorage.setItem(TOKEN_VERSION_KEY, AUTH_STORAGE_VERSION);
  // "Remember me" -> survives browser restarts (localStorage).
  // Otherwise -> cleared when the tab/browser closes (sessionStorage).
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_VERSION_KEY);
  sessionStorage.removeItem(TOKEN_VERSION_KEY);
}

export function getStoredToken(): string | null {
  return getToken();
}

export function isTokenExpired(token: string | null): boolean {
  if (!token) return true;
  try {
    const part = token.split(".")[1];
    if (!part) return true;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now() + 5000;
  } catch {
    return true;
  }
}

