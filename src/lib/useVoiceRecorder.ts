import { useCallback, useRef, useState } from "react";
import { transcribeAudio } from "../integrations/voice/api";

export type VoiceRecorderState = "idle" | "recording" | "transcribing" | "denied" | "unsupported";

const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<data>" — strip the prefix.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the recording."));
    reader.readAsDataURL(blob);
  });
}

/** Records a short voice clip via MediaRecorder and transcribes it through
 * the backend's Whisper endpoint. Returns the transcript for the caller to
 * drop into a text field for review — never files anything itself. */
export function useVoiceRecorder(onTranscribed: (text: string) => void) {
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [error, setError] = useState<string>();
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | undefined>(undefined);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  const start = useCallback(async () => {
    setError(undefined);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("unsupported");
      setError("Voice capture isn't supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        chunksRef.current = [];

        if (blob.size === 0) {
          setState("idle");
          setError("No audio was captured — try again.");
          return;
        }

        setState("transcribing");
        try {
          const base64 = await blobToBase64(blob);
          const text = await transcribeAudio(base64, blob.type || "audio/webm");
          onTranscribed(text);
          setState("idle");
        } catch (err) {
          setState("idle");
          setError(err instanceof Error ? err.message : "Couldn't transcribe that recording.");
        }
      };

      recorder.start();
      recorderRef.current = recorder;
      setState("recording");
    } catch (err) {
      stopStream();
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
        setState("denied");
        setError("Microphone access was denied — allow it in your browser settings to use voice capture.");
      } else {
        setState("idle");
        setError(err instanceof Error ? err.message : "Couldn't access the microphone.");
      }
    }
  }, [onTranscribed, stopStream]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  return { state, error, start, stop };
}
