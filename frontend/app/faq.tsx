import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../src/components/AmbientBackground";
import { Colors, Radii } from "../src/lib/theme";

const FAQ = [
  {
    q: "What is Consentalk?",
    a: "A privacy-first communication platform designed for intentional, temporary, and consent-based conversations. Rooms appear only when authenticated users intentionally unlock them using shared phrases and secure verification.",
  },
  {
    q: "Is Consentalk anonymous?",
    a: "No. Consentalk protects conversational privacy while maintaining internal accountability systems designed to reduce abuse and harmful activity.",
  },
  {
    q: "Are conversations permanently stored?",
    a: "No. User-visible conversations disappear after sessions end. Limited encrypted forensic retention may exist for lawful safety procedures.",
  },
  {
    q: "Can anyone discover my rooms?",
    a: "No. Rooms are invisible by default and only appear for authenticated members with the correct phrase and PIN.",
  },
  {
    q: "Why use voice phrases?",
    a: "Voice phrases create intentional, human-centered access while reducing accidental exposure and strengthening emotional privacy.",
  },
  {
    q: "Can users leave instantly?",
    a: "Yes. Any participant can end and exit a room immediately if they feel unsafe or uncomfortable.",
  },
  {
    q: "Does Consentalk support illegal activity?",
    a: "No. Harassment, coercion, stalking, terrorism, trafficking, exploitation, violent extremism and other illegal activity are not supported on Consentalk.",
  },
  {
    q: "Is Consentalk constantly monitored?",
    a: "No. Safety systems activate only under severe abuse indicators or lawful review processes.",
  },
  {
    q: "What makes Consentalk different?",
    a: "Intentional access, invisible rooms, temporary communication, voice-triggered presence, and consent-based interaction.",
  },
];

export default function FaqScreen() {
  const router = useRouter();
  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <Text style={styles.title}>Trust & Safety</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.intro}>
            Consentalk is built on a simple belief: private human conversations
            deserve dignity, consent, and protection.
          </Text>
          {FAQ.map((f, i) => (
            <View key={i} style={styles.card}>
              <Text style={styles.q}>{f.q}</Text>
              <Text style={styles.a}>{f.a}</Text>
            </View>
          ))}
          <View style={styles.cardOutline}>
            <Text style={styles.q}>Our promise</Text>
            <Text style={styles.a}>
              We will never sell your data, run ad-surveillance, or design
              addictive engagement loops. Privacy should empower human
              dignity — not shield abuse.
            </Text>
          </View>
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
  intro: {
    fontSize: 15,
    color: Colors.textSecondary,
    lineHeight: 22,
    marginBottom: 16,
  },
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 18,
    borderWidth: 1,
    borderColor: Colors.divider2,
    marginBottom: 12,
  },
  cardOutline: {
    backgroundColor: Colors.brandFog,
    borderRadius: Radii.xl,
    padding: 18,
    borderWidth: 1,
    borderColor: "#BAE6FD",
    marginTop: 8,
  },
  q: { color: Colors.textPrimary, fontWeight: "700", fontSize: 14, marginBottom: 6 },
  a: { color: Colors.textSecondary, fontSize: 14, lineHeight: 21 },
});
