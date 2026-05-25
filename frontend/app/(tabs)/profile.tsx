import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import AmbientBackground from "../../src/components/AmbientBackground";
import { Colors, Radii } from "../../src/lib/theme";
import { useAuth } from "../../src/contexts/AuthContext";
import { useConfirm } from "../../src/contexts/ConfirmContext";
import { gradientFor } from "../../src/lib/confirm";

interface MenuItem {
  testID: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  caption: string;
  to?: string;
  badge?: string;
  destructive?: boolean;
  onPress?: () => void;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { confirm } = useConfirm();

  const items: MenuItem[] = [
    {
      testID: "menu-verify",
      icon: "shield-checkmark-outline",
      label: "Identity Verification",
      caption: user?.verified
        ? "Verified — your account carries a safety badge"
        : "Add personal info to earn the verified badge",
      to: "/verify",
      badge: user?.verified ? "VERIFIED" : undefined,
    },
    {
      testID: "menu-transparency",
      icon: "stats-chart-outline",
      label: "Transparency Dashboard",
      caption: "Active sessions, devices, retention windows",
      to: "/transparency",
    },
    {
      testID: "menu-create-room",
      icon: "add-circle-outline",
      label: "Create New Room",
      caption: "Phrase + PIN, Duo or Circle",
      to: "/room/create",
    },
    {
      testID: "menu-report",
      icon: "alert-circle-outline",
      label: "Report a User",
      caption: "Safety reports trigger consent-first review",
      to: "/report",
    },
    {
      testID: "menu-faq",
      icon: "help-circle-outline",
      label: "Trust & Safety FAQ",
      caption: "How Consentalk protects your dignity",
      to: "/faq",
    },
  ];

  if (user?.role === "admin" || user?.role === "super_admin") {
    items.unshift({
      testID: "menu-admin",
      icon: "construct-outline",
      label:
        user.role === "super_admin"
          ? "Super-Admin Console"
          : "Moderation Console",
      caption:
        user.role === "super_admin"
          ? "Users, reports, roles & lawful forensic review"
          : "Users & report queue",
      to: "/admin",
      badge: user.role === "super_admin" ? "SUPER" : "ADMIN",
    });
  }

  items.push({
    testID: "menu-premium",
    icon: "diamond-outline",
    label: user?.is_premium ? "Manage Premium" : "Upgrade to Presence",
    caption: user?.is_premium
      ? "You are a Premium member"
      : "3-day free trial · then ₹99/mo or ₹999/yr",
    to: "/premium",
    badge: user?.is_premium ? "PRESENCE" : "PRO",
  });

  items.push({
    testID: "menu-signout",
    icon: "log-out-outline",
    label: "Sign Out",
    caption: "Ends this session",
    destructive: true,
    onPress: async () => {
      const ok = await confirm({
        title: "Sign out",
        message: "End your Consentalk session on this device?",
        confirmLabel: "Sign out",
        destructive: true,
      });
      if (ok) {
        await signOut();
        router.replace("/auth");
      }
    },
  });

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.header}>
            <View style={styles.avatarWrap}>
              <View style={[styles.avatar, styles.avatarFallback]}>
                <LinearGradient
                  colors={gradientFor(user?.user_id || user?.email || "?")}
                  style={[StyleSheet.absoluteFillObject, { borderRadius: 96 }]}
                />
                <Text style={styles.avatarInitials}>
                  {(user?.name || "?")
                    .trim()
                    .split(/\s+/)
                    .map((p) => p[0]?.toUpperCase() || "")
                    .slice(0, 2)
                    .join("") || "?"}
                </Text>
              </View>
              {user?.verified ? (
                <View style={styles.verifyDot}>
                  <Ionicons name="checkmark" size={12} color="#FFFFFF" />
                </View>
              ) : null}
            </View>
            <Text style={styles.name} testID="profile-name">
              {user?.name}
            </Text>
            <Text style={styles.email}>{user?.email}</Text>
            <View style={styles.badgeRow}>
              <View style={styles.badge}>
                <Ionicons
                  name={user?.role === "super_admin" ? "ribbon-outline" : "person-circle-outline"}
                  size={13}
                  color={Colors.brandPrimary}
                />
                <Text style={styles.badgeText}>
                  {user?.role?.replace("_", " ").toUpperCase()}
                </Text>
              </View>
              {user?.is_premium ? (
                <View style={[styles.badge, { backgroundColor: "#FEF3C7", borderColor: "#FCD34D" }]}>
                  <Ionicons name="diamond-outline" size={13} color="#B45309" />
                  <Text style={[styles.badgeText, { color: "#B45309" }]}>PRESENCE</Text>
                </View>
              ) : null}
              <View style={styles.badge}>
                <Ionicons name="pulse-outline" size={13} color={Colors.brandPrimary} />
                <Text style={styles.badgeText}>{user?.status?.toUpperCase()}</Text>
              </View>
            </View>
          </View>

          <View style={styles.menu}>
            {items.map((it) => (
              <Pressable
                key={it.testID}
                testID={it.testID}
                onPress={() => {
                  if (it.onPress) {
                    it.onPress();
                  } else if (it.to) {
                    router.push(it.to as any);
                  }
                }}
                style={({ pressed }) => [
                  styles.menuItem,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <View
                  style={[
                    styles.menuIcon,
                    it.destructive && { backgroundColor: Colors.dangerBg },
                  ]}
                >
                  <Ionicons
                    name={it.icon}
                    size={20}
                    color={it.destructive ? Colors.danger : Colors.brandPrimary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.menuLabelRow}>
                    <Text
                      style={[
                        styles.menuLabel,
                        it.destructive && { color: Colors.danger },
                      ]}
                    >
                      {it.label}
                    </Text>
                    {it.badge ? (
                      <View style={styles.menuBadge}>
                        <Text style={styles.menuBadgeText}>{it.badge}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.menuCaption}>{it.caption}</Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={Colors.textTertiary}
                />
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 24, paddingBottom: 80 },
  header: { alignItems: "center", paddingTop: 16, paddingBottom: 24 },
  avatarWrap: {},
  avatar: { width: 96, height: 96, borderRadius: 96, backgroundColor: Colors.divider2, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.brandPrimary,
  },
  avatarInitials: { color: "#FFFFFF", fontSize: 36, fontWeight: "800", letterSpacing: 1 },
  alias: { fontSize: 14, color: Colors.textTertiary, fontWeight: "400" },
  verifyDot: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 26,
    height: 26,
    borderRadius: 26,
    backgroundColor: Colors.success,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: Colors.bg,
  },
  name: { fontSize: 22, fontWeight: "700", color: Colors.textPrimary, marginTop: 12 },
  email: { fontSize: 13, color: Colors.textSecondary, marginTop: 4 },
  badgeRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Colors.brandFog,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.brandDeep,
    letterSpacing: 0.5,
  },
  menu: { gap: 10 },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 40,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  menuLabelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  menuLabel: { fontSize: 15, fontWeight: "600", color: Colors.textPrimary },
  menuBadge: {
    backgroundColor: Colors.brandPrimary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radii.pill,
  },
  menuBadgeText: { color: "#FFFFFF", fontSize: 9, fontWeight: "700", letterSpacing: 0.6 },
  menuCaption: { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
});
