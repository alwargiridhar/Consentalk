import React from "react";
import { Image, View, Text, StyleSheet, ImageStyle, ViewStyle } from "react-native";
import { Colors, LOGO_URL } from "../lib/theme";

interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  align?: "center" | "left";
  tagline?: boolean;
}

export default function Logo({
  size = 64,
  showWordmark = false,
  align = "center",
  tagline = false,
}: LogoProps) {
  return (
    <View
      style={[
        styles.row,
        align === "left" ? styles.left : styles.center,
      ]}
      testID="consentalk-logo"
    >
      <Image
        source={{ uri: LOGO_URL }}
        style={{ width: size, height: size, resizeMode: "contain" } as ImageStyle}
      />
      {showWordmark ? (
        <View style={styles.wordmarkWrap}>
          <Text style={styles.wordmark}>Consentalk</Text>
          {tagline ? <Text style={styles.tagline}>Private by Presence</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 } as ViewStyle,
  center: { justifyContent: "center" },
  left: { justifyContent: "flex-start" },
  wordmarkWrap: { flexDirection: "column" },
  wordmark: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.textPrimary,
    letterSpacing: -0.4,
  },
  tagline: {
    fontSize: 11,
    color: Colors.brandPrimary,
    marginTop: 2,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontWeight: "600",
  },
});
