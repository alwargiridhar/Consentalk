import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Audio } from "expo-av";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import Button from "../../src/components/Button";
import PinDots from "../../src/components/PinDots";
import { Colors, Radii } from "../../src/lib/theme";
import { api, backendUrl, getStoredToken } from "../../src/lib/api";
import { useConfirm } from "../../src/contexts/ConfirmContext";
import { startWebRecorder, blobFilename, WebRecorder } from "../../src/lib/webRecorder";

type Step = "name" | "phrase" | "mode" | "pin" | "type" | "review";
type RoomType = "duo" | "circle";
type SecurityMode = "light" | "deep";
type RetentionMode = "5min" | "10min" | "15min" | "on_refresh";
const RETENTION_LABELS: Record<RetentionMode, string> = {
  "5min": "5 minutes after read",
  "10min": "10 minutes after read",
  "15min": "15 minutes after read",
  on_refresh: "Only when wiped or refreshed",
};

export default function CreateRoom() {
  const router = useRouter();
  const { notify } = useConfirm();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("duo");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("light");
  const [retentionMode, setRetentionMode] = useState<RetentionMode>("10min");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const webRecRef = useRef<WebRecorder | null>(null);
  const [webRecording, setWebRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const next = async () => {
    if (step === "name") {
      if (name.trim().length < 2) return notify("Add a room name");
      setStep("phrase");
    } else if (step === "phrase") {
      if (phrase.trim().length < 3) return notify("Phrase too short");
      setStep("mode");
    } else if (step === "mode") {
      if (securityMode === "deep") setStep("pin");
      else setStep("type");
    } else if (step === "pin") {
      if (pin.length < 4) return notify("PIN must be 4–6 digits");
      setStep("type");
    } else if (step === "type") {
      setStep("review");
    }
  };

  const back = () => {
    if (step === "phrase") setStep("name");
    else if (step === "mode") setStep("phrase");
    else if (step === "pin") setStep("mode");
    else if (step === "type") setStep(securityMode === "deep" ? "pin" : "mode");
    else if (step === "review") setStep("type");
    else router.back();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body: any = {
        name,
        phrase,
        room_type: roomType,
        security_mode: securityMode,
        retention_mode: retentionMode,
      };
      if (securityMode === "deep") body.pin = pin;
      const r = await api<{ room_id: string; name: string }>("/rooms/create", {
        body,
      });
      await notify(
        "Room created",
        securityMode === "light"
          ? "Share the phrase with the people you trust. They'll request access; you approve or reject from inside the room."
          : "Share the phrase + PIN with the people you trust. They will only see the room when they speak the phrase."
      );
      router.replace(`/room/${r.room_id}`);
    } catch (e: any) {
      const msg = e?.message || "Try again";
      if (msg.includes("Room already allocated") || msg.includes("already used")) {
        await notify(
          "Phrase already taken",
          "Room already allocated. Please use a more unique phrase. Try adding more words for uniqueness."
        );
        setStep("phrase");
      } else {
        await notify("Could not create room", msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const startVoice = async () => {
    if (Platform.OS === "web") {
      try {
        const rec = await startWebRecorder();
        webRecRef.current = rec;
        setWebRecording(true);
      } catch (e: any) {
        await notify(
          "Microphone unavailable",
          e?.message || "Please type the phrase instead."
        );
      }
      return;
    }
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        await notify("Permission denied", "Please type the phrase instead.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(rec);
    } catch (e: any) {
      await notify("Could not start recording", e?.message || "Try again");
    }
  };

  const stopVoiceAndTranscribe = async () => {
    setTranscribing(true);
    try {
      let blob: Blob | null = null;
      let filename = "phrase.m4a";
      if (Platform.OS === "web" && webRecRef.current) {
        const rec = webRecRef.current;
        webRecRef.current = null;
        setWebRecording(false);
        blob = await rec.stop();
        filename = blobFilename(blob);
      } else if (recording) {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        setRecording(null);
        if (!uri) throw new Error("No recording URI");
        const form = new FormData();
        // @ts-ignore RN file payload
        form.append("file", { uri, name: "phrase.m4a", type: "audio/m4a" } as any);
        const token = await getStoredToken();
        const res = await fetch(`${backendUrl()}/api/voice/transcribe`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: form,
        });
        if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
        const j = (await res.json()) as { text?: string };
        const text = (j.text || "").trim();
        if (text) setPhrase(text);
        else await notify("Could not detect phrase", "Please type instead.");
        return;
      } else {
        return;
      }
      const form = new FormData();
      form.append("file", blob, filename);
      const token = await getStoredToken();
      const res = await fetch(`${backendUrl()}/api/voice/transcribe`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
      const j = (await res.json()) as { text?: string };
      const text = (j.text || "").trim();
      if (text) setPhrase(text);
      else await notify("Could not detect phrase", "Please type instead.");
    } catch (e: any) {
      await notify("Transcription failed", e?.message || "Please type instead.");
    } finally {
      setTranscribing(false);
    }
  };

  const onMicTap = async () => {
    if (recording || webRecording) {
      await stopVoiceAndTranscribe();
    } else {
      await startVoice();
    }
  };

  const onPinKey = (digit: string) => {
    if (digit === "back") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (pin.length >= 6) return;
    setPin((p) => p + digit);
  };
  const pinKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
  const isRecording = !!recording || webRecording;

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <View style={styles.header}>
            <Pressable
              onPress={back}
              style={styles.backBtn}
              testID="create-back"
            >
              <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.heading}>Create Room</Text>
            <View style={{ width: 36 }} />
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {step === "name" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 1 / 4 — Name</Text>
                <Text style={styles.cardHint}>
                  Just for you. Members never see this externally.
                </Text>
                <TextInput
                  testID="room-name-input"
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g. Saturday Walks with Mei"
                  placeholderTextColor={Colors.textTertiary}
                  style={styles.input}
                />
                <Button
                  testID="step-next-name"
                  label="Continue"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "phrase" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 2 / 4 — Phrase</Text>
                <Text style={styles.cardHint}>
                  Pick a calm, memorable phrase. The room will only appear when you
                  speak or type it. You can record your voice or type it.
                </Text>
                <View style={styles.phraseRow}>
                  <TextInput
                    testID="room-phrase-input"
                    value={phrase}
                    onChangeText={setPhrase}
                    placeholder={transcribing ? "Transcribing…" : "e.g. silver ocean tonight"}
                    placeholderTextColor={Colors.textTertiary}
                    style={[styles.input, { flex: 1 }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!transcribing}
                  />
                  <Pressable
                    testID="phrase-mic-btn"
                    onPress={onMicTap}
                    disabled={transcribing}
                    style={[
                      styles.micBtn,
                      isRecording && styles.micBtnActive,
                      transcribing && { opacity: 0.5 },
                    ]}
                  >
                    {transcribing ? (
                      <ActivityIndicator color={Colors.brandPrimary} />
                    ) : (
                      <Ionicons
                        name={isRecording ? "stop-circle" : "mic"}
                        size={22}
                        color={isRecording ? Colors.danger : Colors.brandPrimary}
                      />
                    )}
                  </Pressable>
                </View>
                {isRecording ? (
                  <Text style={styles.recHint} testID="recording-hint">
                    Recording — tap the stop icon when done.
                  </Text>
                ) : null}
                <Button
                  testID="step-next-phrase"
                  label="Continue"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "mode" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 3 — Security mode</Text>
                <Text style={styles.cardHint}>
                  Light is open — anyone with the phrase can request access and
                  you approve. Deep also requires a secret PIN for entry.
                </Text>
                {(["light", "deep"] as SecurityMode[]).map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setSecurityMode(m)}
                    style={[
                      styles.roomTypeCard,
                      securityMode === m && styles.roomTypeCardActive,
                    ]}
                    testID={`security-mode-${m}`}
                  >
                    <View style={styles.roomTypeIcon}>
                      <Ionicons
                        name={m === "light" ? "leaf-outline" : "lock-closed-outline"}
                        size={26}
                        color={Colors.brandPrimary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.roomTypeTitle}>
                        {m === "light" ? "Light · Consentalk" : "Deep · Presence Vault"}
                      </Text>
                      <Text style={styles.roomTypeText}>
                        {m === "light"
                          ? "Phrase only. Join requests need your approval."
                          : "Phrase + PIN. Members never need to ask twice."}
                      </Text>
                    </View>
                    <Ionicons
                      name={securityMode === m ? "radio-button-on" : "radio-button-off"}
                      color={securityMode === m ? Colors.brandPrimary : Colors.textTertiary}
                      size={22}
                    />
                  </Pressable>
                ))}
                <Button
                  testID="step-next-mode"
                  label="Continue"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "pin" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 4 — Room PIN</Text>
                <Text style={styles.cardHint}>
                  4–6 digits. Required for Deep mode.
                </Text>
                <PinDots length={6} filled={pin.length} testID="create-pin-dots" />
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
                        testID={`create-pin-${k}`}
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
                  testID="step-next-pin"
                  label="Continue"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "type" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 4 / 4 — Room Shape</Text>
                <Text style={styles.cardHint}>
                  Duo is a 1-to-1 calm space. Circle holds up to 8 trusted members.
                </Text>
                {(["duo", "circle"] as RoomType[]).map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setRoomType(t)}
                    style={[
                      styles.roomTypeCard,
                      roomType === t && styles.roomTypeCardActive,
                    ]}
                    testID={`room-type-${t}`}
                  >
                    <View style={styles.roomTypeIcon}>
                      <Ionicons
                        name={t === "duo" ? "people-outline" : "people-circle-outline"}
                        size={26}
                        color={Colors.brandPrimary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.roomTypeTitle}>
                        {t === "duo" ? "Duo Room" : "Circle Room"}
                      </Text>
                      <Text style={styles.roomTypeText}>
                        {t === "duo"
                          ? "1 + 1 — for one trusted other."
                          : "Up to 8 trusted people."}
                      </Text>
                    </View>
                    <Ionicons
                      name={roomType === t ? "radio-button-on" : "radio-button-off"}
                      color={roomType === t ? Colors.brandPrimary : Colors.textTertiary}
                      size={22}
                    />
                  </Pressable>
                ))}
                <Button
                  testID="step-next-type"
                  label="Review"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "review" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Review</Text>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Name</Text>
                  <Text style={styles.reviewValue}>{name}</Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Phrase</Text>
                  <Text style={styles.reviewValue}>{phrase}</Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Mode</Text>
                  <Text style={styles.reviewValue}>
                    {securityMode === "light" ? "Light (phrase only)" : "Deep (phrase + PIN)"}
                  </Text>
                </View>
                {securityMode === "deep" ? (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>PIN</Text>
                    <Text style={styles.reviewValue}>{"•".repeat(pin.length)}</Text>
                  </View>
                ) : null}
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Type</Text>
                  <Text style={styles.reviewValue}>
                    {roomType === "duo" ? "Duo" : "Circle"}
                  </Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Retention</Text>
                  <Text style={styles.reviewValue}>
                    {RETENTION_LABELS[retentionMode]}
                  </Text>
                </View>

                <View style={{ marginTop: 8, gap: 8 }}>
                  <Text style={styles.cardHint}>Change retention if you want:</Text>
                  {(["5min", "10min", "15min", "on_refresh"] as RetentionMode[]).map(
                    (m) => {
                      const active = retentionMode === m;
                      return (
                        <Pressable
                          key={m}
                          onPress={() => setRetentionMode(m)}
                          style={[
                            styles.roomTypeCard,
                            active && styles.roomTypeCardActive,
                          ]}
                          testID={`retention-${m}`}
                        >
                          <View style={styles.roomTypeIcon}>
                            <Ionicons
                              name={
                                m === "on_refresh"
                                  ? "refresh-outline"
                                  : "time-outline"
                              }
                              size={20}
                              color={Colors.brandPrimary}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.roomTypeTitle}>
                              {RETENTION_LABELS[m]}
                            </Text>
                            <Text style={styles.roomTypeText}>
                              {m === "on_refresh"
                                ? "Messages stay until anyone taps the 🔄 wipe button."
                                : `Auto-deleted ${m.replace("min", "")} min after the other person reads.`}
                            </Text>
                          </View>
                          <Ionicons
                            name={active ? "radio-button-on" : "radio-button-off"}
                            color={active ? Colors.brandPrimary : Colors.textTertiary}
                            size={22}
                          />
                        </Pressable>
                      );
                    }
                  )}
                </View>

                <Text style={[styles.cardHint, { marginTop: 12 }]}>
                  Phrase{securityMode === "deep" ? " and PIN are" : " is"} stored as one-way hash{securityMode === "deep" ? "es" : ""}. We can't recover them.
                </Text>
                <Button
                  testID="create-room-submit"
                  label={busy ? "Creating…" : "Create Room"}
                  loading={busy}
                  onPress={submit}
                  icon="sparkles-outline"
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
  heading: { fontSize: 17, fontWeight: "700", color: Colors.textPrimary },
  scroll: { padding: 24, paddingBottom: 80 },
  card: {
    backgroundColor: Colors.paper,
    borderRadius: Radii.xl,
    padding: 22,
    borderWidth: 1,
    borderColor: Colors.divider2,
    gap: 12,
  },
  cardTitle: {
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: Colors.brandPrimary,
    fontWeight: "700",
  },
  cardHint: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20 },
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
    marginTop: 12,
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
  phraseRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  micBtn: {
    width: 52,
    height: 52,
    borderRadius: 52,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.brandFog,
    borderWidth: 1,
    borderColor: "#BAE6FD",
  },
  micBtnActive: {
    backgroundColor: Colors.dangerBg,
    borderColor: "#FECACA",
  },
  recHint: {
    color: Colors.danger,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
  },
  roomTypeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    backgroundColor: Colors.bg,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  roomTypeCardActive: {
    backgroundColor: Colors.brandFog,
    borderColor: "#7DD3FC",
  },
  roomTypeIcon: {
    width: 44,
    height: 44,
    borderRadius: 44,
    backgroundColor: Colors.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  roomTypeTitle: { fontSize: 15, fontWeight: "600", color: Colors.textPrimary },
  roomTypeText: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider2,
  },
  reviewLabel: { color: Colors.textTertiary, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", fontWeight: "700" },
  reviewValue: { color: Colors.textPrimary, fontSize: 14, fontWeight: "500", maxWidth: "60%", textAlign: "right" },
});
