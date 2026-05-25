import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
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
import { useConfirm } from "../src/contexts/ConfirmContext";
import {
  purchaseSubscription,
  restorePurchases,
  startTrial,
  ProductId,
} from "../src/lib/iap";

interface Plan {
  id: string;
  name: string;
  currency: string;
  price: number;
  price_label: string;
  days: number;
  google_play_product_id?: string;
  trial_days?: number;
}

interface PlansResp {
  plans: Plan[];
  free_tier: {
    rooms_per_day: number;
    images_per_day?: number;
    images_per_session?: number;
    features: string[];
  };
  trial_days?: number;
  premium_features: string[];
}

interface BillingMe {
  is_premium: boolean;
  premium_until?: string | null;
  premium_plan?: string | null;
  is_admin_unlimited?: boolean;
  trial_used?: boolean;
  trial_days?: number;
}

export default function PremiumScreen() {
  const router = useRouter();
  const { refresh } = useAuth();
  const { confirm, notify } = useConfirm();
  const [data, setData] = useState<PlansResp | null>(null);
  const [me, setMe] = useState<BillingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState<"INR" | "USD">("INR");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [trialBusy, setTrialBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

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
      await notify("Couldn't load plans", e?.message || "Try again");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const trialDays = data?.trial_days ?? me?.trial_days ?? 3;

  const onStartTrial = async () => {
    const ok = await confirm({
      title: `Start your ${trialDays}-day free trial?`,
      message: `Enjoy all of Consentalk Presence — unlimited rooms, unlimited images, Deep mode — for ${trialDays} days. You won't be charged during the trial.`,
      confirmLabel: "Start free trial",
    });
    if (!ok) return;
    setTrialBusy(true);
    try {
      const r = await startTrial();
      if (!r.ok) throw new Error(r.reason || "Trial failed");
      await refresh();
      await load();
      await notify(
        `Free trial active`,
        `Enjoy Presence for the next ${trialDays} days. We'll never auto-charge.`
      );
    } catch (e: any) {
      await notify("Couldn't start trial", e?.message || "Try again");
    } finally {
      setTrialBusy(false);
    }
  };

  const subscribe = async (plan: Plan) => {
    const productId: ProductId | null =
      plan.id === "monthly_inr" || plan.id === "monthly_usd"
        ? "presence_monthly"
        : plan.id === "yearly_inr" || plan.id === "yearly_usd"
        ? "presence_yearly"
        : null;
    if (!productId) {
      await notify("Unknown plan");
      return;
    }
    const trialNote =
      me?.trial_used || me?.is_premium
        ? ""
        : `\n\nA ${trialDays}-day free trial will start first. We'll never auto-charge during the trial.`;
    const ok = await confirm({
      title: `Subscribe to ${plan.name.split("—")[1]?.trim() || plan.name}?`,
      message: `${plan.price_label}${trialNote}\n\n${
        Platform.OS === "android" || Platform.OS === "ios"
          ? "Payment will go through Google Play (or App Store)."
          : "(MOCKED on web preview — no charge will happen)"
      }`,
      confirmLabel:
        me?.trial_used || me?.is_premium ? "Subscribe" : "Start trial & continue",
    });
    if (!ok) return;
    setBusyId(plan.id);
    try {
      // Auto-trial-first: if user hasn't used trial yet, give them the
      // 3-day free trial BEFORE any charge. They can then convert to a
      // paid subscription afterwards.
      if (!me?.trial_used && !me?.is_premium) {
        const t = await startTrial();
        if (!t.ok) {
          // If trial fails (e.g. already used on backend), fall through to subscribe.
        }
      }
      // For the paid step (native or web fallback)
      const r = await purchaseSubscription(productId);
      if (!r.ok) {
        // Trial may still have succeeded — refresh anyway
        await refresh();
        await load();
        if (r.reason && !r.reason.toLowerCase().includes("cancel")) {
          await notify("Subscription pending", r.reason);
        }
      } else {
        await refresh();
        await load();
        await notify(
          "Welcome to Consentalk Presence",
          "Your premium access is now active."
        );
      }
    } catch (e: any) {
      await notify("Couldn't subscribe", e?.message || "Try again");
    } finally {
      setBusyId(null);
    }
  };

  const onRestore = async () => {
    setRestoreBusy(true);
    try {
      const r = await restorePurchases();
      await refresh();
      await load();
      if (r.is_premium) {
        await notify("Restored", "Your Presence subscription is active.");
      } else {
        await notify("No active subscription found");
      }
    } catch (e: any) {
      await notify("Restore failed", e?.message || "Try again");
    } finally {
      setRestoreBusy(false);
    }
  };

  const visiblePlans = (data?.plans || []).filter((p) => p.currency === region);
  const isTrial = me?.premium_plan === "trial";
  const canStartTrial = !me?.is_admin_unlimited && !me?.is_premium && !me?.trial_used;

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
            <Text style={styles.heroTitle}>
              Presence — Premium for the present moment
            </Text>
            <Text style={styles.heroSub}>
              No ads. No surveillance. No infinite-scroll. Just deeper, calmer
              conversation tools — and a {trialDays}-day free trial to feel it.
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
            <View
              style={[
                styles.activeBanner,
                isTrial && { backgroundColor: "#FEF3C7", borderColor: "#FDE68A" },
              ]}
              testID="active-premium-banner"
            >
              <Ionicons
                name={isTrial ? "time-outline" : "checkmark-circle"}
                size={18}
                color={isTrial ? "#B45309" : Colors.success}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.activeBannerTitle,
                    isTrial && { color: "#B45309" },
                  ]}
                >
                  {isTrial
                    ? `Free trial active`
                    : `You're on Presence`}
                </Text>
                <Text style={styles.activeBannerSub}>
                  {me.premium_until
                    ? `${
                        isTrial ? "Trial ends" : "Active until"
                      } ${new Date(me.premium_until).toLocaleDateString()}`
                    : "Active"}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Free trial CTA — prominent when eligible */}
          {canStartTrial ? (
            <View style={styles.trialCard} testID="trial-card">
              <View style={styles.trialBadge}>
                <Text style={styles.trialBadgeText}>{trialDays} DAYS FREE</Text>
              </View>
              <Text style={styles.trialTitle}>
                Try Presence — free for {trialDays} days
              </Text>
              <Text style={styles.trialSub}>
                Unlimited rooms · unlimited images · Deep mode access.{"\n"}
                No card needed. No auto-renew. We never auto-charge.
              </Text>
              <Button
                label={trialBusy ? "Activating…" : `Start ${trialDays}-day free trial`}
                onPress={onStartTrial}
                loading={trialBusy}
                icon="sparkles-outline"
                testID="start-trial-btn"
              />
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
                    <Text style={styles.planTitle}>
                      {p.name.split("—")[1]?.trim() || p.name}
                    </Text>
                    <Text style={styles.planPrice}>{p.price_label}</Text>
                    {canStartTrial ? (
                      <Text style={styles.planTrialNote}>
                        {trialDays} days free, then {p.price_label.toLowerCase()}
                      </Text>
                    ) : null}
                    <Button
                      label={
                        busyId === p.id
                          ? "Working…"
                          : me?.is_premium && !isTrial
                          ? "Extend"
                          : canStartTrial
                          ? `Start free trial`
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

              <Pressable
                onPress={onRestore}
                style={styles.restoreBtn}
                disabled={restoreBusy}
                testID="restore-btn"
              >
                {restoreBusy ? (
                  <ActivityIndicator color={Colors.brandPrimary} />
                ) : (
                  <>
                    <Ionicons
                      name="refresh-outline"
                      size={14}
                      color={Colors.brandPrimary}
                    />
                    <Text style={styles.restoreText}>Restore purchases</Text>
                  </>
                )}
              </Pressable>

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
                {Platform.OS === "android" || Platform.OS === "ios"
                  ? "Subscriptions are billed via Google Play / App Store. Cancel anytime from your store account."
                  : "Web preview uses a MOCKED payment endpoint. On Android, Google Play handles the actual subscription."}
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
  trialCard: {
    marginTop: 16,
    padding: 22,
    backgroundColor: "#FEF3C7",
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: "#FDE68A",
    gap: 8,
  },
  trialBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#B45309",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radii.pill,
  },
  trialBadgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  trialTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#7C2D12",
    letterSpacing: -0.3,
    marginTop: 4,
  },
  trialSub: { color: "#7C2D12", fontSize: 13, lineHeight: 18, marginBottom: 6 },
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
  regionText: {
    color: Colors.textSecondary,
    fontWeight: "600",
    fontSize: 12,
    letterSpacing: 1,
  },
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
  planTrialNote: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontStyle: "italic",
    marginBottom: 4,
  },
  restoreBtn: {
    marginTop: 14,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  restoreText: { color: Colors.brandPrimary, fontWeight: "600", fontSize: 12 },
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
