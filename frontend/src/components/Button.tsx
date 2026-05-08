import React from "react";
import {
  Pressable,
  Text,
  StyleSheet,
  View,
  ActivityIndicator,
  ViewStyle,
  StyleProp,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Radii } from "../lib/theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface BtnProps {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  full?: boolean;
}

export default function Button({
  label,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  testID,
  style,
  full = true,
}: BtnProps) {
  const isPrimary = variant === "primary";
  const isDanger = variant === "danger";
  const isSecondary = variant === "secondary";
  const isGhost = variant === "ghost";

  const textColor =
    isPrimary
      ? "#FFFFFF"
      : isDanger
      ? Colors.danger
      : isSecondary
      ? Colors.brandPrimary
      : Colors.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      testID={testID}
      style={({ pressed }) => [
        styles.btn,
        full ? styles.full : null,
        isSecondary && styles.secondary,
        isDanger && styles.danger,
        isGhost && styles.ghost,
        disabled && { opacity: 0.5 },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      {isPrimary ? (
        <LinearGradient
          colors={["#38BDF8", "#0EA5E9"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { borderRadius: Radii.pill }]}
        />
      ) : null}
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={textColor} />
        ) : (
          <>
            {icon ? (
              <Ionicons name={icon} size={18} color={textColor} style={{ marginRight: 8 }} />
            ) : null}
            <Text style={[styles.label, { color: textColor }]}>{label}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    height: 56,
    borderRadius: Radii.pill,
    paddingHorizontal: 24,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  full: { width: "100%" },
  secondary: {
    backgroundColor: Colors.brandFog,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  danger: {
    backgroundColor: Colors.dangerBg,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  ghost: {
    backgroundColor: "transparent",
  },
  row: { flexDirection: "row", alignItems: "center" },
  label: { fontSize: 16, fontWeight: "600", letterSpacing: -0.2 },
});
