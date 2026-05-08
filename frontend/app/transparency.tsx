import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import { Colors, Radii } from "../src/lib/theme";
import { api } from "../src/lib/api";

interface Summary {
  active_sessions: number;
  active_rooms: number;
  forensic_window_days: number;
  forensic_fragments_global_active: number;
  plaintext_chats_stored: number;
}

interface Session {
  created_at: string;
  expires_at: string;
  device_info?: { user_agent?: string; ip?: string };
}

export default function Transparency() {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const s = await api<Summary>("/transparency/summary");
        setSummary(s);
        const ss = await api<{ sessions: Session[] }>("/transparency/sessions");
        setSessions(ss.sessions || []);
      } catch {}
    })();
  }, []);

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <Text style={styles.title}>Transparency</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.statsGrid}>
            <Stat
              icon="phone-portrait-outline"
              num={summary?.active_sessions ?? 0}
              label="Active sessions"
              tint={Colors.brandPrimary}
            />
            <Stat
              icon="cube-outline"
              num={summary?.active_rooms ?? 0}
              label="Your rooms"
              tint={Colors.success}
            />
            <Stat
              icon="document-text-outline"
              num={summary?.plaintext_chats_stored ?? 0}
              label="Plaintext chats"
              tint={Colors.success}
            />
            <Stat
              icon="time-outline"
              num={summary?.forensic_window_days ?? 90}
              label="Forensic days"
              tint={Colors.brandPrimary}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>How retention works</Text>
            <Text style={styles.cardText}>
              Conversations are wiped when a room ends. Encrypted forensic
              fragments may persist for {summary?.forensic_window_days ?? 90}
              {" "}days for lawful safety review only — they are inaccessible
              under normal operations.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your sessions</Text>
            {sessions.length === 0 ? (
              <Text style={styles.cardText}>No session history.</Text>
            ) : (
              sessions.map((s, i) => (
                <View
                  key={i}
                  style={[styles.row, i < sessions.length - 1 && styles.rowDivider]}
                >
                  <Ionicons
                    name="phone-portrait-outline"
                    size={18}
                    color={Colors.brandPrimary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowText} numberOfLines={1}>
                      {s.device_info?.user_agent?.slice(0, 60) || "Unknown device"}
                    </Text>
                    <Text style={styles.rowSub}>
                      {new Date(s.created_at).toLocaleString()}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

function Stat({
  icon,
  num,
  label,
  tint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  num: number;
  label: string;
  tint: string;
}) {
  return (
    <View style={styles.stat}>
      <View style={[styles.statIcon, { backgroundColor: `${tint}20` }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <Text style={styles.statNum}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.paper,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  title: { fontSize: 17, fontWeight: "700", color: Colors.textPrimary },
  scroll: { padding: 24, paddingBottom: 80 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  stat: {
    flexBasis: "48%",
    backgroundColor: Colors.paper,
    padding: 18,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  statIcon: {
    width: 40,
    height: 40,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  statNum: {
    fontSize: 28,
    fontWeight: "700",
    color: Colors.textPrimary,
    marginTop: 12,
  },
  statLabel: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  card: {
    marginTop: 16,
    padding: 18,
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textPrimary,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  cardText: { color: Colors.textSecondary, fontSize: 14, lineHeight: 21 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: Colors.divider2 },
  rowText: { color: Colors.textPrimary, fontSize: 13 },
  rowSub: { color: Colors.textTertiary, fontSize: 11, marginTop: 2 },
});
