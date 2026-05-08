import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import Button from "../../src/components/Button";
import PinDots from "../../src/components/PinDots";
import { Colors, Radii } from "../../src/lib/theme";
import { api } from "../../src/lib/api";

type Step = "name" | "phrase" | "pin" | "type" | "review";
type RoomType = "duo" | "circle";

export default function CreateRoom() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("duo");
  const [busy, setBusy] = useState(false);

  const next = () => {
    if (step === "name") {
      if (name.trim().length < 2) return Alert.alert("Add a room name");
      setStep("phrase");
    } else if (step === "phrase") {
      if (phrase.trim().length < 3) return Alert.alert("Phrase too short");
      setStep("pin");
    } else if (step === "pin") {
      if (pin.length < 4) return Alert.alert("PIN must be 4–6 digits");
      setStep("type");
    } else if (step === "type") {
      setStep("review");
    }
  };

  const back = () => {
    if (step === "phrase") setStep("name");
    else if (step === "pin") setStep("phrase");
    else if (step === "type") setStep("pin");
    else if (step === "review") setStep("type");
    else router.back();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ room_id: string; name: string }>("/rooms/create", {
        body: { name, phrase, pin, room_type: roomType },
      });
      Alert.alert(
        "Room created",
        "Share the phrase + PIN with the people you trust. They will only see the room when they speak the phrase.",
        [
          {
            text: "Done",
            onPress: () => router.replace(`/room/${r.room_id}`),
          },
        ]
      );
    } catch (e: any) {
      Alert.alert("Could not create room", e?.message || "Try again");
    } finally {
      setBusy(false);
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
                  speak or type it.
                </Text>
                <TextInput
                  testID="room-phrase-input"
                  value={phrase}
                  onChangeText={setPhrase}
                  placeholder="e.g. silver ocean tonight"
                  placeholderTextColor={Colors.textTertiary}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button
                  testID="step-next-phrase"
                  label="Continue"
                  onPress={next}
                  icon="arrow-forward"
                />
              </View>
            )}

            {step === "pin" && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Step 3 / 4 — Room PIN</Text>
                <Text style={styles.cardHint}>
                  4–6 digits. Same phrase + different PIN = a separate room.
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
                  <Text style={styles.reviewLabel}>PIN</Text>
                  <Text style={styles.reviewValue}>{"•".repeat(pin.length)}</Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Type</Text>
                  <Text style={styles.reviewValue}>
                    {roomType === "duo" ? "Duo" : "Circle"}
                  </Text>
                </View>
                <Text style={[styles.cardHint, { marginTop: 12 }]}>
                  Phrase and PIN are stored as one-way hashes. We can't recover them.
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
