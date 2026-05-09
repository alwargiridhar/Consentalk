import { Alert, Platform } from "react-native";

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Cross-platform confirmation. On web, falls back to `window.confirm`
 * because React-Native's Alert.alert ignores the buttons array on web.
 */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  if (Platform.OS === "web") {
    if (typeof window === "undefined" || !window.confirm) {
      return Promise.resolve(true);
    }
    return Promise.resolve(window.confirm(`${opts.title}\n\n${opts.message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(opts.title, opts.message, [
      {
        text: opts.cancelLabel || "Cancel",
        style: "cancel",
        onPress: () => resolve(false),
      },
      {
        text: opts.confirmLabel || "Confirm",
        style: opts.destructive ? "destructive" : "default",
        onPress: () => resolve(true),
      },
    ]);
  });
}

export function notifyDialog(title: string, message?: string): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.alert) {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}

export function getInitials(name: string | undefined | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic gradient pair from a string for soft identity circles.
const PALETTES: [string, string][] = [
  ["#7DD3FC", "#0EA5E9"],
  ["#A7F3D0", "#10B981"],
  ["#FDE68A", "#F59E0B"],
  ["#FCA5A5", "#F87171"],
  ["#C4B5FD", "#7C3AED"],
  ["#F9A8D4", "#EC4899"],
  ["#86EFAC", "#22C55E"],
  ["#FDBA74", "#EA580C"],
];

export function gradientFor(seed: string | undefined | null): [string, string] {
  const s = (seed || "?").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}
