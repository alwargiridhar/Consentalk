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
import { LinearGradient } from "expo-linear-gradient";
import AmbientBackground from "../../src/components/AmbientBackground";
import { Colors, Radii } from "../../src/lib/theme";
import { api, backendUrl, getStoredToken, wsUrl } from "../../src/lib/api";
import { useAuth } from "../../src/contexts/AuthContext";
import { getInitials, gradientFor } from "../../src/lib/confirm";
import { useConfirm } from "../../src/contexts/ConfirmContext";
import ImageViewer from "../../src/components/ImageViewer";
import JoinRequestsBanner from "../../src/components/JoinRequestsBanner";
import { startWebRecorder, blobFilename, WebRecorder } from "../../src/lib/webRecorder";

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
  read_by?: string[];
  delete_at?: string | null;
}

interface RoomData {
  room_id: string;
  name: string;
  room_type: string;
  owner_user_id: string;
  members_detail: Member[];
  security_mode?: string;
  retention_mode?: "5min" | "10min" | "15min" | "on_refresh";
}

type RetentionMode = "5min" | "10min" | "15min" | "on_refresh";
const RETENTION_LABELS: Record<RetentionMode, string> = {
  "5min": "5 minutes after read",
  "10min": "10 minutes after read",
  "15min": "15 minutes after read",
  on_refresh: "Only when wiped or refreshed",
};

interface UserBasic {
  user_id: string;
  name: string;
  picture?: string;
  verified: boolean;
  country?: string | null;
  status: string;
  joined_at?: string;
}

interface ScreenshotPrompt {
  request_id: string;
  user_id: string;
  name: string;
}

export default function RoomChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { confirm, notify } = useConfirm();
  const [room, setRoom] = useState<RoomData | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteMode, setInviteMode] = useState<"email" | "phone">("email");
  const [inviteValue, setInviteValue] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  const [leftNotices, setLeftNotices] = useState<string[]>([]);
  const [memberInfo, setMemberInfo] = useState<UserBasic | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const [audioPlayer, setAudioPlayer] = useState<Audio.Sound | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [screenshotPrompt, setScreenshotPrompt] = useState<ScreenshotPrompt | null>(
    null
  );
  // Image viewer (full-screen pinch/zoom)
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Live voice dictation (mic-to-text into the draft)
  const [dictRecording, setDictRecording] = useState<Audio.Recording | null>(null);
  const dictWebRef = useRef<WebRecorder | null>(null);
  const [dictWebRecording, setDictWebRecording] = useState(false);
  const [dictBusy, setDictBusy] = useState(false);
  // Cheap ticker to nudge JoinRequestsBanner to refresh on WS events
  const [joinReqTick, setJoinReqTick] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Settings sheet (owner only) + current retention mode (mirrors room.retention_mode)
  const [showSettings, setShowSettings] = useState(false);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [wipeBusy, setWipeBusy] = useState(false);
  // Tick that re-renders countdown badges on scheduled-delete messages
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api<RoomData>(`/rooms/${id}`);
      setRoom(r);
      // Fetch persisted messages so users that re-open the chat (or open it
      // for the first time after the other party sent something) can still
      // see them. Messages disappear via the room's retention_mode:
      //   • 5/10/15min → backend sweeps 5/10/15 min after they're read
      //   • on_refresh → only via the explicit "🔄 Refresh & wipe" button
      const m = await api<{ messages: Message[] }>(`/rooms/${id}/messages`);
      setMessages(m.messages || []);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 80);
    } catch (e: any) {
      await notify("Couldn't open room", e?.message || "Try again");
      router.back();
    }
  }, [id, router, notify]);

  useEffect(() => {
    load();
  }, [load]);

  // websocket — connection lifecycle is tied ONLY to `id`; user is read
  // lazily via `userRef` so the socket doesn't churn open/close as the auth
  // context re-renders.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      const token = await getStoredToken();
      if (!token || !alive) return;
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
              setTimeout(
                () => scrollRef.current?.scrollToEnd({ animated: true }),
                50
              );
              // If the incoming message is NOT from me, mark it as read so the
              // backend can apply the room's retention policy.
              const me = userRef.current?.user_id;
              if (me && data.message.sender_user_id !== me) {
                api(`/rooms/${id}/messages/${data.message.message_id}/read`, {
                  body: {},
                }).catch(() => {});
              }
            } else if (data.type === "deleted" && data.message_id) {
              setMessages((prev) =>
                prev.filter((m) => m.message_id !== data.message_id)
              );
            } else if (data.type === "scheduled_delete" && data.message_id) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.message_id === data.message_id
                    ? { ...m, delete_at: data.delete_at }
                    : m
                )
              );
            } else if (data.type === "wiped") {
              setMessages([]);
              if (data.user_id !== userRef.current?.user_id) {
                setLeftNotices((p) => [
                  ...p,
                  `${data.by_name || "A member"} cleared all messages.`,
                ]);
              }
            } else if (data.type === "settings_updated") {
              setRoom((r) =>
                r ? { ...r, retention_mode: data.retention_mode } : r
              );
            } else if (data.type === "ended") {
              setEndedNotice(`${data.by_name || "Someone"} ended the conversation.`);
              setMessages([]);
            } else if (data.type === "left") {
              if (data.user_id !== userRef.current?.user_id) {
                setLeftNotices((p) => [
                  ...p,
                  `${data.by_name || "A member"} left the room.`,
                ]);
              }
            } else if (data.type === "screenshot_request") {
              if (data.user_id !== userRef.current?.user_id) {
                setScreenshotPrompt({
                  request_id: data.request_id,
                  user_id: data.user_id,
                  name: data.name,
                });
              }
            } else if (data.type === "screenshot_response") {
              const tag = data.allow ? "allowed" : "declined";
              setLeftNotices((p) => [
                ...p,
                `${data.name || "Member"} ${tag} the screenshot.`,
              ]);
            } else if (
              data.type === "join_request" ||
              data.type === "join_request_decided"
            ) {
              setJoinReqTick((t) => t + 1);
            }
          } catch {}
        };
        ws.onclose = () => {
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
        };
        wsRef.current = ws;
        // Send a JSON ping every 25s so the ingress proxy doesn't reap an
        // idle connection while the user is reading.
        pingTimer = setInterval(() => {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
          } catch {}
        }, 25000);
      } catch {}
    })();
    return () => {
      alive = false;
      if (pingTimer) clearInterval(pingTimer);
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [id]);

  // Tick every 15s so countdown badges on scheduled-delete messages refresh.
  useEffect(() => {
    const t = setInterval(() => forceTick((v) => (v + 1) % 1000), 15000);
    return () => clearInterval(t);
  }, []);

  // Mark unread messages as read after the initial history load.
  useEffect(() => {
    if (!id || !room || !user?.user_id) return;
    const me = user.user_id;
    const unread = messages.filter(
      (m) =>
        m.sender_user_id !== me && !(m.read_by || []).includes(me) && !m.delete_at
    );
    unread.forEach((m) => {
      api(`/rooms/${id}/messages/${m.message_id}/read`, { body: {} }).catch(
        () => {}
      );
    });
    // We intentionally don't depend on `messages` directly to avoid spamming
    // /read; this fires once after each load() / live message append where
    // messages.length changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, room?.room_id, user?.user_id, messages.length]);

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
      await notify("Couldn't send", e?.message || "Try again");
    } finally {
      setSending(false);
    }
  };

  const onInputKeyPress = (e: any) => {
    // web: Enter without Shift sends; Shift+Enter inserts newline
    if (Platform.OS === "web" && e?.nativeEvent?.key === "Enter") {
      const shift = !!(e.nativeEvent as any).shiftKey;
      if (!shift) {
        e.preventDefault?.();
        send();
      }
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
        await notify("Voice error", e?.message || "Try again");
      }
      return;
    }
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      await notify("Voice notes are available on the mobile app");
      return;
    }
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      await notify("Microphone permission needed");
      return;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await rec.startAsync();
    setRecording(rec);
  };

  // ---- Voice dictation → transcribe → append to draft ----
  const startDictation = async () => {
    if (Platform.OS === "web") {
      try {
        const rec = await startWebRecorder();
        dictWebRef.current = rec;
        setDictWebRecording(true);
      } catch (e: any) {
        await notify(
          "Microphone unavailable",
          e?.message || "Please type instead."
        );
      }
      return;
    }
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      await notify("Microphone permission needed");
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await rec.startAsync();
    setDictRecording(rec);
  };

  const stopDictationAndTranscribe = async () => {
    setDictBusy(true);
    try {
      let blob: Blob | null = null;
      let filename = "phrase.m4a";
      if (Platform.OS === "web" && dictWebRef.current) {
        const rec = dictWebRef.current;
        dictWebRef.current = null;
        setDictWebRecording(false);
        blob = await rec.stop();
        filename = blobFilename(blob);
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
        if (text) {
          setDraft((d) => (d ? `${d} ${text}` : text));
        } else {
          await notify("Couldn't detect speech", "Please try again or type.");
        }
        return;
      }
      if (!dictRecording) return;
      await dictRecording.stopAndUnloadAsync();
      const uri = dictRecording.getURI();
      setDictRecording(null);
      if (!uri) throw new Error("No recording URI");
      const form = new FormData();
      // @ts-ignore RN file
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
      if (text) {
        setDraft((d) => (d ? `${d} ${text}` : text));
      } else {
        await notify("Couldn't detect speech", "Please try again or type.");
      }
    } catch (e: any) {
      await notify("Dictation failed", e?.message || "Try again");
    } finally {
      setDictBusy(false);
    }
  };

  const onDictateTap = async () => {
    const isRec = !!dictRecording || dictWebRecording;
    if (isRec) {
      await stopDictationAndTranscribe();
    } else {
      await startDictation();
    }
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
      await notify("Couldn't play", e?.message || "Try again");
    }
  };

  const pickImage = async () => {
    const r = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!r.granted) {
      await notify("Permission needed");
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

  const endConversation = async () => {
    const isOwner = room && room.owner_user_id === user?.user_id;
    const ok = await confirm({
      title: isOwner ? "End & permanently close this room?" : "End conversation?",
      message: isOwner
        ? "All messages will be wiped immediately and the room will be permanently closed for everyone."
        : "All messages in this room will be wiped immediately and you will leave.",
      confirmLabel: isOwner ? "End & delete" : "End now",
      destructive: true,
    });
    if (!ok) return;
    setEndBusy(true);
    try {
      // Owner uses /leave to permanently close the room (status=ended).
      // Non-owner uses /end to wipe and exit.
      if (isOwner) {
        await api(`/rooms/${id}/leave`, { method: "POST" });
      } else {
        await api(`/rooms/${id}/end`, { method: "POST" });
      }
      setMessages([]);
      setEndedNotice(
        isOwner
          ? "You closed this room. Messages wiped for everyone."
          : "You ended the conversation. Messages wiped."
      );
      setTimeout(() => router.replace("/(tabs)"), 800);
    } catch (e: any) {
      await notify("Couldn't end", e?.message || "Try again");
    } finally {
      setEndBusy(false);
    }
  };

  const sendInvite = async () => {
    if (!inviteValue.trim()) return;
    setInviteBusy(true);
    try {
      await api(`/rooms/${id}/invite`, {
        body:
          inviteMode === "email"
            ? { email: inviteValue.trim() }
            : { phone: inviteValue.trim() },
      });
      setInviteValue("");
      setShowInvite(false);
      await notify(
        "Invite sent",
        "If they have a Consentalk account, they'll see the invitation."
      );
    } catch (e: any) {
      await notify("Couldn't invite", e?.message || "Try again");
    } finally {
      setInviteBusy(false);
    }
  };

  const openMember = async (memberId: string) => {
    setMemberLoading(true);
    setMemberInfo({
      user_id: memberId,
      name: "…",
      verified: false,
      status: "active",
    });
    try {
      const u = await api<UserBasic>(`/users/${memberId}`);
      setMemberInfo(u);
    } catch (e: any) {
      setMemberInfo(null);
      await notify("Couldn't load profile", e?.message || "Try again");
    } finally {
      setMemberLoading(false);
    }
  };

  const requestScreenshot = () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) {
      notify("Not connected", "Please retry");
      return;
    }
    const requestId = `ss_${Date.now()}`;
    wsRef.current.send(
      JSON.stringify({ type: "screenshot_request", request_id: requestId })
    );
    setLeftNotices((p) => [...p, "You asked others to allow a screenshot."]);
  };

  const respondScreenshot = (allow: boolean) => {
    if (!screenshotPrompt) return;
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(
        JSON.stringify({
          type: "screenshot_response",
          request_id: screenshotPrompt.request_id,
          allow,
        })
      );
    }
    setScreenshotPrompt(null);
  };

  const isOwner = room && room.owner_user_id === user?.user_id;

  // ---- Retention controls ----
  const onWipeMessages = async () => {
    if (!id) return;
    const ok = await confirm({
      title: "Wipe all messages?",
      message:
        "This deletes every message in this room for everyone, immediately. The room itself stays open.",
      confirmLabel: "Wipe now",
      destructive: true,
    });
    if (!ok) return;
    setWipeBusy(true);
    try {
      await api(`/rooms/${id}/wipe`, { body: {} });
      setMessages([]);
    } catch (e: any) {
      await notify("Couldn't wipe", e?.message || "Try again");
    } finally {
      setWipeBusy(false);
    }
  };

  const onChangeRetention = async (mode: RetentionMode) => {
    if (!id || !room) return;
    if (room.retention_mode === mode) {
      setShowSettings(false);
      return;
    }
    setRetentionBusy(true);
    try {
      await api(`/rooms/${id}/settings`, {
        method: "PATCH",
        body: { retention_mode: mode },
      });
      setRoom((r) => (r ? { ...r, retention_mode: mode } : r));
      setShowSettings(false);
    } catch (e: any) {
      await notify("Couldn't update setting", e?.message || "Try again");
    } finally {
      setRetentionBusy(false);
    }
  };

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
              accessibilityLabel="Back"
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
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ alignItems: "center" }}>
                <Pressable
                  testID="screenshot-btn"
                  style={styles.iconBtn}
                  onPress={requestScreenshot}
                  accessibilityLabel="Request screenshot consent"
                  // @ts-ignore web title attribute
                  title="Ask others to allow a screenshot"
                >
                  <Ionicons
                    name="camera-outline"
                    size={18}
                    color={Colors.textSecondary}
                  />
                </Pressable>
                <Text style={styles.iconLabel}>Snap</Text>
              </View>
              {isOwner ? (
                <View style={{ alignItems: "center" }}>
                  <Pressable
                    testID="invite-btn"
                    style={styles.iconBtn}
                    onPress={() => setShowInvite(true)}
                    accessibilityLabel="Invite a member"
                    // @ts-ignore web title attribute
                    title="Invite a member by email or phone"
                  >
                    <Ionicons
                      name="person-add-outline"
                      size={18}
                      color={Colors.brandPrimary}
                    />
                  </Pressable>
                  <Text style={styles.iconLabel}>Invite</Text>
                </View>
              ) : null}
              {isOwner ? (
                <View style={{ alignItems: "center" }}>
                  <Pressable
                    testID="settings-btn"
                    style={styles.iconBtn}
                    onPress={() => setShowSettings(true)}
                    accessibilityLabel="Room settings"
                    // @ts-ignore web title attribute
                    title="Room settings — retention mode"
                  >
                    <Ionicons
                      name="settings-outline"
                      size={18}
                      color={Colors.textSecondary}
                    />
                  </Pressable>
                  <Text style={styles.iconLabel}>Settings</Text>
                </View>
              ) : null}
              {room?.retention_mode === "on_refresh" ? (
                <View style={{ alignItems: "center" }}>
                  <Pressable
                    testID="wipe-btn"
                    style={styles.iconBtn}
                    onPress={() => onWipeMessages()}
                    disabled={wipeBusy}
                    accessibilityLabel="Refresh & wipe all messages"
                    // @ts-ignore web title attribute
                    title="Wipe all messages for everyone in this room"
                  >
                    {wipeBusy ? (
                      <ActivityIndicator size="small" color={Colors.brandPrimary} />
                    ) : (
                      <Ionicons
                        name="refresh-outline"
                        size={18}
                        color={Colors.brandPrimary}
                      />
                    )}
                  </Pressable>
                  <Text style={[styles.iconLabel, { color: Colors.brandPrimary }]}>
                    Wipe
                  </Text>
                </View>
              ) : null}
              <View style={{ alignItems: "center" }}>
                <Pressable
                  testID="force-exit-btn"
                  style={[styles.iconBtn, styles.dangerBtn]}
                  onPress={endConversation}
                  disabled={endBusy}
                  accessibilityLabel="End conversation"
                  // @ts-ignore web title attribute
                  title="End conversation — wipes messages for everyone"
                >
                  <Ionicons name="exit-outline" size={18} color={Colors.danger} />
                </Pressable>
                <Text style={[styles.iconLabel, { color: Colors.danger }]}>End</Text>
              </View>
            </View>
          </View>

          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {isOwner ? (
              <JoinRequestsBanner
                roomId={id || ""}
                wsTrigger={joinReqTick}
                onDecision={() => {
                  // Refresh members list when an approval changes the room
                  load();
                }}
              />
            ) : null}
            <View style={styles.banner} testID="ephemeral-banner">
              <Ionicons name="time-outline" size={14} color={Colors.brandPrimary} />
              <Text style={styles.bannerText}>
                Messages stay while you're here. They disappear on refresh.
              </Text>
            </View>

            {leftNotices.map((n, i) => (
              <View key={`note-${i}`} style={styles.systemBubble}>
                <Text style={styles.systemText}>{n}</Text>
              </View>
            ))}

            {endedNotice ? (
              <View style={styles.endedBox} testID="ended-banner">
                <Ionicons
                  name="cloud-offline-outline"
                  size={20}
                  color={Colors.danger}
                />
                <Text style={styles.endedText}>{endedNotice}</Text>
                <Pressable
                  onPress={() => router.replace("/(tabs)")}
                  style={styles.endedBtn}
                >
                  <Text style={styles.endedBtnText}>Return home</Text>
                </Pressable>
              </View>
            ) : null}

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
                    <Pressable
                      onPress={() => openMember(m.sender_user_id)}
                      style={styles.avatarSm}
                      testID={`avatar-${m.sender_user_id}`}
                    >
                      <LinearGradient
                        colors={gradientFor(m.sender_user_id)}
                        style={[StyleSheet.absoluteFillObject, { borderRadius: 28 }]}
                      />
                      <Text style={styles.avatarSmInitials}>
                        {getInitials(m.sender_name)}
                      </Text>
                    </Pressable>
                  )}
                  <View
                    style={[
                      styles.bubble,
                      me ? styles.bubbleSent : styles.bubbleRecv,
                    ]}
                  >
                    {!me && (
                      <Pressable onPress={() => openMember(m.sender_user_id)}>
                        <Text style={styles.bubbleSender}>
                          {getInitials(m.sender_name)}
                        </Text>
                      </Pressable>
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
                      <Pressable
                        onPress={() => setViewerUri(m.content)}
                        testID={`open-image-${m.message_id}`}
                      >
                        <Image
                          source={{ uri: m.content }}
                          style={styles.imageMsg}
                          resizeMode="cover"
                        />
                        <View style={styles.imageOverlay} pointerEvents="none">
                          <Ionicons name="expand-outline" size={14} color="#FFFFFF" />
                        </View>
                      </Pressable>
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
                          name={playingId === m.message_id ? "pause" : "play"}
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
            <Pressable testID="image-btn" style={styles.compIcon} onPress={pickImage}>
              <Ionicons name="image-outline" size={20} color={Colors.brandPrimary} />
            </Pressable>
            <Pressable
              testID="dictate-btn"
              style={[
                styles.compIcon,
                (dictRecording || dictWebRecording) && { backgroundColor: Colors.dangerBg },
              ]}
              onPress={onDictateTap}
              disabled={dictBusy}
              // @ts-ignore web title
              title="Dictate speech into the message"
            >
              {dictBusy ? (
                <ActivityIndicator color={Colors.brandPrimary} size="small" />
              ) : (
                <Ionicons
                  name={
                    dictRecording || dictWebRecording
                      ? "stop-circle"
                      : "chatbubble-ellipses-outline"
                  }
                  size={20}
                  color={
                    dictRecording || dictWebRecording
                      ? Colors.danger
                      : Colors.brandPrimary
                  }
                />
              )}
            </Pressable>
            <View style={styles.inputWrap}>
              <TextInput
                testID="msg-input"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Speak gently…"
                placeholderTextColor={Colors.textTertiary}
                multiline={Platform.OS !== "web"}
                onKeyPress={onInputKeyPress}
                onSubmitEditing={() => send()}
                returnKeyType="send"
                blurOnSubmit={false}
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

        {/* Invite modal */}
        <Modal visible={showInvite} animationType="slide" transparent>
          <View style={styles.modalRoot}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Invite a member</Text>
              <Text style={styles.modalHint}>
                Send by email or by mobile number. They'll see an invitation in their
                app and can join with the phrase + PIN.
              </Text>
              <View style={styles.tabRow}>
                <Pressable
                  onPress={() => setInviteMode("email")}
                  style={[styles.tabBtn, inviteMode === "email" && styles.tabBtnActive]}
                  testID="invite-mode-email"
                >
                  <Ionicons
                    name="mail-outline"
                    size={16}
                    color={
                      inviteMode === "email"
                        ? Colors.brandDeep
                        : Colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.tabBtnText,
                      inviteMode === "email" && { color: Colors.brandDeep },
                    ]}
                  >
                    Email
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setInviteMode("phone")}
                  style={[styles.tabBtn, inviteMode === "phone" && styles.tabBtnActive]}
                  testID="invite-mode-phone"
                >
                  <Ionicons
                    name="call-outline"
                    size={16}
                    color={
                      inviteMode === "phone"
                        ? Colors.brandDeep
                        : Colors.textSecondary
                    }
                  />
                  <Text
                    style={[
                      styles.tabBtnText,
                      inviteMode === "phone" && { color: Colors.brandDeep },
                    ]}
                  >
                    Mobile
                  </Text>
                </Pressable>
              </View>
              <TextInput
                value={inviteValue}
                onChangeText={setInviteValue}
                placeholder={
                  inviteMode === "email" ? "friend@example.com" : "+1 555 555 1234"
                }
                placeholderTextColor={Colors.textTertiary}
                style={styles.input2}
                autoCapitalize="none"
                keyboardType={
                  inviteMode === "email" ? "email-address" : "phone-pad"
                }
                testID="invite-value-input"
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

        {/* Member info modal */}
        <Modal
          visible={!!memberInfo}
          animationType="fade"
          transparent
          onRequestClose={() => setMemberInfo(null)}
        >
          <Pressable
            style={styles.modalRoot}
            onPress={() => setMemberInfo(null)}
          >
            <Pressable style={styles.memberCard} onPress={(e) => e.stopPropagation()}>
              <Pressable
                style={styles.closeBtnTop}
                onPress={() => setMemberInfo(null)}
                testID="close-member"
              >
                <Ionicons name="close" size={20} color={Colors.textSecondary} />
              </Pressable>
              <View style={{ alignItems: "center" }}>
                {memberLoading ? (
                  <ActivityIndicator color={Colors.brandPrimary} />
                ) : (
                  <View style={[styles.memberPic, styles.memberPicFallback]}>
                    <LinearGradient
                      colors={gradientFor(memberInfo?.user_id || "?")}
                      style={[StyleSheet.absoluteFillObject, { borderRadius: 88 }]}
                    />
                    <Text style={styles.memberInitials}>
                      {getInitials(memberInfo?.name)}
                    </Text>
                  </View>
                )}
                <Text style={styles.memberName} testID="member-name">
                  {getInitials(memberInfo?.name)}{" "}
                  <Text style={styles.memberHandle}>· member</Text>
                </Text>
                <View style={styles.memberMetaRow}>
                  {memberInfo?.verified ? (
                    <View style={[styles.memberPill, { backgroundColor: Colors.successBg }]}>
                      <Ionicons
                        name="checkmark-circle"
                        size={12}
                        color={Colors.success}
                      />
                      <Text style={[styles.memberPillText, { color: Colors.success }]}>
                        VERIFIED
                      </Text>
                    </View>
                  ) : (
                    <View style={[styles.memberPill, { backgroundColor: Colors.divider2 }]}>
                      <Text
                        style={[styles.memberPillText, { color: Colors.textSecondary }]}
                      >
                        UNVERIFIED
                      </Text>
                    </View>
                  )}
                  {memberInfo?.country ? (
                    <View
                      style={[styles.memberPill, { backgroundColor: Colors.brandFog }]}
                    >
                      <Ionicons
                        name="flag-outline"
                        size={12}
                        color={Colors.brandDeep}
                      />
                      <Text style={[styles.memberPillText, { color: Colors.brandDeep }]}>
                        {memberInfo.country.toUpperCase()}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.memberHint}>
                  {memberInfo?.verified
                    ? "This member has completed identity verification."
                    : "This member has not yet verified their identity."}
                </Text>
                <View style={styles.memberActions}>
                  <Pressable
                    style={[styles.memberAct, { backgroundColor: Colors.dangerBg }]}
                    testID="member-report"
                    onPress={() => {
                      const id = memberInfo?.user_id;
                      setMemberInfo(null);
                      if (id) router.push(`/report?user_id=${id}`);
                    }}
                  >
                    <Ionicons
                      name="alert-circle-outline"
                      size={16}
                      color={Colors.danger}
                    />
                    <Text style={[styles.memberActText, { color: Colors.danger }]}>
                      Report
                    </Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Screenshot consent prompt */}
        <Modal
          visible={!!screenshotPrompt}
          animationType="fade"
          transparent
          onRequestClose={() => respondScreenshot(false)}
        >
          <View style={styles.modalRoot}>
            <View style={styles.memberCard}>
              <View style={[styles.iconHero, { backgroundColor: Colors.warnBg }]}>
                <Ionicons
                  name="camera-outline"
                  size={28}
                  color={Colors.warn}
                />
              </View>
              <Text style={styles.modalTitle}>
                {screenshotPrompt?.name || "A member"} wants to take a screenshot
              </Text>
              <Text style={styles.modalHint}>
                Consentalk asks every member to consent before screenshots are taken.
                If you decline, they should not capture this conversation.
              </Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
                <Pressable
                  style={[styles.modalBtn, styles.modalCancel]}
                  onPress={() => respondScreenshot(false)}
                  testID="screenshot-decline"
                >
                  <Text style={{ color: Colors.textSecondary, fontWeight: "600" }}>
                    Decline
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modalBtn, { backgroundColor: Colors.brandPrimary }]}
                  onPress={() => respondScreenshot(true)}
                  testID="screenshot-allow"
                >
                  <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Allow</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Full-screen Image Viewer */}
        <ImageViewer uri={viewerUri} onClose={() => setViewerUri(null)} />

        {/* Owner-only retention settings sheet */}
        <Modal
          visible={showSettings}
          animationType="fade"
          transparent
          onRequestClose={() => setShowSettings(false)}
        >
          <View style={styles.settingsBackdrop}>
            <View style={styles.settingsCard}>
              <View style={styles.settingsHeader}>
                <Ionicons name="time-outline" size={18} color={Colors.brandPrimary} />
                <Text style={styles.settingsTitle}>Message retention</Text>
                <Pressable
                  onPress={() => setShowSettings(false)}
                  style={styles.settingsClose}
                  testID="settings-close"
                >
                  <Ionicons name="close" size={18} color={Colors.textSecondary} />
                </Pressable>
              </View>
              <Text style={styles.settingsCaption}>
                Choose when messages should be deleted from this room. The
                setting applies to everyone in the room.
              </Text>
              {(["5min", "10min", "15min", "on_refresh"] as RetentionMode[]).map(
                (mode) => {
                  const active = (room?.retention_mode || "10min") === mode;
                  return (
                    <Pressable
                      key={mode}
                      style={[
                        styles.retentionRow,
                        active && styles.retentionRowActive,
                      ]}
                      onPress={() => onChangeRetention(mode)}
                      disabled={retentionBusy}
                      testID={`retention-${mode}`}
                    >
                      <View
                        style={[styles.radio, active && styles.radioActive]}
                      >
                        {active ? (
                          <View style={styles.radioDot} />
                        ) : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.retentionLabel,
                            active && { color: Colors.brandDeep },
                          ]}
                        >
                          {RETENTION_LABELS[mode]}
                        </Text>
                        <Text style={styles.retentionHint}>
                          {mode === "on_refresh"
                            ? "Messages stay until someone taps the 🔄 wipe button or ends the chat."
                            : `Backend auto-deletes ${mode.replace("min", "")} minutes after the other party reads.`}
                        </Text>
                      </View>
                      {retentionBusy && active ? (
                        <ActivityIndicator
                          size="small"
                          color={Colors.brandPrimary}
                        />
                      ) : null}
                    </Pressable>
                  );
                }
              )}
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
  iconLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: Colors.textSecondary,
    letterSpacing: 0.6,
    marginTop: 4,
    textTransform: "uppercase",
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
  systemBubble: {
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.divider2,
    borderRadius: Radii.pill,
  },
  systemText: { fontSize: 11, color: Colors.textSecondary, fontStyle: "italic" },
  endedBox: {
    alignSelf: "center",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: 16,
    margin: 8,
    backgroundColor: Colors.dangerBg,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  endedText: { color: Colors.danger, fontWeight: "600", fontSize: 14, textAlign: "center" },
  endedBtn: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.danger,
    borderRadius: Radii.pill,
  },
  endedBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 12 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginVertical: 4 },
  avatarSm: {
    width: 28,
    height: 28,
    borderRadius: 28,
    backgroundColor: Colors.brandFog,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarSmInitials: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
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
  imageOverlay: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 26,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  // ---- Settings sheet (retention) ----
  settingsBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.55)",
    justifyContent: "flex-end",
  },
  settingsCard: {
    backgroundColor: Colors.paper,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 28,
    gap: 12,
  },
  settingsHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  settingsTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  settingsClose: {
    width: 32,
    height: 32,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.bg,
  },
  settingsCaption: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  retentionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.divider2,
    backgroundColor: Colors.paper,
  },
  retentionRowActive: {
    borderColor: "#7DD3FC",
    backgroundColor: Colors.brandFog,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: Colors.divider2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: { borderColor: Colors.brandPrimary },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 10,
    backgroundColor: Colors.brandPrimary,
  },
  retentionLabel: {
    color: Colors.textPrimary,
    fontWeight: "700",
    fontSize: 14,
  },
  retentionHint: {
    color: Colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
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
  input: { fontSize: 15, color: Colors.textPrimary, maxHeight: 96, outlineStyle: "none" } as any,
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
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    backgroundColor: Colors.paper,
    padding: 24,
    borderRadius: 24,
    gap: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.textPrimary },
  modalHint: { color: Colors.textSecondary, fontSize: 13, lineHeight: 19 },
  tabRow: { flexDirection: "row", gap: 8 },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    backgroundColor: Colors.bg,
    borderRadius: Radii.pill,
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  tabBtnActive: { backgroundColor: Colors.brandFog, borderColor: "#7DD3FC" },
  tabBtnText: { color: Colors.textSecondary, fontWeight: "600", fontSize: 13 },
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
  memberCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: Colors.paper,
    borderRadius: 28,
    padding: 24,
    paddingTop: 32,
  },
  closeBtnTop: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 32,
    backgroundColor: Colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  iconHero: {
    width: 56,
    height: 56,
    borderRadius: 56,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  memberPic: { width: 88, height: 88, borderRadius: 88, backgroundColor: Colors.divider2, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  memberPicFallback: {
    backgroundColor: Colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  memberInitials: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 1,
  },
  memberHandle: { fontWeight: "400", fontSize: 13, color: Colors.textTertiary },
  memberName: { fontSize: 20, fontWeight: "700", color: Colors.textPrimary, marginTop: 12 },
  memberMetaRow: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap", justifyContent: "center" },
  memberPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radii.pill,
  },
  memberPillText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  memberHint: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
    marginTop: 12,
    paddingHorizontal: 8,
    lineHeight: 19,
  },
  memberActions: { flexDirection: "row", gap: 10, marginTop: 18 },
  memberAct: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radii.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  memberActText: { fontSize: 13, fontWeight: "600" },
});
