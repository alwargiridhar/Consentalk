import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Colors, Radii } from "../lib/theme";
import { api } from "../lib/api";
import { getInitials, gradientFor } from "../lib/confirm";

export interface JoinRequest {
  request_id: string;
  room_id: string;
  requester_user_id: string;
  requester_name: string;
  requester_email: string;
  requester_picture?: string | null;
  requester_verified?: boolean;
  status: string;
  created_at?: string;
}

interface Props {
  roomId: string;
  // optional hook: parent can pass a ref to subscribe to incoming WS
  // `join_request` / `join_request_decided` events so this banner refreshes.
  wsTrigger?: number;
  testID?: string;
  onDecision?: (approved: boolean) => void;
}

export default function JoinRequestsBanner({
  roomId,
  wsTrigger = 0,
  testID,
  onDecision,
}: Props) {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ requests: JoinRequest[] }>(
        `/rooms/${roomId}/join-requests`
      );
      setRequests(r.requests || []);
    } catch (e: any) {
      // 403 → caller is not the owner; just hide quietly.
      if (String(e?.message || "").includes("Only the owner")) {
        setRequests([]);
      } else {
        setError(e?.message || "Could not load requests");
      }
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (wsTrigger > 0) load();
  }, [wsTrigger, load]);

  const decide = async (req: JoinRequest, approve: boolean) => {
    setBusyId(req.request_id);
    try {
      await api(`/rooms/${roomId}/join-requests/${req.request_id}/decision`, {
        body: { approve },
      });
      setRequests((prev) => prev.filter((r) => r.request_id !== req.request_id));
      if (onDecision) onDecision(approve);
    } catch (e: any) {
      setError(e?.message || "Decision failed");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.wrap, styles.row]} testID={testID}>
        <ActivityIndicator color={Colors.brandPrimary} />
        <Text style={styles.muted}>Loading access requests…</Text>
      </View>
    );
  }

  if (!requests.length && !error) {
    return null;
  }

  return (
    <View style={styles.wrap} testID={testID || "join-requests-banner"}>
      <View style={styles.headerRow}>
        <Ionicons name="hand-right-outline" size={16} color={Colors.brandPrimary} />
        <Text style={styles.headerText}>
          {requests.length} access request{requests.length === 1 ? "" : "s"}{" "}
          pending
        </Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {requests.map((req) => (
        <View
          key={req.request_id}
          style={styles.reqCard}
          testID={`join-req-${req.request_id}`}
        >
          <View style={styles.reqLeft}>
            <View style={styles.avatar}>
              <LinearGradient
                colors={gradientFor(req.requester_user_id)}
                style={[StyleSheet.absoluteFillObject, { borderRadius: 44 }]}
              />
              <Text style={styles.avatarInitials}>
                {getInitials(req.requester_name)}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.reqName} numberOfLines={1}>
                {req.requester_name || "Unknown"}
              </Text>
              <Text style={styles.reqEmail} numberOfLines={1}>
                {req.requester_email}
              </Text>
              {req.requester_verified ? (
                <View style={styles.verifyPill}>
                  <Ionicons
                    name="checkmark-circle"
                    size={11}
                    color={Colors.success}
                  />
                  <Text style={styles.verifyText}>VERIFIED</Text>
                </View>
              ) : null}
            </View>
          </View>
          <View style={styles.btnRow}>
            <Pressable
              style={[styles.btn, styles.reject]}
              onPress={() => decide(req, false)}
              disabled={busyId === req.request_id}
              testID={`reject-${req.request_id}`}
            >
              {busyId === req.request_id ? (
                <ActivityIndicator color={Colors.danger} size="small" />
              ) : (
                <>
                  <Ionicons
                    name="close-circle-outline"
                    size={14}
                    color={Colors.danger}
                  />
                  <Text style={[styles.btnText, { color: Colors.danger }]}>
                    Reject
                  </Text>
                </>
              )}
            </Pressable>
            <Pressable
              style={[styles.btn, styles.approve]}
              onPress={() => decide(req, true)}
              disabled={busyId === req.request_id}
              testID={`approve-${req.request_id}`}
            >
              {busyId === req.request_id ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Ionicons
                    name="checkmark-circle"
                    size={14}
                    color="#FFFFFF"
                  />
                  <Text style={[styles.btnText, { color: "#FFFFFF" }]}>
                    Approve
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 12,
    backgroundColor: Colors.brandFog,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#BAE6FD",
    gap: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: {
    color: Colors.brandDeep,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.4,
  },
  muted: { color: Colors.brandDeep, fontSize: 12 },
  error: { color: Colors.danger, fontSize: 12 },
  reqCard: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider2,
    padding: 12,
    gap: 12,
  },
  reqLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 44,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitials: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  reqName: { color: Colors.textPrimary, fontSize: 15, fontWeight: "700" },
  reqEmail: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  verifyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: Colors.successBg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: Radii.pill,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  verifyText: {
    color: Colors.success,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  btnRow: { flexDirection: "row", gap: 8 },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    borderRadius: Radii.pill,
  },
  approve: { backgroundColor: Colors.brandPrimary },
  reject: {
    backgroundColor: Colors.paper,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  btnText: { fontSize: 12, fontWeight: "700" },
});
