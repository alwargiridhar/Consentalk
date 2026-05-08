import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Switch,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import Button from "../src/components/Button";
import { Colors, Radii } from "../src/lib/theme";
import { api } from "../src/lib/api";
import { useAuth } from "../src/contexts/AuthContext";

export default function VerifyScreen() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!consent) {
      Alert.alert("Consent required", "Please confirm the consent box to verify.");
      return;
    }
    setBusy(true);
    try {
      await api("/profile/verify", {
        body: {
          full_legal_name: name,
          date_of_birth: dob,
          country,
          phone,
          consent_acknowledged: consent,
        },
      });
      await refresh();
      Alert.alert("Verified", "Your account now carries the verified safety badge.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Could not verify", e?.message || "Try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.title}>Identity Verification</Text>
            <View style={{ width: 36 }} />
          </View>
          <ScrollView contentContainerStyle={styles.scroll}>
            <View style={styles.card}>
              <View style={styles.iconHero}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={28}
                  color={Colors.brandPrimary}
                />
              </View>
              <Text style={styles.subtitle}>
                Verifying your identity earns you a safety badge that other members
                can see — making it easier for them to feel safe with you.
              </Text>
              <Text style={styles.hint}>
                Your information is stored privately. We never publish it.
              </Text>

              <Field label="Full legal name" value={name} onChange={setName} testID="verify-name" />
              <Field
                label="Date of birth"
                value={dob}
                onChange={setDob}
                placeholder="YYYY-MM-DD"
                testID="verify-dob"
              />
              <Field label="Country" value={country} onChange={setCountry} testID="verify-country" />
              <Field
                label="Phone (with country code)"
                value={phone}
                onChange={setPhone}
                placeholder="+1 555 555 1234"
                keyboardType="phone-pad"
                testID="verify-phone"
              />

              <View style={styles.consentRow}>
                <Switch
                  testID="verify-consent"
                  value={consent}
                  onValueChange={setConsent}
                  trackColor={{ false: Colors.divider, true: Colors.brandPrimary }}
                />
                <Text style={styles.consentText}>
                  I confirm this information is accurate and submitted of my own free
                  will. I understand it may be reviewed if a serious safety case is opened.
                </Text>
              </View>

              <Button
                testID="verify-submit"
                label={busy ? "Submitting…" : "Verify my account"}
                loading={busy}
                onPress={submit}
                icon="shield-checkmark-outline"
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  keyboardType?: any;
  testID?: string;
}) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={Colors.textTertiary}
        keyboardType={props.keyboardType}
        style={styles.field}
      />
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
  card: {
    padding: 22,
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  iconHero: {
    width: 56,
    height: 56,
    borderRadius: 56,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  subtitle: { color: Colors.textPrimary, fontSize: 15, lineHeight: 22 },
  hint: {
    color: Colors.textTertiary,
    fontSize: 12,
    marginTop: 6,
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    color: Colors.textTertiary,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  field: {
    height: 52,
    backgroundColor: Colors.bg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 16,
    color: Colors.textPrimary,
    fontSize: 15,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 18,
    marginBottom: 12,
  },
  consentText: { flex: 1, color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
});
