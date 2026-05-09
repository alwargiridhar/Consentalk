import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import AmbientBackground from "../src/components/AmbientBackground";
import Button from "../src/components/Button";
import { Colors, Radii } from "../src/lib/theme";
import { api } from "../src/lib/api";
import { useAuth } from "../src/contexts/AuthContext";
import { confirmDialog, notifyDialog } from "../src/lib/confirm";

interface Plan {
  id: string;
  name: string;
  currency: string;
  price: number;
  price_label: string;
  days: number;
}

interface PlansResp {
  plans: Plan[];
  free_tier: { rooms_per_day: number; images_per_session: number; features: string[] };
  premium_features: string[];
}

interface BillingMe {
  is_premium: boolean;
  premium_until?: string | null;
  premium_plan?: string | null;
  is_admin_unlimited?: boolean;
}

export default function PremiumScreen() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [data, setData] = useState<PlansResp | null>(null);
  const [me, setMe] = useState<BillingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState<"INR" | "USD">("INR");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [plans, mine] = await Promise.all([
        api<PlansResp>("/billing/plans"),
        api<BillingMe>("/billing/me"),
      ]);
      setData(plans);
      setMe(mine);
    } catch (e: any) {
      notifyDialog("Couldn't load plans", e?.message || "Try again");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const subscribe = async (plan: Plan) => {
    const ok = await confirmDialog({
      title: `Subscribe to ${plan.name}?`,
      message: `${plan.price_label}\n\n(MOCKED — no real payment is taken in this MVP. The platform will mark you as premium for ${plan.days} days.)`,
      confirmLabel: "Subscribe",
    });
    if (!ok) return;
    setBusyId(plan.id);
    try {
      await api("/billing/subscribe", { body: { plan_id: plan.id } });
      await refresh();
      await load();
      notifyDialog(
        "Welcome to Consentalk Presence",
        "Your premium access is now active."
      );
    } catch (e: any) {
      notifyDialog("Couldn't subscribe", e?.message || "Try again");
    } finally {
      setBusyId(null);
    }
  };

  const visiblePlans = (data?.plans || []).filter((p) => p.currency === region);

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <Text style={styles.title}>Consentalk Presence</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <LinearGradient
            colors={["#38BDF8", "#0EA5E9", "#0284C7"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <Ionicons name="diamond-outline" size={26} color="#FFFFFF" />
            <Text style={styles.heroTitle}>Presence — Premium for the present moment</Text>
            <Text style={styles.heroSub}>
              No ads. No surveillance. No infinite-scroll. Just deeper, calmer
              conversation tools.
            </Text>
          </LinearGradient>

          {me?.is_admin_unlimited ? (
            <View style={styles.adminBanner} testID="admin-unlimited-banner">
              <Ionicons name="ribbon-outline" size={16} color={Colors.brandPrimary} />
              <Text style={styles.adminBannerText}>
                Admin & super-admin accounts get all premium features included.
              </Text>
            </View>
          ) : me?.is_premium ? (
            <View style={styles.activeBanner} testID="active-premium-banner">
              <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
              <View style={{ flex: 1 }}>
                <Text style={styles.activeBannerTitle}>You're on Presence</Text>
                <Text style={styles.activeBannerSub}>
                  {me.premium_until
                    ? `Active until ${new Date(me.premium_until).toLocaleDateString()}`
                    : "Active"}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.regionRow}>
            <Pressable
              onPress={() => setRegion("INR")}
              style={[styles.regionBtn, region === "INR" && styles.regionBtnActive]}
              testID="region-INR"
            >
              <Text
                style={[
                  styles.regionText,
                  region === "INR" && { color: Colors.brandDeep, fontWeight: "700" },
                ]}
              >
                ₹ INDIA
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setRegion("USD")}
              style={[styles.regionBtn, region === "USD" && styles.regionBtnActive]}
              testID="region-USD"
            >
              <Text
                style={[
                  styles.regionText,
                  region === "USD" && { color: Colors.brandDeep, fontWeight: "700" },
                ]}
              >
                $ GLOBAL
              </Text>
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator color={Colors.brandPrimary} style={{ marginTop: 32 }} />
          ) : (
            <>
              <View style={styles.plansGrid}>
                {visiblePlans.map((p) => (
                  <View
                    key={p.id}
                    style={[
                      styles.planCard,
                      p.id.includes("yearly") && styles.planCardHighlight,
                    ]}
                    testID={`plan-${p.id}`}
                  >
                    <Text style={styles.planTag}>
                      {p.id.includes("yearly") ? "BEST VALUE" : "MONTHLY"}
                    </Text>
                    <Text style={styles.planTitle}>{p.name.split("—")[1]?.trim()}</Text>
                    <Text style={styles.planPrice}>{p.price_label}</Text>
                    <Button
                      label={
                        busyId === p.id
                          ? "Subscribing…"
                          : me?.is_premium
                          ? "Extend"
                          : "Subscribe"
                      }
                      loading={busyId === p.id}
                      onPress={() => subscribe(p)}
                      icon="diamond-outline"
                      testID={`subscribe-${p.id}`}
                    />
                  </View>
                ))}
              </View>

              <View style={styles.compareCard}>
                <Text style={styles.compareTitle}>What's included</Text>
                {(data?.premium_features || []).map((f) => (
                  <View key={f} style={styles.compareRow}>
                    <Ionicons
                      name="checkmark-circle-outline"
                      size={16}
                      color={Colors.success}
                    />
                    <Text style={styles.compareRowText}>{f}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.compareCardMuted}>
                <Text style={styles.compareTitle}>Free tier (always available)</Text>
                {(data?.free_tier.features || []).map((f) => (
                  <View key={f} style={styles.compareRow}>
                    <Ionicons
                      name="ellipse-outline"
                      size={14}
                      color={Colors.textSecondary}
                    />
                    <Text style={styles.compareRowText}>{f}</Text>
                  </View>
                ))}
              </View>

              <Text style={styles.disclaimer}>
                Payments are MOCKED in this MVP — no real charge happens. Production
                will integrate with Razorpay (India) and Stripe (global).
              </Text>
            </>
          )}
        </ScrollView>
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
  heroCard: {
    padding: 22,
    borderRadius: Radii.xl,
    gap: 8,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: -0.4,
    marginTop: 8,
  },
  heroSub: { color: "rgba(255,255,255,0.85)", fontSize: 14, lineHeight: 20 },
  activeBanner: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: Colors.successBg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  activeBannerTitle: { color: Colors.success, fontWeight: "700", fontSize: 14 },
  activeBannerSub: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  adminBanner: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    backgroundColor: Colors.brandFog,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  adminBannerText: { flex: 1, color: Colors.brandDeep, fontSize: 13, fontWeight: "600" },
  regionRow: { flexDirection: "row", gap: 8, marginTop: 18 },
  regionBtn: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: Colors.paper,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: Colors.divider2,
    alignItems: "center",
  },
  regionBtnActive: { backgroundColor: Colors.brandFog, borderColor: "#7DD3FC" },
  regionText: { color: Colors.textSecondary, fontWeight: "600", fontSize: 12, letterSpacing: 1 },
  plansGrid: { gap: 12, marginTop: 16 },
  planCard: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 22,
    borderWidth: 1,
    borderColor: Colors.divider2,
    gap: 8,
  },
  planCardHighlight: {
    borderColor: "#7DD3FC",
    backgroundColor: Colors.brandFog,
  },
  planTag: {
    fontSize: 10,
    color: Colors.brandPrimary,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  planTitle: { fontSize: 17, fontWeight: "700", color: Colors.textPrimary },
  planPrice: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.textPrimary,
    letterSpacing: -1,
    marginVertical: 6,
  },
  compareCard: {
    marginTop: 20,
    padding: 20,
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
    gap: 8,
  },
  compareCardMuted: {
    marginTop: 12,
    padding: 20,
    backgroundColor: Colors.bg,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
    gap: 8,
  },
  compareTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textTertiary,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  compareRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  compareRowText: { color: Colors.textPrimary, fontSize: 14, flex: 1 },
  disclaimer: {
    marginTop: 16,
    color: Colors.textTertiary,
    fontSize: 11,
    lineHeight: 16,
    textAlign: "center",
  },
});
