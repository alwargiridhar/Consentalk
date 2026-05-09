// Web-only microphone recorder using MediaRecorder API. Returns a Blob.
import { Platform } from "react-native";

export interface WebRecorder {
  stop: () => Promise<Blob>;
}

export async function startWebRecorder(): Promise<WebRecorder> {
  if (Platform.OS !== "web") {
    throw new Error("Web recorder is web-only");
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone not supported in this browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime =
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported &&
    MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/mp4";
  const mr = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  mr.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mr.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        mr.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: mime }));
        };
        mr.stop();
      }),
  };
}

export function blobFilename(blob: Blob): string {
  if ((blob.type || "").includes("webm")) return "phrase.webm";
  if ((blob.type || "").includes("mp4")) return "phrase.mp4";
  return "phrase.m4a";
}
