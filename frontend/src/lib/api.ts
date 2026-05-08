import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? "";
const TOKEN_KEY = "consentalk.session_token";

async function readToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return typeof window !== "undefined"
        ? window.localStorage.getItem(TOKEN_KEY)
        : null;
    } catch {
      return null;
    }
  }
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function saveToken(token: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {}
    return;
  }
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  if (Platform.OS === "web") {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {}
    return;
  }
  await AsyncStorage.removeItem(TOKEN_KEY);
}

type Json = Record<string, unknown> | unknown[];

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Json;
  multipart?: FormData;
  signal?: AbortSignal;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = `${BACKEND_URL}/api${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {};
  const token = await readToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.multipart) {
    body = opts.multipart;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, {
    method: opts.method || (opts.body || opts.multipart ? "POST" : "GET"),
    headers,
    body,
    credentials: "include",
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail || JSON.stringify(j);
    } catch {}
    throw new Error(detail);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export function backendUrl(): string {
  return BACKEND_URL;
}

export function wsUrl(roomId: string, token: string): string {
  const u = BACKEND_URL.replace(/^http/, "ws");
  return `${u}/api/ws/room/${roomId}?token=${encodeURIComponent(token)}`;
}

export async function getStoredToken(): Promise<string | null> {
  return readToken();
}
