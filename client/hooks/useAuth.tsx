"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, setToken, clearToken, getStoredToken, getDeviceId, setDeviceId, getDeviceName, isTokenExpired } from "@/lib/api";
import { User } from "@/types";
import { getKeyBundleForUpload } from "@/lib/e2ee";

interface RegisterPayload {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  email: string;
  password: string;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const setupCryptoKey = useCallback(async () => {
    try {
      const bundle = await getKeyBundleForUpload();
      await api.cryptoKeys.uploadDeviceBundle(bundle);
      // Keep the legacy account bundle in sync for older clients.
    } catch (error) {
      console.warn("Sakhya secure messaging key setup failed", error);
    }
  }, []);

  useEffect(() => {
    const stored = getStoredToken();
    if (!stored || isTokenExpired(stored)) {
      clearToken();
      setTokenState(null);
      setLoading(false);
      return;
    }
    setTokenState(stored);
    api
      .get<{ user: User }>("/auth/me")
      .then(async (res) => {
        setUser(res.user);
        await setupCryptoKey();
      })
      .catch(() => {
        clearToken();
        setTokenState(null);
      })
      .finally(() => setLoading(false));
  }, [setupCryptoKey]);

  const login = useCallback(
    async (email: string, password: string, remember: boolean) => {
      const account = email.trim().toLowerCase();
      const res = await api.post<{ user: User; token: string; deviceId?: string }>("/auth/login", {
        email,
        password,
        deviceId: getDeviceId(account),
        deviceName: getDeviceName(),
      });
      setToken(res.token, remember);
      if (res.deviceId) setDeviceId(res.deviceId, account);
      setTokenState(res.token);
      setUser(res.user);
      await setupCryptoKey();
      router.push("/chats");
    },
    [router, setupCryptoKey]
  );

  const register = useCallback(
    async (payload: RegisterPayload) => {
      const account = payload.email.trim().toLowerCase();
      const res = await api.post<{ user: User; token: string; deviceId?: string }>("/auth/register", { ...payload, deviceId: getDeviceId(account), deviceName: getDeviceName() });
      setToken(res.token, true);
      if (res.deviceId) setDeviceId(res.deviceId, account);
      setTokenState(res.token);
      setUser(res.user);
      await setupCryptoKey();
      router.push("/chats");
    },
    [router, setupCryptoKey]
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore network errors on logout
    }
    clearToken();
    setTokenState(null);
    setUser(null);
    router.push("/login");
  }, [router]);

  const updateUser = useCallback((u: User) => setUser(u), []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
