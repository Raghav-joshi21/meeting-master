// Web Speech API recognizer (Chrome/Edge/Safari) — not in TypeScript's DOM lib.
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  /** Chrome 135+: optional audio track to transcribe instead of the default mic. */
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
