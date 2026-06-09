import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import Button from "../src/components/Button";
import { Colors, Radii } from "../src/lib/theme";
import { api } from "../src/lib/api";

const REASONS = [
  "Harassment",
  "Coercion",
  "Spam",
  "Impersonation",
  "Threats",
  "Other",
];

export default function ReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ user_id?: string; email?: string; room_id?: string }>();
  const [email, setEmail] = useState(params.email || "");
  const [reason, setReason] = useState("Harassment");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email && !params.user_id) {
      Alert.alert("Add the reported user's email");
      return;
    }
    setBusy(true);
    try {
      await api("/reports", {
        body: {
          reported_user_id: params.user_id || null,
          reported_user_email: email || null,
          room_id: params.room_id || null,
          reason,
          details,
        },
      });
      Alert.alert(
        "Report received",
        "Thank you. Our consent-first review process is now aware of this.",
        [{ text: "Done", onPress: () => router.back() }]
      );
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message || "Try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.title}>Report a User</Text>
            <View style={{ width: 36 }} />
          </View>

          <ScrollView contentContainerStyle={styles.scroll}>
            <View style={styles.card}>
              <Text style={styles.subtitle}>
                Reports help us protect everyone. We treat them with care — single
                reports do not result in instant bans.
              </Text>
              <Text style={styles.label}>Reported user email</Text>
              <TextInput
                testID="report-email-input"
                value={email}
                onChangeText={setEmail}
                placeholder="user@example.com"
                placeholderTextColor={Colors.textTertiary}
                style={styles.field}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <Text style={styles.label}>Reason</Text>
              <View style={styles.chips}>
                {REASONS.map((r) => (
                  <Pressable
                    key={r}
                    testID={`reason-${r}`}
                    onPress={() => setReason(r)}
                    style={[
                      styles.chip,
                      reason === r && styles.chipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        reason === r && { color: Colors.brandDeep, fontWeight: "700" },
                      ]}
                    >
                      {r}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>Details (optional)</Text>
              <TextInput
                testID="report-details-input"
                value={details}
                onChangeText={setDetails}
                placeholder="What happened? Be brief and clear."
                placeholderTextColor={Colors.textTertiary}
                style={[styles.field, { height: 100, textAlignVertical: "top" }]}
                multiline
              />
              <Button
                testID="report-submit"
                label={busy ? "Submitting…" : "Submit report"}
                loading={busy}
                onPress={submit}
                icon="alert-circle-outline"
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AmbientBackground>
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
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
    padding: 22,
  },
  subtitle: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  label: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textTertiary,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 14,
    marginBottom: 8,
  },
  field: {
    minHeight: 52,
    backgroundColor: Colors.bg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: Colors.textPrimary,
    fontSize: 15,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radii.pill,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  chipActive: {
    backgroundColor: Colors.brandFog,
    borderColor: "#7DD3FC",
  },
  chipText: { color: Colors.textSecondary, fontSize: 13 },
});
