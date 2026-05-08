import React, { useEffect } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../src/contexts/AuthContext";
import AmbientBackground from "../src/components/AmbientBackground";
import Logo from "../src/components/Logo";
import { Colors } from "../src/lib/theme";

export default function Index() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (user) {
      router.replace("/(tabs)");
    } else {
      router.replace("/auth");
    }
  }, [user, loading, router]);

  return (
    <AmbientBackground>
      <View style={styles.center}>
        <Logo size={96} />
        <Text style={styles.brand}>Consentalk</Text>
        <Text style={styles.tag}>— Private by Presence —</Text>
        <ActivityIndicator
          color={Colors.brandPrimary}
          style={{ marginTop: 32 }}
          testID="splash-loader"
        />
      </View>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  brand: {
    marginTop: 16,
    fontSize: 32,
    fontWeight: "700",
    color: Colors.textPrimary,
    letterSpacing: -0.6,
  },
  tag: {
    marginTop: 4,
    fontSize: 12,
    letterSpacing: 2,
    color: Colors.brandPrimary,
    textTransform: "uppercase",
    fontWeight: "600",
  },
});
