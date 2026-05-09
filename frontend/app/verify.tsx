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
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import Button from "../src/components/Button";
import CountryPicker from "../src/components/CountryPicker";
import { Colors, Radii } from "../src/lib/theme";
import { api } from "../src/lib/api";
import { useAuth } from "../src/contexts/AuthContext";
import { Country, isValidPhone } from "../src/lib/countries";

type Stage = "form" | "otp_sent" | "verified";

export default function VerifyScreen() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState<Country | null>(null);
  const [phoneLocal, setPhoneLocal] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  const fullPhone = country ? `${country.dial}${phoneLocal.replace(/\s|-/g, "")}` : "";

  const requestOtp = async () => {
    if (!country) {
      Alert.alert("Pick a country first");
      return;
    }
    if (!phoneLocal.replace(/\D/g, "").length) {
      Alert.alert("Enter your phone number");
      return;
    }
    if (!isValidPhone(fullPhone)) {
      Alert.alert("Phone format invalid", `Try a number like ${country.dial}5551234567`);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; dev_code?: string; mocked?: boolean }>(
        "/profile/phone/request-otp",
        { body: { phone: fullPhone } }
      );
      setStage("otp_sent");
      setDevCode(r.dev_code || null);
    } catch (e: any) {
      Alert.alert("Couldn't send OTP", e?.message || "Try again");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length < 4) {
      Alert.alert("Enter the 6-digit code");
      return;
    }
    setBusy(true);
    try {
      await api("/profile/phone/verify-otp", { body: { phone: fullPhone, code: otp } });
      setPhoneVerified(true);
      setStage("verified");
    } catch (e: any) {
      Alert.alert("OTP not accepted", e?.message || "Try again");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!consent) {
      Alert.alert("Consent required", "Please confirm the consent box to verify.");
      return;
    }
    if (!phoneVerified) {
      Alert.alert("Phone not verified", "Please verify your phone with OTP first.");
      return;
    }
    setBusy(true);
    try {
      await api("/profile/verify", {
        body: {
          full_legal_name: name,
          date_of_birth: dob,
          country: country?.name || "",
          phone: fullPhone,
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
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
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

              <Text style={styles.fieldLabel}>Full legal name</Text>
              <TextInput
                testID="verify-name"
                value={name}
                onChangeText={setName}
                style={styles.field}
              />

              <Text style={styles.fieldLabel}>Date of birth</Text>
              <TextInput
                testID="verify-dob"
                value={dob}
                onChangeText={setDob}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.textTertiary}
                style={styles.field}
              />

              <Text style={styles.fieldLabel}>Country</Text>
              <CountryPicker
                value={country?.name || ""}
                onSelect={(c) => {
                  setCountry(c);
                  setPhoneVerified(false);
                  setStage("form");
                }}
                testID="verify-country"
              />

              <Text style={styles.fieldLabel}>Mobile number</Text>
              <View style={styles.phoneRow}>
                <View style={styles.dialBox}>
                  <Text style={styles.dialText}>
                    {country?.dial || "+--"}
                  </Text>
                </View>
                <TextInput
                  testID="verify-phone"
                  value={phoneLocal}
                  onChangeText={(v) => {
                    setPhoneLocal(v);
                    if (phoneVerified) setPhoneVerified(false);
                    if (stage !== "form") setStage("form");
                  }}
                  placeholder="555 123 4567"
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="phone-pad"
                  style={[styles.field, { flex: 1, marginTop: 0 }]}
                />
              </View>

              {stage === "form" && (
                <Pressable
                  onPress={requestOtp}
                  disabled={busy}
                  style={[styles.otpBtn, busy && { opacity: 0.6 }]}
                  testID="verify-send-otp"
                >
                  {busy ? (
                    <ActivityIndicator color={Colors.brandPrimary} />
                  ) : (
                    <>
                      <Ionicons
                        name="paper-plane-outline"
                        size={16}
                        color={Colors.brandPrimary}
                      />
                      <Text style={styles.otpBtnText}>Send OTP to my phone</Text>
                    </>
                  )}
                </Pressable>
              )}

              {stage === "otp_sent" && !phoneVerified && (
                <View style={styles.otpBlock}>
                  <Text style={styles.otpHint}>
                    A 6-digit code has been generated.{" "}
                    <Text style={{ color: Colors.warn, fontWeight: "700" }}>MOCKED:</Text>{" "}
                    in production this is sent over SMS. For now use the code shown
                    below.
                  </Text>
                  {devCode ? (
                    <View style={styles.devCodeBox}>
                      <Text style={styles.devCodeLabel}>Dev OTP:</Text>
                      <Text style={styles.devCodeValue} testID="dev-otp-code">
                        {devCode}
                      </Text>
                    </View>
                  ) : null}
                  <TextInput
                    testID="verify-otp-input"
                    value={otp}
                    onChangeText={setOtp}
                    placeholder="● ● ● ● ● ●"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="number-pad"
                    maxLength={6}
                    style={[styles.field, { textAlign: "center", letterSpacing: 6 }]}
                  />
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <Pressable
                      onPress={requestOtp}
                      style={[styles.smallBtn, { flex: 1 }]}
                      testID="verify-resend-otp"
                    >
                      <Text style={styles.smallBtnText}>Resend</Text>
                    </Pressable>
                    <Pressable
                      onPress={verifyOtp}
                      style={[
                        styles.smallBtn,
                        { flex: 2, backgroundColor: Colors.brandPrimary },
                      ]}
                      disabled={busy}
                      testID="verify-confirm-otp"
                    >
                      {busy ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={[styles.smallBtnText, { color: "#FFFFFF" }]}>
                          Confirm OTP
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}

              {phoneVerified && (
                <View style={styles.verifiedBox} testID="phone-verified-banner">
                  <Ionicons
                    name="checkmark-circle"
                    size={18}
                    color={Colors.success}
                  />
                  <Text style={styles.verifiedText}>
                    Phone verified ({fullPhone})
                  </Text>
                </View>
              )}

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
                disabled={!phoneVerified || !consent}
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
    marginTop: 14,
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
  phoneRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  dialBox: {
    height: 52,
    paddingHorizontal: 14,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  dialText: {
    color: Colors.brandDeep,
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  otpBtn: {
    marginTop: 12,
    height: 46,
    borderRadius: Radii.pill,
    backgroundColor: Colors.brandFog,
    borderWidth: 1,
    borderColor: "#BAE6FD",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  otpBtnText: {
    color: Colors.brandPrimary,
    fontWeight: "600",
    fontSize: 14,
  },
  otpBlock: { marginTop: 14, gap: 10 },
  otpHint: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },
  devCodeBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: Colors.warnBg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  devCodeLabel: { color: Colors.warn, fontWeight: "700", fontSize: 12 },
  devCodeValue: {
    color: Colors.warn,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 4,
  },
  smallBtn: {
    height: 46,
    borderRadius: Radii.pill,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBtnText: { color: Colors.textSecondary, fontWeight: "600" },
  verifiedBox: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    backgroundColor: Colors.successBg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  verifiedText: { color: Colors.success, fontWeight: "600", fontSize: 13 },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 18,
    marginBottom: 12,
  },
  consentText: { flex: 1, color: Colors.textSecondary, fontSize: 13, lineHeight: 18 },
});
