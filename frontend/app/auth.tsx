import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import Logo from "../src/components/Logo";
import Button from "../src/components/Button";
import { Colors, Radii } from "../src/lib/theme";
import { useAuth } from "../src/contexts/AuthContext";

const PROMISES = [
  { icon: "shield-checkmark-outline", text: "Encrypted by default" },
  { icon: "time-outline", text: "Built for moments, not archives" },
  { icon: "lock-closed-outline", text: "Invisible rooms — appear only on intent" },
];

export default function AuthScreen() {
  const { signIn, loading, authError } = useAuth();
  const router = useRouter();

  return (
    <AmbientBackground>
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.heroWrap}>
            <Logo size={88} />
            <Text style={styles.brand}>Consentalk</Text>
            <Text style={styles.tag}>— Private by Presence —</Text>
            <Text style={styles.intro}>
              A private space for intentional conversations that disappear
              naturally. Rooms appear only when you summon them — by phrase
              and PIN.
            </Text>
          </View>

          <View style={styles.card}>
            {PROMISES.map((p) => (
              <View key={p.text} style={styles.row}>
                <View style={styles.iconCircle}>
                  <Ionicons
                    name={p.icon as any}
                    size={18}
                    color={Colors.brandPrimary}
                  />
                </View>
                <Text style={styles.rowText}>{p.text}</Text>
              </View>
            ))}

            <Button
              testID="google-signin-btn"
              label="Continue with Google"
              icon="logo-google"
              loading={loading}
              onPress={signIn}
              style={{ marginTop: 16 }}
            />
            {authError ? (
              <Text style={styles.error} testID="auth-error">
                {authError}
              </Text>
            ) : null}

            <Pressable
              testID="open-faq-btn"
              onPress={() => router.push("/faq")}
              style={styles.linkRow}
            >
              <Ionicons
                name="help-circle-outline"
                size={16}
                color={Colors.textSecondary}
              />
              <Text style={styles.linkText}>How does Consentalk work?</Text>
            </Pressable>

            <Text style={styles.terms}>
              By continuing you agree to use Consentalk for lawful, consensual
              communication. We never sell data. Consentalk balances privacy,
              safety, and lawful responsibility.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { flexGrow: 1, padding: 24, justifyContent: "space-between" },
  heroWrap: { alignItems: "center", paddingTop: 32, paddingBottom: 24 },
  brand: {
    marginTop: 14,
    fontSize: 30,
    fontWeight: "700",
    color: Colors.textPrimary,
    letterSpacing: -0.6,
  },
  tag: {
    marginTop: 4,
    fontSize: 11,
    letterSpacing: 2,
    color: Colors.brandPrimary,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  intro: {
    marginTop: 18,
    fontSize: 15,
    color: Colors.textSecondary,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 360,
  },
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 22,
    gap: 14,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 32,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { color: Colors.textPrimary, fontSize: 14, flex: 1 },
  error: {
    color: Colors.danger,
    marginTop: 8,
    fontSize: 13,
    textAlign: "center",
  },
  linkRow: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 8,
  },
  linkText: { color: Colors.textSecondary, fontSize: 13 },
  terms: {
    marginTop: 6,
    fontSize: 11,
    color: Colors.textTertiary,
    textAlign: "center",
    lineHeight: 16,
  },
});
