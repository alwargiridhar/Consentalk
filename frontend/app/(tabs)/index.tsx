import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import MicrophoneOrb from "../../src/components/MicrophoneOrb";
import PinDots from "../../src/components/PinDots";
import Button from "../../src/components/Button";
import Logo from "../../src/components/Logo";
import { Colors, Radii } from "../../src/lib/theme";
import { api, backendUrl, getStoredToken } from "../../src/lib/api";
import { useAuth } from "../../src/contexts/AuthContext";

type Step = "idle" | "phrase" | "pin" | "summoning" | "results";

interface RoomCard {
  room_id: string;
  name: string;
  room_type: string;
}

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [step, setStep] = useState<Step>("idle");
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [results, setResults] = useState<RoomCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const phraseRef = useRef<TextInput | null>(null);

  const reset = () => {
    setStep("idle");
    setPhrase("");
    setPin("");
    setResults([]);
    setError(null);
  };

  const startListening = async () => {
    if (Platform.OS === "ios" || Platform.OS === "android") {
      try {
        const perm = await Audio.requestPermissionsAsync();
        if (!perm.granted) {
          setError("Microphone permission denied. You can type the phrase instead.");
          setStep("phrase");
          return;
        }
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
        const rec = new Audio.Recording();
        await rec.prepareToRecordAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );
        await rec.startAsync();
        setRecording(rec);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      } catch (e: any) {
        setError(e?.message || "Could not start recording");
        setStep("phrase");
        return;
      }
    }
    // web fallback: type the phrase
    setStep("phrase");
    setTimeout(() => phraseRef.current?.focus(), 50);
  };

  const stopListeningAndTranscribe = async () => {
    if (!recording) {
      setStep("phrase");
      return;
    }
    try {
      setTranscribing(true);
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      if (!uri) throw new Error("No recording URI");
      const form = new FormData();
      // @ts-ignore RN FormData
      form.append("file", {
        uri,
        name: "phrase.m4a",
        type: "audio/m4a",
      } as any);
      const token = await getStoredToken();
      const res = await fetch(`${backendUrl()}/api/voice/transcribe`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
      const j = (await res.json()) as { text?: string };
      const text = (j.text || "").trim();
      if (!text) throw new Error("Could not detect a phrase. Please type instead.");
      setPhrase(text);
      setStep("pin");
    } catch (e: any) {
      setError(e?.message || "Transcription failed");
      setStep("phrase");
    } finally {
      setTranscribing(false);
    }
  };

  const onMicPress = async () => {
    setError(null);
    if (recording) {
      await stopListeningAndTranscribe();
      return;
    }
    if (step === "idle") {
      setStep("phrase");
      await startListening();
    } else {
      await startListening();
    }
  };

  const onTypePhrase = () => {
    setError(null);
    setStep("phrase");
    setTimeout(() => phraseRef.current?.focus(), 50);
  };

  const onPhraseContinue = () => {
    if (phrase.trim().length < 3) {
      setError("Phrase must be at least 3 characters.");
      return;
    }
    setError(null);
    setStep("pin");
  };

  const onPinKey = (digit: string) => {
    if (digit === "back") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (pin.length >= 6) return;
    setPin((p) => p + digit);
  };

  const summon = async () => {
    if (pin.length < 4) {
      setError("PIN must be 4–6 digits.");
      return;
    }
    setError(null);
    setBusy(true);
    setStep("summoning");
    try {
      const r = await api<{ rooms: RoomCard[] }>("/rooms/summon", {
        body: { phrase, pin },
      });
      setResults(r.rooms || []);
      setStep("results");
    } catch (e: any) {
      setError(e?.message || "Summoning failed");
      setStep("results");
    } finally {
      setBusy(false);
    }
  };

  const pinKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

  return (
    <AmbientBackground>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <View style={styles.header}>
            <Logo size={32} showWordmark />
            <Pressable
              testID="header-create-room"
              onPress={() => router.push("/room/create")}
              style={styles.headerBtn}
            >
              <Ionicons name="add" size={18} color={Colors.brandPrimary} />
              <Text style={styles.headerBtnText}>Create</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {step !== "results" ? (
              <View style={styles.stage}>
                <Text style={styles.greet}>Hello, {user?.name?.split(" ")[0] ?? "Friend"}.</Text>
                <Text style={styles.prompt}>Speak your phrase</Text>
                <View style={{ height: 18 }} />
                <MicrophoneOrb
                  active={!!recording || transcribing}
                  onPress={onMicPress}
                  testID="mic-orb"
                />
                <View style={{ height: 12 }} />
                {transcribing ? (
                  <View style={styles.row}>
                    <ActivityIndicator color={Colors.brandPrimary} />
                    <Text style={styles.helper}>Listening with care…</Text>
                  </View>
                ) : (
                  <Text style={styles.helper}>
                    {recording
                      ? "Tap again to stop and verify"
                      : "Rooms only appear when summoned."}
                  </Text>
                )}

                {step === "phrase" || step === "pin" ? (
                  <View style={styles.summonCard}>
                    <Text style={styles.cardTitle}>Phrase</Text>
                    <TextInput
                      ref={phraseRef}
                      testID="phrase-input"
                      placeholder="e.g. silver ocean tonight"
                      placeholderTextColor={Colors.textTertiary}
                      value={phrase}
                      onChangeText={setPhrase}
                      style={styles.input}
                      autoCorrect={false}
                      autoCapitalize="none"
                    />
                    {step === "pin" ? (
                      <>
                        <Text style={[styles.cardTitle, { marginTop: 16 }]}>Room PIN</Text>
                        <PinDots length={6} filled={pin.length} testID="summon-pin-dots" />
                        <View style={styles.pinPad}>
                          {pinKeys.map((k, idx) => {
                            if (k === "") return <View key={idx} style={styles.pinKey} />;
                            return (
                              <Pressable
                                key={idx}
                                onPress={() => onPinKey(k)}
                                style={({ pressed }) => [
                                  styles.pinKey,
                                  pressed && { opacity: 0.6 },
                                ]}
                                testID={`pin-key-${k}`}
                              >
                                {k === "back" ? (
                                  <Ionicons
                                    name="backspace-outline"
                                    size={20}
                                    color={Colors.textSecondary}
                                  />
                                ) : (
                                  <Text style={styles.pinKeyText}>{k}</Text>
                                )}
                              </Pressable>
                            );
                          })}
                        </View>
                        <Button
                          testID="summon-btn"
                          label={busy ? "Summoning…" : "Summon room"}
                          icon="sparkles-outline"
                          loading={busy}
                          onPress={summon}
                        />
                      </>
                    ) : (
                      <Button
                        testID="phrase-continue-btn"
                        label="Continue"
                        icon="arrow-forward"
                        onPress={onPhraseContinue}
                        style={{ marginTop: 14 }}
                      />
                    )}
                    {error ? (
                      <Text style={styles.error} testID="summon-error">
                        {error}
                      </Text>
                    ) : null}
                  </View>
                ) : (
                  <Pressable
                    testID="type-phrase-btn"
                    onPress={onTypePhrase}
                    style={styles.typeBtn}
                  >
                    <Ionicons
                      name="create-outline"
                      size={16}
                      color={Colors.textSecondary}
                    />
                    <Text style={styles.typeBtnText}>Type instead</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <View style={styles.resultsWrap}>
                <Text style={styles.greet}>
                  {results.length > 0
                    ? "These rooms appeared."
                    : "No room responded."}
                </Text>
                <Text style={styles.helper}>
                  {results.length > 0
                    ? "Tap to enter. Rooms close when everyone leaves."
                    : "Phrase, PIN, or membership did not match. Try again."}
                </Text>
                {results.map((r) => (
                  <Pressable
                    key={r.room_id}
                    testID={`room-card-${r.room_id}`}
                    onPress={() => {
                      Haptics.selectionAsync();
                      router.push(`/room/${r.room_id}`);
                    }}
                    style={styles.roomCard}
                  >
                    <View style={styles.roomIcon}>
                      <Ionicons
                        name={r.room_type === "duo" ? "people-outline" : "people-circle-outline"}
                        color={Colors.brandPrimary}
                        size={22}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.roomName}>{r.name}</Text>
                      <Text style={styles.roomMeta}>
                        {r.room_type.toUpperCase()} ROOM • TAP TO ENTER
                      </Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={Colors.textTertiary}
                    />
                  </Pressable>
                ))}
                <Button
                  label="Try another phrase"
                  icon="refresh-outline"
                  variant="secondary"
                  onPress={reset}
                  style={{ marginTop: 18 }}
                />
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.brandFog,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  headerBtnText: { color: Colors.brandPrimary, fontWeight: "600", fontSize: 13 },
  scroll: { padding: 24, paddingBottom: 64 },
  stage: { alignItems: "center", paddingTop: 12 },
  greet: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.textPrimary,
    letterSpacing: -0.4,
  },
  prompt: {
    marginTop: 6,
    fontSize: 13,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: Colors.brandPrimary,
    fontWeight: "600",
  },
  helper: {
    marginTop: 6,
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  typeBtn: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: Colors.paper,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  typeBtnText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "500" },
  summonCard: {
    marginTop: 28,
    width: "100%",
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 22,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  cardTitle: {
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: Colors.textTertiary,
    fontWeight: "700",
    marginBottom: 8,
  },
  input: {
    height: 52,
    borderRadius: Radii.lg,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 16,
    color: Colors.textPrimary,
    fontSize: 16,
  },
  pinPad: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 12,
  },
  pinKey: {
    width: "30%",
    height: 56,
    borderRadius: Radii.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  pinKeyText: { fontSize: 22, color: Colors.textPrimary, fontWeight: "600" },
  error: { color: Colors.danger, marginTop: 12, fontSize: 13, textAlign: "center" },
  resultsWrap: { paddingTop: 16 },
  roomCard: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  roomIcon: {
    width: 44,
    height: 44,
    borderRadius: 44,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  roomName: { fontSize: 16, fontWeight: "600", color: Colors.textPrimary },
  roomMeta: {
    fontSize: 11,
    color: Colors.textTertiary,
    letterSpacing: 1.2,
    marginTop: 2,
  },
});
