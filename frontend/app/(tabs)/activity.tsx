import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Pressable,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import { Colors, Radii } from "../../src/lib/theme";
import { api } from "../../src/lib/api";

interface Invitation {
  invitation_id: string;
  room_id: string;
  room_name: string;
  room_type: string;
  inviter_name: string;
  invited_email: string;
  status: string;
  created_at: string;
}

export default function ActivityScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Invitation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await api<{ invitations: Invitation[] }>("/rooms/invitations");
      setItems(r.invitations || []);
    } catch (e) {
      // silent
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
    }, [fetchData])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const accept = async (id: string) => {
    setBusyId(id);
    try {
      const r = await api<{ ok: boolean; room_id: string; phrase_hint: string }>(
        `/rooms/invitations/${id}/accept`,
        { method: "POST" }
      );
      Alert.alert("Invitation accepted", r.phrase_hint);
      fetchData();
    } catch (e: any) {
      Alert.alert("Couldn't accept", e?.message || "Try again");
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/rooms/invitations/${id}/decline`, { method: "POST" });
      fetchData();
    } catch {}
    setBusyId(null);
  };

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Invitations</Text>
          <Text style={styles.subtitle}>
            Accepted invites add you to the room. Phrase + PIN are still required to enter.
          </Text>
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.brandPrimary}
            />
          }
        >
          {items.length === 0 ? (
            <View style={styles.empty} testID="empty-invitations">
              <View style={styles.emptyIcon}>
                <Ionicons
                  name="mail-open-outline"
                  size={28}
                  color={Colors.brandPrimary}
                />
              </View>
              <Text style={styles.emptyText}>No pending invitations.</Text>
              <Text style={styles.emptyHint}>
                When someone invites you, you'll see it here.
              </Text>
            </View>
          ) : (
            items.map((it) => (
              <View
                key={it.invitation_id}
                style={styles.card}
                testID={`invitation-${it.invitation_id}`}
              >
                <View style={styles.row}>
                  <View style={styles.iconWrap}>
                    <Ionicons
                      name={
                        it.room_type === "duo"
                          ? "people-outline"
                          : "people-circle-outline"
                      }
                      size={22}
                      color={Colors.brandPrimary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.roomName}>{it.room_name}</Text>
                    <Text style={styles.meta}>
                      Invited by {it.inviter_name} • {it.room_type.toUpperCase()}
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <Pressable
                    style={[styles.actBtn, styles.accept]}
                    onPress={() => accept(it.invitation_id)}
                    disabled={busyId === it.invitation_id}
                    testID={`accept-${it.invitation_id}`}
                  >
                    <Ionicons
                      name="checkmark-circle-outline"
                      size={16}
                      color={Colors.success}
                    />
                    <Text style={[styles.actText, { color: Colors.success }]}>
                      Accept
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actBtn, styles.decline]}
                    onPress={() => decline(it.invitation_id)}
                    disabled={busyId === it.invitation_id}
                    testID={`decline-${it.invitation_id}`}
                  >
                    <Ionicons
                      name="close-circle-outline"
                      size={16}
                      color={Colors.textSecondary}
                    />
                    <Text style={[styles.actText, { color: Colors.textSecondary }]}>
                      Decline
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: "700", color: Colors.textPrimary, letterSpacing: -0.6 },
  subtitle: { color: Colors.textSecondary, marginTop: 6, fontSize: 14, lineHeight: 20 },
  scroll: { padding: 24, paddingTop: 8, paddingBottom: 80 },
  empty: { alignItems: "center", paddingVertical: 60 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 64,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.brandFog,
    marginBottom: 16,
  },
  emptyText: { color: Colors.textPrimary, fontWeight: "600", fontSize: 16 },
  emptyHint: { color: Colors.textTertiary, fontSize: 13, marginTop: 6 },
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.brandFog,
  },
  roomName: { fontSize: 16, fontWeight: "600", color: Colors.textPrimary },
  meta: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  actBtn: {
    flex: 1,
    height: 44,
    borderRadius: Radii.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  accept: { backgroundColor: Colors.successBg, borderWidth: 1, borderColor: "#BBF7D0" },
  decline: { backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.divider },
  actText: { fontWeight: "600", fontSize: 13 },
});
