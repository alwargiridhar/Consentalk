import React, { createContext, useCallback, useContext, useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Radii } from "../lib/theme";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmCtx {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  notify: (title: string, message?: string) => Promise<void>;
}

const Ctx = createContext<ConfirmCtx | null>(null);

interface QueueItem extends ConfirmOptions {
  id: number;
  resolve: (v: boolean) => void;
  notifyOnly?: boolean;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const id = Date.now() + Math.random();
      setQueue((q) => [...q, { ...opts, id, resolve }]);
    });
  }, []);

  const notify = useCallback((title: string, message?: string) => {
    return new Promise<void>((resolve) => {
      const id = Date.now() + Math.random();
      setQueue((q) => [
        ...q,
        {
          id,
          title,
          message: message || "",
          confirmLabel: "OK",
          notifyOnly: true,
          resolve: () => resolve(),
        },
      ]);
    });
  }, []);

  const top = queue[0];

  const resolveTop = (val: boolean) => {
    if (!top) return;
    top.resolve(val);
    setQueue((q) => q.filter((it) => it.id !== top.id));
  };

  return (
    <Ctx.Provider value={{ confirm, notify }}>
      {children}
      <Modal
        visible={!!top}
        animationType="fade"
        transparent
        onRequestClose={() => resolveTop(false)}
      >
        <View style={styles.root}>
          <View style={styles.card}>
            <View
              style={[
                styles.iconHero,
                {
                  backgroundColor: top?.destructive
                    ? Colors.dangerBg
                    : Colors.brandFog,
                },
              ]}
            >
              <Ionicons
                name={top?.destructive ? "alert-circle-outline" : "information-circle-outline"}
                size={28}
                color={top?.destructive ? Colors.danger : Colors.brandPrimary}
              />
            </View>
            <Text style={styles.title} testID="confirm-title">
              {top?.title || ""}
            </Text>
            {top?.message ? (
              <Text style={styles.message} testID="confirm-message">
                {top.message}
              </Text>
            ) : null}
            <View style={styles.actions}>
              {!top?.notifyOnly ? (
                <Pressable
                  testID="confirm-cancel"
                  onPress={() => resolveTop(false)}
                  style={[styles.btn, styles.cancel]}
                >
                  <Text style={styles.cancelText}>
                    {top?.cancelLabel || "Cancel"}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                testID="confirm-ok"
                onPress={() => resolveTop(true)}
                style={[
                  styles.btn,
                  top?.destructive ? styles.destructive : styles.primary,
                  top?.notifyOnly && { flex: 1 },
                ]}
              >
                <Text
                  style={[
                    styles.primaryText,
                    top?.destructive && { color: "#FFFFFF" },
                  ]}
                >
                  {top?.confirmLabel || "Confirm"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmCtx {
  const c = useContext(Ctx);
  if (!c) {
    // Fallback so non-provider callers don't crash; resolves false / no-op.
    return {
      confirm: async () => false,
      notify: async () => {},
    };
  }
  return c;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: Colors.paper,
    borderRadius: 24,
    padding: 26,
    alignItems: "center",
  },
  iconHero: {
    width: 56,
    height: 56,
    borderRadius: 56,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.textPrimary,
    textAlign: "center",
  },
  message: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginTop: 8,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 22,
    width: "100%",
  },
  btn: {
    flex: 1,
    height: 48,
    borderRadius: Radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  cancel: { backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.divider },
  cancelText: { color: Colors.textSecondary, fontWeight: "600" },
  primary: { backgroundColor: Colors.brandPrimary },
  primaryText: { color: "#FFFFFF", fontWeight: "700" },
  destructive: { backgroundColor: Colors.danger },
});
