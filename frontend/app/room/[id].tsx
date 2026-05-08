import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Alert,
  Image,
  ActivityIndicator,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Audio } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { SafeAreaView } from "react-native-safe-area-context";
import AmbientBackground from "../../src/components/AmbientBackground";
import { Colors, Radii } from "../../src/lib/theme";
import { api, getStoredToken, wsUrl } from "../../src/lib/api";
import { useAuth } from "../../src/contexts/AuthContext";

interface Member {
  user_id: string;
  name: string;
  picture?: string;
  verified: boolean;
  is_owner: boolean;
}

interface Message {
  message_id: string;
  room_id: string;
  sender_user_id: string;
  sender_name: string;
  sender_picture?: string;
  content_type: "text" | "voice" | "image";
  content: string;
  created_at: string;
}

interface RoomData {
  room_id: string;
  name: string;
  room_type: string;
  owner_user_id: string;
  members_detail: Member[];
}

export default function RoomChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [audioPlayer, setAudioPlayer] = useState<Audio.Sound | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api<RoomData>(`/rooms/${id}`);
      setRoom(r);
      const m = await api<{ messages: Message[] }>(`/rooms/${id}/messages`);
      setMessages(m.messages || []);
    } catch (e: any) {
      Alert.alert("Couldn't open room", e?.message || "Try again");
      router.back();
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  // websocket
  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      const token = await getStoredToken();
      if (!token) return;
      try {
        const ws = new WebSocket(wsUrl(id, token));
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (data.type === "message" && data.message) {
              setMessages((prev) => {
                if (prev.some((m) => m.message_id === data.message.message_id)) {
                  return prev;
                }
                return [...prev, data.message];
              });
              setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
            }
          } catch {}
        };
        ws.onclose = () => {};
        wsRef.current = ws;
      } catch {}
    })();
    return () => {
      alive = false;
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [id]);

  const send = async (override?: { content_type: string; content: string }) => {
    const payload = override ?? { content_type: "text", content: draft.trim() };
    if (!payload.content) return;
    setSending(true);
    try {
      const m = await api<Message>(`/rooms/${id}/messages`, { body: payload });
      setMessages((prev) => {
        if (prev.some((p) => p.message_id === m.message_id)) return prev;
        return [...prev, m];
      });
      if (!override) setDraft("");
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e: any) {
      Alert.alert("Couldn't send", e?.message || "Try again");
    } finally {
      setSending(false);
    }
  };

  const toggleVoice = async () => {
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
        const uri = recording.getURI();
        setRecording(null);
        if (!uri) return;
        const b64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
        const dataUri = `data:audio/m4a;base64,${b64}`;
        await send({ content_type: "voice", content: dataUri });
      } catch (e: any) {
        Alert.alert("Voice error", e?.message || "Try again");
      }
      return;
    }
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      Alert.alert("Voice notes are available on the mobile app");
      return;
    }
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Microphone permission needed");
      return;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await rec.startAsync();
    setRecording(rec);
  };

  const playVoice = async (m: Message) => {
    try {
      if (audioPlayer) {
        await audioPlayer.unloadAsync();
        setAudioPlayer(null);
      }
      const { sound } = await Audio.Sound.createAsync({ uri: m.content });
      setAudioPlayer(sound);
      setPlayingId(m.message_id);
      sound.setOnPlaybackStatusUpdate((st: any) => {
        if (st.didJustFinish) {
          setPlayingId(null);
          sound.unloadAsync();
          setAudioPlayer(null);
        }
      });
      await sound.playAsync();
    } catch (e: any) {
      Alert.alert("Couldn't play", e?.message || "Try again");
    }
  };

  const pickImage = async () => {
    const r = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!r.granted) {
      Alert.alert("Permission needed");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.5,
    });
    if (res.canceled) return;
    const asset = res.assets?.[0];
    if (!asset) return;
    const b64 =
      asset.base64 ||
      (asset.uri
        ? await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" })
        : "");
    if (!b64) return;
    const dataUri = `data:${asset.mimeType || "image/jpeg"};base64,${b64}`;
    await send({ content_type: "image", content: dataUri });
  };

  const endConversation = () => {
    Alert.alert(
      "End conversation?",
      "All messages in this room will be wiped immediately. The room will close for everyone here.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End now",
          style: "destructive",
          onPress: async () => {
            setEndBusy(true);
            try {
              await api(`/rooms/${id}/end`, { method: "POST" });
              router.replace("/(tabs)");
            } catch (e: any) {
              Alert.alert("Couldn't end", e?.message || "Try again");
            } finally {
              setEndBusy(false);
            }
          },
        },
      ]
    );
  };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviteBusy(true);
    try {
      await api(`/rooms/${id}/invite`, { body: { email: inviteEmail.trim() } });
      setInviteEmail("");
      setShowInvite(false);
      Alert.alert(
        "Invite sent",
        "If they have a Consentalk account, they'll see the invitation."
      );
    } catch (e: any) {
      Alert.alert("Couldn't invite", e?.message || "Try again");
    } finally {
      setInviteBusy(false);
    }
  };

  const isOwner = room && room.owner_user_id === user?.user_id;

  return (
    <AmbientBackground>
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <View style={styles.header}>
            <Pressable
              testID="room-back"
              style={styles.iconBtn}
              onPress={() => router.back()}
            >
              <Ionicons name="chevron-back" size={20} color={Colors.textSecondary} />
            </Pressable>
            <View style={{ flex: 1, alignItems: "center" }}>
              <Text style={styles.title} numberOfLines={1}>
                {room?.name || "…"}
              </Text>
              <Text style={styles.subtitle}>
                {room?.room_type?.toUpperCase()} • {room?.members_detail?.length ?? 0}{" "}
                MEMBERS • EPHEMERAL
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {isOwner ? (
                <Pressable
                  testID="invite-btn"
                  style={styles.iconBtn}
                  onPress={() => setShowInvite(true)}
                >
                  <Ionicons name="person-add-outline" size={18} color={Colors.brandPrimary} />
                </Pressable>
              ) : null}
              <Pressable
                testID="force-exit-btn"
                style={[styles.iconBtn, styles.dangerBtn]}
                onPress={endConversation}
                disabled={endBusy}
              >
                <Ionicons name="exit-outline" size={18} color={Colors.danger} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            <View style={styles.banner} testID="ephemeral-banner">
              <Ionicons name="time-outline" size={14} color={Colors.brandPrimary} />
              <Text style={styles.bannerText}>
                Messages disappear when this conversation ends.
              </Text>
            </View>

            {messages.map((m) => {
              const me = m.sender_user_id === user?.user_id;
              return (
                <View
                  key={m.message_id}
                  style={[
                    styles.msgRow,
                    { justifyContent: me ? "flex-end" : "flex-start" },
                  ]}
                  testID={`msg-${m.message_id}`}
                >
                  {!me && (
                    <View style={styles.avatarSm}>
                      {m.sender_picture ? (
                        <Image
                          source={{ uri: m.sender_picture }}
                          style={{ width: 28, height: 28, borderRadius: 28 }}
                        />
                      ) : (
                        <Ionicons
                          name="person-outline"
                          size={14}
                          color={Colors.textSecondary}
                        />
                      )}
                    </View>
                  )}
                  <View
                    style={[
                      styles.bubble,
                      me ? styles.bubbleSent : styles.bubbleRecv,
                    ]}
                  >
                    {!me && (
                      <Text style={styles.bubbleSender}>{m.sender_name}</Text>
                    )}
                    {m.content_type === "text" ? (
                      <Text
                        style={[
                          styles.bubbleText,
                          { color: me ? "#FFFFFF" : Colors.textPrimary },
                        ]}
                      >
                        {m.content}
                      </Text>
                    ) : m.content_type === "image" ? (
                      <Image
                        source={{ uri: m.content }}
                        style={styles.imageMsg}
                        resizeMode="cover"
                      />
                    ) : (
                      <Pressable
                        style={[
                          styles.voiceBtn,
                          {
                            backgroundColor: me
                              ? "rgba(255,255,255,0.18)"
                              : Colors.brandFog,
                          },
                        ]}
                        onPress={() => playVoice(m)}
                      >
                        <Ionicons
                          name={
                            playingId === m.message_id ? "pause" : "play"
                          }
                          size={16}
                          color={me ? "#FFFFFF" : Colors.brandPrimary}
                        />
                        <Text
                          style={[
                            styles.voiceText,
                            { color: me ? "#FFFFFF" : Colors.brandPrimary },
                          ]}
                        >
                          Voice note
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.composer}>
            <Pressable
              testID="image-btn"
              style={styles.compIcon}
              onPress={pickImage}
            >
              <Ionicons name="image-outline" size={20} color={Colors.brandPrimary} />
            </Pressable>
            <View style={styles.inputWrap}>
              <TextInput
                testID="msg-input"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Speak gently…"
                placeholderTextColor={Colors.textTertiary}
                multiline
              />
            </View>
            <Pressable
              testID="voice-btn"
              style={[styles.compIcon, recording && { backgroundColor: Colors.dangerBg }]}
              onPress={toggleVoice}
            >
              <Ionicons
                name={recording ? "stop-circle" : "mic-outline"}
                size={22}
                color={recording ? Colors.danger : Colors.brandPrimary}
              />
            </Pressable>
            <Pressable
              testID="send-btn"
              style={[styles.sendBtn, !draft && { opacity: 0.5 }]}
              onPress={() => send()}
              disabled={!draft || sending}
            >
              {sending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Ionicons name="send" size={18} color="#FFFFFF" />
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>

        <Modal visible={showInvite} animationType="slide" transparent>
          <View style={styles.modalRoot}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Invite a member</Text>
              <Text style={styles.modalHint}>
                Enter their email. They will see an invitation in their app.
              </Text>
              <TextInput
                value={inviteEmail}
                onChangeText={setInviteEmail}
                placeholder="friend@example.com"
                placeholderTextColor={Colors.textTertiary}
                style={styles.input2}
                autoCapitalize="none"
                keyboardType="email-address"
                testID="invite-email-input"
              />
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  style={[styles.modalBtn, styles.modalCancel]}
                  onPress={() => setShowInvite(false)}
                >
                  <Text style={{ color: Colors.textSecondary, fontWeight: "600" }}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, styles.modalConfirm]}
                  onPress={sendInvite}
                  disabled={inviteBusy}
                  testID="invite-send-btn"
                >
                  {inviteBusy ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>
                      Send invite
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider2,
    backgroundColor: "rgba(255,255,255,0.85)",
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.paper,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  dangerBtn: { borderColor: "#FECACA", backgroundColor: Colors.dangerBg },
  title: { fontSize: 16, fontWeight: "700", color: Colors.textPrimary },
  subtitle: {
    fontSize: 10,
    color: Colors.textTertiary,
    letterSpacing: 1,
    fontWeight: "600",
    marginTop: 2,
  },
  body: { padding: 18, paddingBottom: 24, gap: 8 },
  banner: {
    flexDirection: "row",
    alignSelf: "center",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radii.pill,
    backgroundColor: Colors.brandFog,
    borderWidth: 1,
    borderColor: "#BAE6FD",
    marginBottom: 8,
  },
  bannerText: { color: Colors.brandDeep, fontSize: 11, fontWeight: "600" },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginVertical: 4 },
  avatarSm: {
    width: 28,
    height: 28,
    borderRadius: 28,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleSent: {
    backgroundColor: Colors.brandPrimary,
    borderBottomRightRadius: 6,
  },
  bubbleRecv: {
    backgroundColor: Colors.paper,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: Colors.divider2,
  },
  bubbleSender: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.brandPrimary,
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  imageMsg: { width: 220, height: 220, borderRadius: 12 },
  voiceBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radii.pill,
  },
  voiceText: { fontSize: 13, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    paddingBottom: 18,
    borderTopWidth: 1,
    borderTopColor: Colors.divider2,
    backgroundColor: Colors.paper,
  },
  compIcon: {
    width: 40,
    height: 40,
    borderRadius: 40,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    flex: 1,
    backgroundColor: Colors.bg,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  input: { fontSize: 15, color: Colors.textPrimary, maxHeight: 96 },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 44,
    backgroundColor: Colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.4)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: Colors.paper,
    padding: 24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    gap: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.textPrimary },
  modalHint: { color: Colors.textSecondary, fontSize: 13 },
  input2: {
    height: 52,
    backgroundColor: Colors.bg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider,
    paddingHorizontal: 16,
    color: Colors.textPrimary,
  },
  modalBtn: {
    flex: 1,
    height: 48,
    borderRadius: Radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  modalCancel: { backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.divider },
  modalConfirm: { backgroundColor: Colors.brandPrimary },
});
