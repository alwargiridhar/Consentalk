import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Image,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import { Colors, Radii } from "../../src/lib/theme";
import { api } from "../../src/lib/api";
import { useAuth } from "../../src/contexts/AuthContext";
import { useConfirm } from "../../src/contexts/ConfirmContext";

interface UserRow {
  user_id: string;
  email: string;
  name: string;
  picture?: string;
  role: string;
  status: string;
  verified: boolean;
  risk_score: number;
}

interface Report {
  report_id: string;
  reporter_name: string;
  reported_user_email: string;
  reported_user_name?: string;
  reason: string;
  details?: string;
  status: string;
  created_at: string;
}

interface Fragment {
  fragment_id: string;
  room_id: string;
  preview: string;
  created_at: string;
  expires_at: string;
}

type Tab = "users" | "reports" | "billing" | "roles" | "analytics" | "forensic" | "audit";

export default function AdminDashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { confirm, notify } = useConfirm();
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [premiumUsers, setPremiumUsers] = useState<UserRow[]>([]);
  const [billingEvents, setBillingEvents] = useState<any[]>([]);
  const [customRoles, setCustomRoles] = useState<any[]>([]);
  const [permCatalog, setPermCatalog] = useState<string[]>([]);
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const isSuper = user?.role === "super_admin";

  const load = useCallback(async () => {
    try {
      if (tab === "users") {
        const r = await api<{ users: UserRow[] }>("/admin/users");
        setUsers(r.users || []);
      } else if (tab === "reports") {
        const r = await api<{ reports: Report[] }>("/admin/reports");
        setReports(r.reports || []);
      } else if (tab === "forensic") {
        const r = await api<{ fragments: Fragment[] }>("/admin/forensic");
        setFragments(r.fragments || []);
      } else if (tab === "audit") {
        const r = await api<{ actions: any[] }>("/admin/audit");
        setAudit(r.actions || []);
      } else if (tab === "billing") {
        const [pu, ev] = await Promise.all([
          api<{ users: UserRow[] }>("/admin/billing/users"),
          api<{ events: any[] }>("/admin/billing/events"),
        ]);
        setPremiumUsers(pu.users || []);
        setBillingEvents(ev.events || []);
      } else if (tab === "roles") {
        const [rs, perms] = await Promise.all([
          api<{ roles: any[] }>("/admin/roles"),
          api<{ catalog: string[] }>("/admin/permissions"),
        ]);
        setCustomRoles(rs.roles || []);
        setPermCatalog(perms.catalog || []);
        // also load users so we can assign roles
        const u = await api<{ users: UserRow[] }>("/admin/users");
        setUsers(u.users || []);
      } else if (tab === "analytics") {
        const a = await api<any>("/admin/analytics/summary");
        setAnalytics(a);
      }
    } catch (e: any) {
      notify("Couldn't load", e?.message || "Try again");
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!user) return <Redirect href="/auth" />;
  if (user.role !== "admin" && user.role !== "super_admin") {
    return <Redirect href="/(tabs)" />;
  }

  const action = async (target_user_id: string, act: string, label: string) => {
    const ok = await confirm({
      title: label,
      message: "Apply this action?",
      confirmLabel: "Apply",
      destructive: act === "blacklist" || act === "suspend",
    });
    if (!ok) return;
    try {
      await api("/admin/users/action", { body: { target_user_id, action: act } });
      await load();
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    }
  };

  const role = async (target_user_id: string, newRole: string) => {
    const ok = await confirm({
      title: "Change role",
      message: `Set role to ${newRole}?`,
      confirmLabel: "Apply",
    });
    if (!ok) return;
    try {
      await api("/admin/users/role", { body: { target_user_id, role: newRole } });
      await load();
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    }
  };

  const grantPremium = async (target_user_id: string, plan_id: string) => {
    const ok = await confirm({
      title: "Grant premium",
      message: `Grant ${plan_id} to this user?`,
      confirmLabel: "Grant",
    });
    if (!ok) return;
    try {
      await api("/admin/billing/grant", { body: { target_user_id, plan_id } });
      await load();
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    }
  };

  const revokePremium = async (target_user_id: string) => {
    const ok = await confirm({
      title: "Revoke premium?",
      message: "This user will be moved back to the free tier.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api("/admin/billing/revoke", { body: { target_user_id, plan_id: "monthly_inr" } });
      await load();
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    }
  };

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <View style={{ flex: 1, paddingHorizontal: 12 }}>
            <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>
              {isSuper ? "Super-Admin Console" : "Moderation Console"}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {isSuper
                ? "© Giridhar Alwar — all rights reserved"
                : "Targeted, consent-first moderation"}
            </Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          <TabBtn label="Users" active={tab === "users"} onPress={() => setTab("users")} />
          <TabBtn label="Reports" active={tab === "reports"} onPress={() => setTab("reports")} />
          <TabBtn label="Billing" active={tab === "billing"} onPress={() => setTab("billing")} />
          <TabBtn label="Roles" active={tab === "roles"} onPress={() => setTab("roles")} />
          <TabBtn label="Analytics" active={tab === "analytics"} onPress={() => setTab("analytics")} />
          {isSuper ? (
            <TabBtn label="Forensic" active={tab === "forensic"} onPress={() => setTab("forensic")} />
          ) : null}
          <TabBtn label="Audit" active={tab === "audit"} onPress={() => setTab("audit")} />
        </ScrollView>

        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.brandPrimary}
            />
          }
        >
          {tab === "users" &&
            users.map((u) => (
              <View key={u.user_id} style={styles.card} testID={`user-${u.user_id}`}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  {u.picture ? (
                    <Image source={{ uri: u.picture }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback]}>
                      <Ionicons name="person-outline" size={16} color="#FFFFFF" />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.userName} numberOfLines={1}>
                      {u.name}{" "}
                      {u.verified ? (
                        <Ionicons
                          name="checkmark-circle"
                          size={13}
                          color={Colors.success}
                        />
                      ) : null}
                    </Text>
                    <Text style={styles.userEmail} numberOfLines={1}>
                      {u.email}
                    </Text>
                  </View>
                  <RoleBadge role={u.role} />
                </View>
                <View style={styles.metaRow}>
                  <MetaPill label={u.status.toUpperCase()} status={u.status} />
                  <MetaPill label={`RISK ${u.risk_score}`} status="info" />
                </View>
                <View style={styles.actBar}>
                  <ActBtn
                    icon="notifications-outline"
                    label="Warn"
                    onPress={() => action(u.user_id, "warn", "Warn user")}
                  />
                  <ActBtn
                    icon="lock-closed-outline"
                    label="Restrict"
                    onPress={() => action(u.user_id, "restrict", "Restrict user")}
                  />
                  <ActBtn
                    icon="pause-circle-outline"
                    label="Suspend"
                    onPress={() => action(u.user_id, "suspend", "Suspend user")}
                  />
                  {isSuper ? (
                    <ActBtn
                      icon="ban-outline"
                      label="Blacklist"
                      tone="danger"
                      onPress={() => action(u.user_id, "blacklist", "Blacklist user")}
                    />
                  ) : null}
                  <ActBtn
                    icon="refresh-outline"
                    label="Reactivate"
                    tone="success"
                    onPress={() => action(u.user_id, "reactivate", "Reactivate user")}
                  />
                </View>
                {isSuper ? (
                  <View style={styles.roleBar}>
                    <Pressable
                      onPress={() => role(u.user_id, "user")}
                      style={styles.rolePill}
                    >
                      <Text style={styles.rolePillText}>Make User</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => role(u.user_id, "admin")}
                      style={styles.rolePill}
                    >
                      <Text style={styles.rolePillText}>Make Admin</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => role(u.user_id, "super_admin")}
                      style={[styles.rolePill, { backgroundColor: Colors.brandFog }]}
                    >
                      <Text
                        style={[
                          styles.rolePillText,
                          { color: Colors.brandDeep, fontWeight: "700" },
                        ]}
                      >
                        Make Super
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))}

          {tab === "reports" &&
            reports.map((r) => (
              <View key={r.report_id} style={styles.card} testID={`report-${r.report_id}`}>
                <Text style={styles.reportReason}>{r.reason}</Text>
                <Text style={styles.reportText}>
                  Reported user: {r.reported_user_name || r.reported_user_email}
                </Text>
                <Text style={styles.reportText}>By: {r.reporter_name}</Text>
                {r.details ? (
                  <Text style={styles.reportDetails}>"{r.details}"</Text>
                ) : null}
                <Text style={styles.reportTime}>
                  {new Date(r.created_at).toLocaleString()}
                </Text>
              </View>
            ))}

          {tab === "forensic" && isSuper &&
            fragments.map((f) => (
              <View key={f.fragment_id} style={styles.card}>
                <Text style={styles.userEmail}>Room {f.room_id}</Text>
                <Text style={styles.reportText}>{f.preview}</Text>
                <Text style={styles.reportTime}>
                  Created {new Date(f.created_at).toLocaleString()} • Expires{" "}
                  {new Date(f.expires_at).toLocaleDateString()}
                </Text>
              </View>
            ))}

          {tab === "audit" &&
            audit.map((a) => (
              <View key={a.action_id} style={styles.card}>
                <Text style={styles.userName}>{a.action}</Text>
                <Text style={styles.reportText}>
                  By {a.admin_name || a.admin_user_id} → {a.target_user_id}
                </Text>
                {a.reason ? (
                  <Text style={styles.reportDetails}>"{a.reason}"</Text>
                ) : null}
                <Text style={styles.reportTime}>
                  {a.created_at ? new Date(a.created_at).toLocaleString() : ""}
                </Text>
              </View>
            ))}

          {tab === "billing" && (
            <BillingTab
              users={premiumUsers}
              events={billingEvents}
              onGrant={grantPremium}
              onRevoke={revokePremium}
              isSuper={isSuper}
            />
          )}

          {tab === "roles" && (
            <RolesTab
              roles={customRoles}
              perms={permCatalog}
              users={users}
              isSuper={isSuper}
              onCreated={load}
              onAssigned={load}
            />
          )}

          {tab === "analytics" && analytics && (
            <AnalyticsTab data={analytics} />
          )}

          {(tab === "users" && users.length === 0) ||
          (tab === "reports" && reports.length === 0) ||
          (tab === "forensic" && fragments.length === 0) ||
          (tab === "audit" && audit.length === 0) ||
          (tab === "billing" && premiumUsers.length === 0 && billingEvents.length === 0) ||
          (tab === "roles" && customRoles.length === 0) ? (
            <View style={styles.empty}>
              <Ionicons name="leaf-outline" size={28} color={Colors.brandPrimary} />
              <Text style={styles.emptyText}>Nothing to review here.</Text>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

// ---------------- Billing tab ----------------
function BillingTab({
  users,
  events,
  onGrant,
  onRevoke,
  isSuper,
}: {
  users: UserRow[];
  events: any[];
  onGrant: (id: string, plan: string) => void;
  onRevoke: (id: string) => void;
  isSuper: boolean;
}) {
  const [search, setSearch] = useState("");
  const [allUsers, setAllUsers] = useState<UserRow[]>([]);

  React.useEffect(() => {
    api<{ users: UserRow[] }>("/admin/users").then((r) => setAllUsers(r.users || []));
  }, []);

  const matches = search
    ? allUsers.filter(
        (u) =>
          u.email.toLowerCase().includes(search.toLowerCase()) ||
          (u.name || "").toLowerCase().includes(search.toLowerCase())
      ).slice(0, 20)
    : [];

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Grant Premium</Text>
        <Text style={styles.sectionHint}>
          Search a user by email/name, then grant them a plan.
        </Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by email or name…"
          placeholderTextColor={Colors.textTertiary}
          style={styles.searchInput}
          testID="admin-billing-search"
          autoCapitalize="none"
        />
        {matches.map((u) => (
          <View key={u.user_id} style={styles.miniRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.userName}>{u.name}</Text>
              <Text style={styles.userEmail}>
                {u.email} · {u.is_premium ? "PREMIUM" : "FREE"}
              </Text>
            </View>
            <Pressable
              style={[styles.grantBtn, { backgroundColor: Colors.brandFog }]}
              onPress={() => onGrant(u.user_id, "monthly_inr")}
              testID={`grant-monthly-${u.user_id}`}
            >
              <Text style={styles.grantBtnText}>+30d</Text>
            </Pressable>
            <Pressable
              style={[styles.grantBtn, { backgroundColor: "#FEF3C7" }]}
              onPress={() => onGrant(u.user_id, "yearly_inr")}
              testID={`grant-yearly-${u.user_id}`}
            >
              <Text style={[styles.grantBtnText, { color: "#B45309" }]}>+1yr</Text>
            </Pressable>
            {u.is_premium && isSuper ? (
              <Pressable
                style={[styles.grantBtn, { backgroundColor: Colors.dangerBg }]}
                onPress={() => onRevoke(u.user_id)}
                testID={`revoke-${u.user_id}`}
              >
                <Text style={[styles.grantBtnText, { color: Colors.danger }]}>
                  REVOKE
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Active premium users</Text>
        {users.length === 0 ? (
          <Text style={styles.sectionHint}>No active premium users yet.</Text>
        ) : (
          users.map((u) => (
            <View key={u.user_id} style={styles.miniRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.name}</Text>
                <Text style={styles.userEmail}>
                  {u.email} · until{" "}
                  {(u as any).premium_until
                    ? new Date((u as any).premium_until).toLocaleDateString()
                    : "—"}
                </Text>
              </View>
              {isSuper ? (
                <Pressable
                  style={[styles.grantBtn, { backgroundColor: Colors.dangerBg }]}
                  onPress={() => onRevoke(u.user_id)}
                  testID={`revoke-active-${u.user_id}`}
                >
                  <Text style={[styles.grantBtnText, { color: Colors.danger }]}>
                    REVOKE
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))
        )}
      </View>

      {events.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Recent billing events</Text>
          {events.slice(0, 10).map((e) => (
            <View key={e.event_id} style={styles.miniRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{e.type}</Text>
                <Text style={styles.userEmail}>
                  user {e.user_id} · {e.plan_id || "—"}
                  {e.by_name ? ` · by ${e.by_name}` : ""}
                </Text>
              </View>
              <Text style={styles.timeText}>
                {e.created_at ? new Date(e.created_at).toLocaleString() : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

// ---------------- Roles tab ----------------
function RolesTab({
  roles,
  perms,
  users,
  isSuper,
  onCreated,
  onAssigned,
}: {
  roles: any[];
  perms: string[];
  users: UserRow[];
  isSuper: boolean;
  onCreated: () => void;
  onAssigned: () => void;
}) {
  const { notify } = useConfirm();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const togglePerm = (p: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const create = async () => {
    if (name.length < 2) return;
    setBusy(true);
    try {
      await api("/admin/roles", {
        body: { name, description: desc, permissions: Array.from(chosen) },
      });
      setName("");
      setDesc("");
      setChosen(new Set());
      onCreated();
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    } finally {
      setBusy(false);
    }
  };

  const matches = search
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(search.toLowerCase()) ||
          (u.name || "").toLowerCase().includes(search.toLowerCase())
      ).slice(0, 10)
    : [];

  const assign = async (target_user_id: string, role_id: string) => {
    try {
      await api("/admin/users/assign-role", { body: { target_user_id, role_id } });
      onAssigned();
      await notify("Role assigned", "User now has the new role permissions.");
    } catch (e: any) {
      await notify("Failed", e?.message || "Try again");
    }
  };

  return (
    <>
      {isSuper ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Create custom role</Text>
          <Text style={styles.sectionHint}>
            Build organizational roles like "Trust & Safety Lead" or "Recruitment".
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Role name (e.g. Trust & Safety Lead)"
            placeholderTextColor={Colors.textTertiary}
            style={styles.searchInput}
            testID="role-name-input"
          />
          <TextInput
            value={desc}
            onChangeText={setDesc}
            placeholder="Brief description (optional)"
            placeholderTextColor={Colors.textTertiary}
            style={styles.searchInput}
            testID="role-desc-input"
          />
          <Text style={[styles.sectionHint, { marginTop: 4 }]}>Permissions</Text>
          <View style={styles.permGrid}>
            {perms.map((p) => (
              <Pressable
                key={p}
                onPress={() => togglePerm(p)}
                style={[
                  styles.permChip,
                  chosen.has(p) && styles.permChipActive,
                ]}
                testID={`perm-${p}`}
              >
                <Text
                  style={[
                    styles.permChipText,
                    chosen.has(p) && { color: Colors.brandDeep, fontWeight: "700" },
                  ]}
                >
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={create}
            disabled={busy || name.length < 2}
            style={[
              styles.primaryBtn,
              (busy || name.length < 2) && { opacity: 0.5 },
            ]}
            testID="create-role-btn"
          >
            <Text style={styles.primaryBtnText}>
              {busy ? "Creating…" : "Create role"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Existing roles ({roles.length})</Text>
        {roles.length === 0 ? (
          <Text style={styles.sectionHint}>No custom roles yet.</Text>
        ) : (
          roles.map((r) => (
            <View key={r.role_id} style={styles.roleCard} testID={`role-${r.role_id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{r.name}</Text>
                {r.description ? (
                  <Text style={styles.userEmail}>{r.description}</Text>
                ) : null}
                <View style={styles.permGrid}>
                  {(r.permissions || []).map((p: string) => (
                    <View key={p} style={[styles.permChip, styles.permChipActive]}>
                      <Text
                        style={[
                          styles.permChipText,
                          { color: Colors.brandDeep, fontWeight: "700" },
                        ]}
                      >
                        {p}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          ))
        )}
      </View>

      {isSuper && roles.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Assign role to user</Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search user by email/name"
            placeholderTextColor={Colors.textTertiary}
            style={styles.searchInput}
            testID="role-assign-search"
            autoCapitalize="none"
          />
          {matches.map((u) => (
            <View key={u.user_id} style={styles.miniRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.userName}>{u.name}</Text>
                <Text style={styles.userEmail}>{u.email}</Text>
              </View>
              <ScrollView horizontal>
                {roles.map((r) => (
                  <Pressable
                    key={r.role_id}
                    style={styles.grantBtn}
                    onPress={() => assign(u.user_id, r.role_id)}
                    testID={`assign-${r.role_id}-${u.user_id}`}
                  >
                    <Text style={styles.grantBtnText}>+ {r.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

// ---------------- Analytics tab ----------------
function AnalyticsTab({ data }: { data: any }) {
  const cells = [
    { label: "Total users", value: data?.users?.total ?? 0, icon: "people-outline" },
    { label: "Verified", value: data?.users?.verified ?? 0, icon: "shield-checkmark-outline" },
    { label: "Premium", value: data?.users?.premium ?? 0, icon: "diamond-outline" },
    { label: "Suspended", value: data?.users?.suspended ?? 0, icon: "pause-circle-outline" },
    { label: "Blacklisted", value: data?.users?.blacklisted ?? 0, icon: "ban-outline" },
    { label: "Open reports", value: data?.reports?.open ?? 0, icon: "alert-circle-outline" },
    { label: "Active rooms", value: data?.rooms?.active ?? 0, icon: "cube-outline" },
    { label: "Rooms today", value: data?.rooms?.today ?? 0, icon: "today-outline" },
  ];
  return (
    <View style={styles.analyticsGrid}>
      {cells.map((c) => (
        <View key={c.label} style={styles.statCard} testID={`metric-${c.label}`}>
          <View style={styles.statIcon}>
            <Ionicons
              name={c.icon as any}
              size={18}
              color={Colors.brandPrimary}
            />
          </View>
          <Text style={styles.statNum}>{c.value}</Text>
          <Text style={styles.statLabel}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

function TabBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={`admin-tab-${label.toLowerCase()}`}
      style={[styles.tabBtn, active && styles.tabBtnActive]}
    >
      <Text style={[styles.tabBtnText, active && styles.tabBtnTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function RoleBadge({ role }: { role: string }) {
  let color = Colors.textSecondary;
  let bg = Colors.divider2;
  if (role === "super_admin") {
    color = Colors.brandDeep;
    bg = Colors.brandFog;
  } else if (role === "admin") {
    color = Colors.success;
    bg = Colors.successBg;
  }
  return (
    <View style={[styles.roleBadge, { backgroundColor: bg }]}>
      <Text style={[styles.roleBadgeText, { color }]}>
        {role.replace("_", " ").toUpperCase()}
      </Text>
    </View>
  );
}

function MetaPill({ label, status }: { label: string; status: string }) {
  let color = Colors.textSecondary;
  let bg = Colors.divider2;
  if (status === "active") {
    color = Colors.success;
    bg = Colors.successBg;
  }
  if (status === "warned" || status === "restricted") {
    color = Colors.warn;
    bg = Colors.warnBg;
  }
  if (status === "suspended" || status === "blacklisted") {
    color = Colors.danger;
    bg = Colors.dangerBg;
  }
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function ActBtn({
  icon,
  label,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "danger" | "success" | "default";
}) {
  let color = Colors.textSecondary;
  let bg = Colors.bg;
  if (tone === "danger") {
    color = Colors.danger;
    bg = Colors.dangerBg;
  }
  if (tone === "success") {
    color = Colors.success;
    bg = Colors.successBg;
  }
  return (
    <Pressable
      onPress={onPress}
      testID={`admin-action-${label.toLowerCase()}`}
      style={[styles.actBtn, { backgroundColor: bg }]}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text style={[styles.actBtnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.paper,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 11,
    color: Colors.textTertiary,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 8,
    paddingRight: 32,
  },
  tabBtn: {
    paddingHorizontal: 16,
    height: 40,
    borderRadius: Radii.pill,
    backgroundColor: Colors.paper,
    borderWidth: 1,
    borderColor: Colors.divider2,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBtnActive: { backgroundColor: Colors.brandFog, borderColor: "#7DD3FC" },
  tabBtnText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
  tabBtnTextActive: { color: Colors.brandDeep, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 80, gap: 12 },
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.divider2,
    gap: 8,
  },
  avatar: { width: 38, height: 38, borderRadius: 38, backgroundColor: Colors.divider2 },
  avatarFallback: {
    backgroundColor: Colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  userName: { fontSize: 14, fontWeight: "700", color: Colors.textPrimary },
  userEmail: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  roleBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radii.pill,
  },
  roleBadgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.6 },
  metaRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radii.pill,
  },
  pillText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.6 },
  actBar: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  actBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.pill,
  },
  actBtnText: { fontSize: 11, fontWeight: "600" },
  roleBar: { flexDirection: "row", gap: 6, marginTop: 4 },
  rolePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.pill,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  rolePillText: { fontSize: 11, color: Colors.textSecondary },
  reportReason: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.danger,
    letterSpacing: 0.4,
  },
  reportText: { fontSize: 13, color: Colors.textPrimary },
  reportDetails: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontStyle: "italic",
    backgroundColor: Colors.bg,
    padding: 8,
    borderRadius: 8,
  },
  reportTime: { fontSize: 11, color: Colors.textTertiary, marginTop: 4 },
  empty: { alignItems: "center", paddingVertical: 60, gap: 10 },
  emptyText: { color: Colors.textSecondary, fontSize: 14 },
});
