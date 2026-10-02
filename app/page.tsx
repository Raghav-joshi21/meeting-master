'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MeetingNotes } from './api/refine/route';
import type { AssistantResult } from './api/assistant/route';
import { Icon, type IconName } from './icons';
import { assignSpeaker, makeSpeaker, VoiceProfiler, type Speaker } from './diarizer';

import type { ChatMsg, Meeting, Task } from './types';
import { AllTasks } from './all-tasks';
import { parseQuickTask } from './parse-task';
import { CaptionLines } from './caption-lines';
import { api, BASE_PATH } from './base-path';

type Status = 'idle' | 'recording' | 'paused';

const ASSISTANT_EXAMPLES = [
  '/add the printer issue we discussed',
  'What did everyone commit to?',
  "Mark Priya's tasks as done",
  'Add a decision that the launch moves to November',
];

const STORAGE_KEY = 'meeting-master:v1';
const MIC_KEY = 'meeting-master:mic';

/** Chrome 135+ can transcribe a processed audio track (so mic boost reaches the transcript). */
function trackInputSupported() {
  if (typeof navigator === 'undefined') return false;
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  return !!m && Number(m[1]) >= 135;
}

// Live refresh: run shortly after each new line (in the speaker's pause),
// but never let more than LIVE_MAX_WAIT_MS pass while people keep talking.
const LIVE_PAUSE_MS = 2_000;
const LIVE_MAX_WAIT_MS = 8_000;
const LIVE_MIN_NEW_CHARS = 15;
const POLISH_LAG = 4; // AI cleans a transcript line once 4 newer lines exist
const POLISH_BATCH = 6;

const LANGS = [
  ['en-US', 'English (US)'],
  ['en-IN', 'English (India)'],
  ['en-GB', 'English (UK)'],
  ['hi-IN', 'Hindi'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
] as const;

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const taskKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Word-overlap similarity (0..1), used to recognise a task or note the AI reworded. */
function similar(a: string, b: string) {
  const A = new Set(taskKey(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(taskKey(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return taskKey(a) === taskKey(b) ? 1 : 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

type NoteKey = 'title' | 'summary' | 'keyPoints' | 'decisions' | 'openQuestions';
type Notes = NonNullable<Meeting['notes']>;
const NOTE_LISTS = ['keyPoints', 'decisions', 'openQuestions'] as const;

/** Sections the user (or assistant) touched; older saves used a single flag for all of them. */
const lockedSections = (m: Meeting): NoteKey[] =>
  m.notesLocked ?? (m.notesEdited ? ['title', 'summary', ...NOTE_LISTS] : []);

/**
 * Live notes update: untouched sections take the AI's latest version; touched
 * sections keep the user's text, and touched lists still gain genuinely new items.
 */
function mergeNotes(prev: Notes | null, ai: Notes, locked: NoteKey[]): Notes {
  if (!prev) return ai;
  const out = { ...ai };
  if (locked.includes('title')) out.title = prev.title;
  if (locked.includes('summary')) out.summary = prev.summary;
  for (const k of NOTE_LISTS) {
    if (!locked.includes(k)) continue;
    const fresh = ai[k].filter((item) => !prev[k].some((p) => similar(p, item) >= 0.7));
    out[k] = [...prev[k], ...fresh];
  }
  return out;
}

/** Drop dates models tack onto titles ("Client Visit Prep - October 1, 2026"); reject bare "Meeting Notes". */
function cleanTitle(title: string) {
  const t = title
    .replace(/\s*[-:|,(]\s*(?:on\s+)?(?:[a-z]+day,?\s+)?(?:[a-z]+\s+\d{1,2}|\d{1,2}\s+[a-z]+),?\s+\d{4}\)?\s*$/i, '')
    .replace(/\s*[-:|,(]\s*\d{4}-\d{2}-\d{2}\)?\s*$/, '')
    .trim();
  return /^meeting( notes)?$/i.test(t) ? '' : t;
}

/**
 * Work out a task's due date. The words people actually said (the quote) win:
 * models are bad at calendar maths ("tomorrow" became "Tuesday, 2 Oct").
 * Then the model's due text, read by the same parser as quick-add.
 */
function cleanDue(due: string, quote = '') {
  const fromQuote = quote ? parseQuickTask(`x ${quote}`).due : '';
  if (fromQuote) return fromQuote;
  if (!/[a-z0-9]/i.test(due)) return '';
  // A weekday plus a computed date ("Monday, 6 Oct 2026"): trust the weekday.
  if (/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.test(due)) {
    const label = parseQuickTask(`x ${due.replace(/\b\d{4}\b/g, '').replace(/\b\d{1,2}(st|nd|rd|th)?\s+[a-z]{3,9}\b|\b[a-z]{3,9}\s+\d{1,2}(st|nd|rd|th)?\b(?!:)/gi, (m) => (/(mon|tue|wed|thu|fri|sat|sun)/i.test(m) ? m : ''))}`).due;
    if (label) return label;
  }
  // An ISO date in the past means the model made a date up; keep only what we can trust.
  const iso = due.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (d.getTime() < Date.now() - 86_400_000) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return parseQuickTask(`x ${due}`).due || due.trim();
}
const newMeeting = (): Meeting => ({
  id: crypto.randomUUID(),
  createdAt: Date.now(),
  duration: 0,
  segments: [],
  speakers: [],
  notes: null,
  tasks: [],
});

function loadHistory(): Meeting[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

const speakerOf = (m: Meeting, id?: string) => m.speakers?.find((s) => s.id === id);

/** Transcript with speaker labels, consecutive lines from one speaker merged. */
function labeledTranscript(m: Meeting) {
  const out: string[] = [];
  let last: string | undefined;
  for (const seg of m.segments) {
    const name = speakerOf(m, seg.speaker)?.name;
    if (name && seg.speaker === last && out.length) out[out.length - 1] += ` ${seg.text}`;
    else out.push(name ? `${name}: ${seg.text}` : seg.text);
    last = seg.speaker;
  }
  return out.join('\n');
}

function toMarkdown(m: Meeting) {
  const n = m.notes;
  const lines = [`# ${n?.title || 'Meeting notes'}`, `_${new Date(m.createdAt).toLocaleString()} · ${fmt(m.duration)}_`, ''];
  if (n) {
    lines.push('## Summary', n.summary, '');
    if (n.keyPoints.length) lines.push('## Key points', ...n.keyPoints.map((p) => `- ${p}`), '');
    if (n.decisions.length) lines.push('## Decisions', ...n.decisions.map((p) => `- ${p}`), '');
  }
  if (m.tasks.length)
    lines.push(
      '## To-do',
      ...m.tasks.map(
        (t) =>
          `- [${t.done ? 'x' : ' '}] ${t.task}${t.owner && t.owner !== 'Unassigned' ? ` - @${t.owner}` : ''}${t.due ? ` (due ${t.due})` : ''} [${t.priority}]`,
      ),
      '',
    );
  if (n?.openQuestions.length) lines.push('## Open questions', ...n.openQuestions.map((p) => `- ${p}`), '');
  lines.push(
    '## Transcript',
    ...m.segments.map((s) => {
      const who = speakerOf(m, s.speaker)?.name;
      return `[${fmt(s.t)}] ${who ? `**${who}:** ` : ''}${s.text}`;
    }),
  );
  return lines.join('\n');
}

export default function Home() {
  const [meeting, setMeeting] = useState<Meeting>(newMeeting);
  const [history, setHistory] = useState<Meeting[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [lang, setLang] = useState('en-US');
  const [context, setContext] = useState('');
  const [manual, setManual] = useState('');
  const [newTask, setNewTask] = useState('');
  const [refining, setRefining] = useState(false);
  const [lastRefinedAt, setLastRefinedAt] = useState<number | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(true);
  const [tab, setTab] = useState<'todo' | 'notes' | 'assistant'>('todo');
  const [inputMode, setInputMode] = useState<'note' | 'assistant'>('note');
  const [asking, setAsking] = useState(false);
  const [flashSeg, setFlashSeg] = useState<number | null>(null);
  const [editingSeg, setEditingSeg] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [view, setView] = useState<'live' | 'tasks'>('live');
  const [toast, setToast] = useState('');
  const [level, setLevel] = useState(0);
  const [diarize, setDiarize] = useState(true);
  const [sensitivity, setSensitivity] = useState(0.5);
  const diarizeRef = useRef(diarize);
  diarizeRef.current = diarize;
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;
  const profilerRef = useRef<VoiceProfiler | null>(null);

  // mic settings (persisted per browser)
  const [micGain, setMicGain] = useState(2);
  const [roundTable, setRoundTable] = useState(true);
  const [deviceId, setDeviceId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [showMic, setShowMic] = useState(false);
  // display options (persisted): quieter recorder visuals, collapse while recording, consent reminder
  const [calm, setCalm] = useState(false);
  const [collapse, setCollapse] = useState(false);
  const [consent, setConsent] = useState(true);
  const [expanded, setExpanded] = useState(false); // user re-opened the full recorder while collapsed
  const [consentNotice, setConsentNotice] = useState(false);
  const [roomBanner, setRoomBanner] = useState(false);
  const consentShownForRef = useRef<string | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const runningRef = useRef(false);
  const lastResultAtRef = useRef(0);
  const voiceAtRef = useRef(0);
  const usingTrackRef = useRef(false); // current session listens to the boosted track
  const [trackFailed, setTrackFailed] = useState(false); // boosted track never started → raw mic fallback
  const trackFailedRef = useRef(false);
  // Live diagnostics: a visible engine status + a short event trail sent to the server log.
  const [engineNote, setEngineNote] = useState('');
  const diagBufRef = useRef<{ t: number; e: string; [k: string]: unknown }[]>([]);
  const sessionRef = useRef({ startedAt: 0, results: 0 });
  const diag = (e: string, data: Record<string, unknown> = {}) => {
    diagBufRef.current.push({ t: Date.now(), e, ...data });
    if (diagBufRef.current.length > 200) diagBufRef.current.shift();
    console.debug('[meeting-master]', e, data);
  };
  const flushDiag = () => {
    if (!diagBufRef.current.length) return;
    const events = diagBufRef.current.splice(0);
    const body = JSON.stringify({ ua: navigator.userAgent, events });
    try {
      if (!navigator.sendBeacon?.(api('/api/diag'), new Blob([body], { type: 'application/json' }))) {
        fetch(api('/api/diag'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
      }
    } catch {}
  };

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(MIC_KEY) || '{}');
      if (typeof saved.micGain === 'number') setMicGain(saved.micGain);
      if (typeof saved.roundTable === 'boolean') setRoundTable(saved.roundTable);
      if (typeof saved.deviceId === 'string') setDeviceId(saved.deviceId);
      if (typeof saved.calm === 'boolean') setCalm(saved.calm);
      if (typeof saved.collapse === 'boolean') setCollapse(saved.collapse);
      if (typeof saved.consent === 'boolean') setConsent(saved.consent);
    } catch {}
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    try {
      localStorage.setItem(MIC_KEY, JSON.stringify({ micGain, roundTable, deviceId, calm, collapse, consent }));
    } catch {}
  }, [micGain, roundTable, deviceId, calm, collapse, consent]);

  const recRef = useRef<SpeechRecognition | null>(null);
  const statusRef = useRef<Status>('idle');
  const elapsedRef = useRef(0);
  const segIdRef = useRef(0);
  const lastRefinedLenRef = useRef(0);
  const audioRef = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;

  const transcript = useMemo(() => meeting.segments.map((s) => s.text).join(' '), [meeting.segments]);
  const wordCount = transcript ? transcript.split(/\s+/).length : 0;
  const openTasks = meeting.tasks.filter((t) => !t.done).length;

  // ---- persistence ----
  useEffect(() => {
    setHistory(loadHistory());
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  const saveMeeting = useCallback((m: Meeting) => {
    if (!m.segments.length && !m.tasks.length) return;
    setHistory((prev) => {
      const next = [m, ...prev.filter((p) => p.id !== m.id)].slice(0, 200);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    const id = setTimeout(() => saveMeeting(meeting), 800);
    return () => clearTimeout(id);
  }, [meeting, saveMeeting]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [meeting.segments.length, meeting.segments.at(-1)?.text]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  };

  // ---- AI refine ----
  const refiningRef = useRef(false);
  const pendingRefineRef = useRef<false | 'live' | 'final'>(false);
  const refine = useCallback(
    async (quiet = false, final = false) => {
      if (refiningRef.current) {
        // run again as soon as this one lands (a pending final pass wins over a live one)
        pendingRefineRef.current = final || pendingRefineRef.current === 'final' ? 'final' : 'live';
        return;
      }
      const m = meetingRef.current;
      const text = m.segments.map((s) => s.text).join(' ');
      if (text.trim().length < 20) {
        if (!quiet) setError('Say a bit more first, there is not enough transcript to analyze yet.');
        return;
      }
      refiningRef.current = true;
      setRefining(true);
      if (final) setFinalizing(true);
      setError('');
      const keep = m.tasks.filter((t) => t.manual || t.edited || t.done);
      const speakers = m.speakers ?? [];
      const labeled = speakers.length ? labeledTranscript(m) : text;
      try {
        const res = await fetch(api('/api/refine'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: labeled,
            speakers: speakers.filter((s) => !s.renamed).map((s) => s.name),
            context,
            existingTasks: keep.map((t) => t.task),
            currentTasks: m.tasks.filter((t) => !t.manual && !t.edited && !t.done).map((t) => t.task),
            existingNotes:
              m.notes && lockedSections(m).length
                ? Object.fromEntries(lockedSections(m).map((k) => [k, m.notes![k]]))
                : null,
            final,
            today: new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        const { tasks, speakerNames, ...notes } = data as MeetingNotes;
        lastRefinedLenRef.current = text.length;
        setLastRefinedAt(Date.now());
        setMeeting((prev) => {
          // Tasks the user touched stay exactly as they are.
          const kept = prev.tasks.filter((t) => t.manual || t.edited || t.done);
          const keptKeys = new Set(kept.flatMap((t) => [taskKey(t.task), t.origKey].filter(Boolean)));
          const prevAi = prev.tasks.filter((t) => !t.manual && !t.edited && !t.done);
          const used = new Set<string>();
          const now = Date.now();
          const aiTasks: Task[] = [];
          for (const { kind: _kind, quote, ...t } of tasks) {
            if (keptKeys.has(taskKey(t.task)) || kept.some((k) => similar(k.task, t.task) >= 0.8)) continue;
            // Same task, maybe reworded: keep the existing card (id, wording, "new" time) so it doesn't flicker.
            const existing = prevAi.find((p) => !used.has(p.id) && (taskKey(p.task) === taskKey(t.task) || similar(p.task, t.task) >= 0.7));
            if (existing) used.add(existing.id);
            // AI returned a near-duplicate: keep one, preferring the copy that names an owner.
            const dup = aiTasks.find((a) => similar(a.task, t.task) >= 0.8);
            if (dup) {
              if (dup.owner === 'Unassigned' && t.owner && t.owner !== 'Unassigned') dup.owner = t.owner;
              continue;
            }
            aiTasks.push({
              ...t,
              task: final ? t.task : (existing?.task ?? t.task), // final pass may improve wording
              due: cleanDue(t.due, quote) || existing?.due || '',
              id: existing?.id ?? crypto.randomUUID(),
              done: false,
              origKey: existing?.origKey ?? taskKey(t.task),
              addedAt: existing?.addedAt ?? now,
            });
          }
          // Keep the original ordering of kept tasks, append AI ones.
          // AI-suggested real names for generic "Speaker N" labels (never overrides the user).
          const suggested = new Map((speakerNames ?? []).map((x) => [x.label, x.name.trim()]));
          const speakers = prev.speakers?.map((s) =>
            !s.renamed && suggested.get(s.name) ? { ...s, name: suggested.get(s.name)!, renamed: true } : s,
          );
          // Owners written as "Speaker 3" become the real name once that speaker is identified.
          const ownerName = (owner: string) => {
            const n = owner.match(/^speaker\s*(\d+)$/i)?.[1];
            const sp = n ? speakers?.find((x) => x.id === `s${n}`) : undefined;
            return sp && sp.renamed ? sp.name : owner;
          };
          return {
            ...prev,
            speakers,
            finalizedAt: final ? Date.now() : prev.finalizedAt,
            notes: mergeNotes(
              prev.notes,
              { ...notes, title: cleanTitle(notes.title) || prev.notes?.title || '' },
              lockedSections(prev),
            ),
            tasks: [...kept, ...aiTasks].map((t) => ({ ...t, owner: ownerName(t.owner) })),
          };
        });
        if (final) flash('Final notes ready');
        else if (!quiet) flash('Notes refined');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        refiningRef.current = false;
        setRefining(false);
        if (final) setFinalizing(false);
        const pending = pendingRefineRef.current;
        if (pending) {
          pendingRefineRef.current = false;
          refineRef.current?.(true, pending === 'final');
        }
      }
    },
    [context],
  );
  const refineRef = useRef(refine);
  refineRef.current = refine;

  // live refine while recording: debounce on new words, with a max wait
  const firstUnrefinedAtRef = useRef<number | null>(null);
  const transcriptLen = useMemo(() => meeting.segments.reduce((n, g) => n + g.text.length + 1, 0), [meeting.segments]);
  useEffect(() => {
    if (status !== 'recording') return;
    if (Math.abs(transcriptLen - lastRefinedLenRef.current) < LIVE_MIN_NEW_CHARS) return;
    firstUnrefinedAtRef.current ??= Date.now();
    const waited = Date.now() - firstUnrefinedAtRef.current;
    const id = setTimeout(
      () => {
        firstUnrefinedAtRef.current = null;
        refine(true);
      },
      Math.max(0, Math.min(LIVE_PAUSE_MS, LIVE_MAX_WAIT_MS - waited)),
    );
    return () => clearTimeout(id);
  }, [status, transcriptLen, refine]);

  // timer
  useEffect(() => {
    if (status !== 'recording') return;
    const id = setInterval(() => {
      elapsedRef.current += 1;
      setMeeting((m) => ({ ...m, duration: elapsedRef.current }));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  // ---- microphone: capture → clean-up → boost → auto-level ----
  // Browsers' speech recognition normally listens to the raw default mic. Recent
  // Chrome can instead transcribe a MediaStreamTrack we give it, so we route the
  // mic through a Web Audio chain (high-pass, adjustable gain, compressor) and
  // hand the processed track over. Older browsers ignore the track and use the
  // raw mic; the boost then only affects the meter.
  const startMeter = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          autoGainControl: true,
          // Noise suppression and echo cancellation treat far-away voices as
          // noise; turn them off when the whole table needs to be heard.
          noiseSuppression: !roundTable,
          echoCancellation: !roundTable,
        },
      });
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 90 }); // table thumps, AC hum
      const gain = new GainNode(ctx, { gain: micGain });
      const out = ctx.createMediaStreamDestination();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; // long enough window for voice pitch

      src.connect(highpass).connect(gain);
      let last: AudioNode = gain;
      if (roundTable) {
        // Auto-levelling: lifts quiet, distant speakers and tames the loud, close ones.
        const comp = new DynamicsCompressorNode(ctx, { threshold: -38, knee: 24, ratio: 6, attack: 0.005, release: 0.3 });
        const makeup = new GainNode(ctx, { gain: 1.6 });
        last = last.connect(comp).connect(makeup);
      }
      last.connect(out);
      last.connect(analyser);

      gainNodeRef.current = gain;
      trackRef.current = out.stream.getAudioTracks()[0] ?? null;
      const profiler = new VoiceProfiler(analyser, ctx.sampleRate);
      profilerRef.current = profiler;
      const tick = () => {
        const lvl = Math.min(1, profiler.sample() * 4);
        if (lvl > 0.12) voiceAtRef.current = Date.now();
        setLevel(lvl);
        if (audioRef.current) audioRef.current.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { stream, ctx, raf: requestAnimationFrame(tick) };
      refreshDevices();
      diag('mic.ok', { ctx: ctx.state, device: stream.getAudioTracks()[0]?.label, roundTable, gain: micGain });
      return true;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      diag('mic.error', { name, message: (e as Error)?.message });
      setError(
        name === 'OverconstrainedError' || name === 'NotFoundError'
          ? 'That microphone is not available any more. Pick another one in mic settings.'
          : 'Microphone access was blocked. Allow mic permission in your browser and try again.',
      );
      return false;
    }
  };

  const stopMeter = () => {
    const a = audioRef.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    a.stream.getTracks().forEach((t) => t.stop());
    a.ctx.close();
    audioRef.current = null;
    profilerRef.current = null;
    gainNodeRef.current = null;
    trackRef.current = null;
    setLevel(0);
  };

  // live sensitivity changes while recording
  useEffect(() => {
    const g = gainNodeRef.current;
    if (g) g.gain.setTargetAtTime(micGain, g.context.currentTime, 0.05);
  }, [micGain]);

  // ---- speech recognition (self-healing) ----
  // Every phrase is written into the transcript the moment the mic hears it and
  // updated in place while Chrome refines its guess. Chrome sometimes finalises a
  // phrase as one word (or nothing) or drops it when a session ends; we never let
  // that erase what was already heard. The AI polish pass cleans wording later.
  const words = (t: string) => (t ? t.split(/\s+/).length : 0);


  /** Mark live lines as final and give them a speaker. */
  const finalizeSegments = (ids: number[]) => {
    if (!ids.length) return;
    const print = profilerRef.current?.take() ?? null;
    setMeeting((m) => {
      let speakers = m.speakers ?? [];
      const segments = m.segments.map((g, idx) => {
        if (!ids.includes(g.id) || !g.live) return g;
        let speaker = g.speaker;
        if (diarizeRef.current) {
          const lastSpeaker = m.segments.slice(0, idx).reverse().find((x) => x.speaker)?.speaker ?? null;
          const r = assignSpeaker(print, speakers, lastSpeaker, sensitivityRef.current);
          speakers = r.speakers;
          speaker = r.id;
        }
        return { ...g, live: false, speaker };
      });
      return { ...m, speakers, segments };
    });
  };

  const startRecognition = () => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognition;
      webkitSpeechRecognition?: new () => SpeechRecognition;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = lang;
    rec.onstart = () => {
      runningRef.current = true;
      lastResultAtRef.current = Date.now();
      diag('rec.onstart', { mode: usingTrackRef.current ? 'boosted' : 'mic' });
      setEngineNote(usingTrackRef.current ? 'listening (boosted audio)' : 'listening');
    };
    rec.onaudiostart = () => diag('rec.audiostart');
    rec.onspeechstart = () => diag('rec.speechstart');

    // Per session: maps Chrome's result events onto stable transcript lines.
    const tracker = new CaptionLines(() => ++segIdRef.current);
    const sessionLines = () => tracker.lines;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      lastResultAtRef.current = Date.now();
      if (sessionRef.current.results++ === 0) {
        diag('rec.first-result', { mode: usingTrackRef.current ? 'boosted' : 'mic', ms: Date.now() - sessionRef.current.startedAt });
        setEngineNote('');
      }
      const results = Array.from({ length: e.results.length }, (_, i) => ({
        text: e.results[i][0].transcript,
        isFinal: e.results[i].isFinal,
      }));
      const { upserts, finished } = tracker.handle(results, e.resultIndex);
      if (upserts.length) {
        setMeeting((m) => {
          const byId = new Map(upserts.map((u) => [u.id, u.text]));
          const segments = m.segments.map((g) => {
            const t = byId.get(g.id);
            // Never overwrite a line the user edited; never let a live update shrink it badly.
            if (t === undefined || g.edited || !g.live) return g;
            return words(t) >= words(g.text) * 0.6 ? { ...g, text: t } : g;
          });
          const fresh = upserts
            .filter((u) => u.isNew)
            .map((u) => ({ id: u.id, t: elapsedRef.current, text: u.text, live: true }));
          return { ...m, segments: [...segments, ...fresh] };
        });
      }
      if (finished.length) {
        // A result finishing also closes any earlier lines Chrome left hanging.
        const maxFinished = Math.max(...finished);
        finalizeSegments(sessionLines().filter((id) => id <= maxFinished));
      }
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      diag('rec.error', { error: e.error, message: e.message, mode: usingTrackRef.current ? 'boosted' : 'mic' });
      if (e.error === 'network') setEngineNote("can't reach Chrome's speech service, retrying…");
      else if (e.error === 'language-not-supported') setError(`Chrome can't transcribe ${lang} here. Pick another language.`);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone permission denied.');
        statusRef.current = 'idle';
        setStatus('idle');
      } else if (e.error === 'audio-capture') {
        setError('No microphone input. Check the mic is connected, or pick another one in mic settings.');
      }
      // 'no-speech', 'network', 'aborted': onend restarts us.
    };
    rec.onend = () => {
      runningRef.current = false;
      diag('rec.onend', { results: sessionRef.current.results });
      // Session over (silence, ~60 s limit, hiccup): keep every line it produced.
      finalizeSegments(sessionLines());
      if (statusRef.current === 'recording' && recRef.current === rec) {
        setTimeout(() => {
          if (statusRef.current === 'recording' && recRef.current === rec) startRecognition();
        }, 150);
      }
    };
    (rec as SpeechRecognition & { finalizeAll?: () => void }).finalizeAll = () => finalizeSegments(sessionLines());
    recRef.current = rec;
    lastResultAtRef.current = Date.now(); // give the new session a grace period
    const track = trackRef.current;
    usingTrackRef.current = !!track && trackInputSupported() && !trackFailedRef.current;
    sessionRef.current = { startedAt: Date.now(), results: 0 };
    diag('rec.start', { mode: usingTrackRef.current ? 'boosted' : 'mic', lang });
    try {
      if (usingTrackRef.current) rec.start(track!);
      else rec.start();
    } catch (err) {
      diag('rec.start-threw', { message: (err as Error)?.message });
      usingTrackRef.current = false;
      try {
        rec.start();
      } catch (err2) {
        diag('rec.start-threw-again', { message: (err2 as Error)?.message });
      }
    }
  };

  const stopRecognition = () => {
    const rec = recRef.current as (SpeechRecognition & { finalizeAll?: () => void }) | null;
    recRef.current = null;
    runningRef.current = false;
    if (rec) {
      rec.onend = null;
      rec.stop();
      rec.finalizeAll?.();
    }
  };

  // Watchdog: revive recognition that died silently or stopped producing text
  // while people are clearly talking.
  useEffect(() => {
    if (status !== 'recording') return;
    const id = setInterval(() => {
      const now = Date.now();
      if (!runningRef.current && recRef.current) {
        if (now - lastResultAtRef.current > 4000) {
          // A boosted-track session that never started: fall back to the raw mic.
          if (usingTrackRef.current) {
            trackFailedRef.current = true;
            setTrackFailed(true);
          }
          const dead = recRef.current as SpeechRecognition & { finalizeAll?: () => void };
          dead.onend = null;
          dead.abort();
          dead.finalizeAll?.();
          recRef.current = null;
          startRecognition();
        }
      } else if (
        usingTrackRef.current &&
        sessionRef.current.results === 0 &&
        now - sessionRef.current.startedAt > 10000 &&
        now - voiceAtRef.current < 3000
      ) {
        // Voice on the meter but no text from boosted audio: switch to the plain mic.
        diag('fallback.plain-mic', { reason: 'no text from boosted audio after 10s of voice' });
        trackFailedRef.current = true;
        setTrackFailed(true);
        setEngineNote('no text yet, switching to plain mic…');
        recRef.current?.abort(); // onend restarts, now without the boosted track
      } else if (now - lastResultAtRef.current > 15000 && now - voiceAtRef.current < 2000) {
        diag('watchdog.restart', { reason: 'no text for 15s while voice detected' });
        recRef.current?.abort(); // onend saves pending words and restarts
      }
      flushDiag();
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- uses refs; must not reset on every render
  }, [status]);

  const start = async () => {
    setError('');
    if (!(await startMeter())) return;
    statusRef.current = 'recording';
    setStatus('recording');
    startRecognition();
    polishMeetingRef.current = meetingRef.current.id;
    setExpanded(false);
    if (consent && consentShownForRef.current !== meetingRef.current.id) {
      consentShownForRef.current = meetingRef.current.id;
      setConsentNotice(true);
    }
  };

  const pause = () => {
    statusRef.current = 'paused';
    setStatus('paused');
    stopRecognition();
    stopMeter();
  };

  const stop = () => {
    statusRef.current = 'idle';
    setStatus('idle');
    stopRecognition();
    stopMeter();
    diag('stop', { lines: meetingRef.current.segments.length });
    flushDiag();
    setEngineNote('');
    finalizeNotes();
  };

  /**
   * End of meeting: let the transcript cleanup finish the last lines (it runs
   * with no lag once recording stops), then send the whole transcript for the
   * final notes.
   */
  const finalizeNotes = async () => {
    setFinalizing(true);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 600)); // let the last result land
    const pendingPolish = () =>
      polishMeetingRef.current === meetingRef.current.id &&
      meetingRef.current.segments.some((g) => !g.live && !g.polished && !g.edited && !g.typed);
    while ((polishingRef.current || pendingPolish()) && Date.now() - started < 25_000) {
      await new Promise((r) => setTimeout(r, 400));
    }
    if (statusRef.current !== 'idle') return setFinalizing(false); // recording resumed meanwhile
    if (meetingRef.current.segments.map((g) => g.text).join(' ').trim().length < 20) return setFinalizing(false);
    refineRef.current?.(false, true);
  };

  const toggle = () => (status === 'recording' ? pause() : start());

  const reset = () => {
    if (status !== 'idle') stop();
    saveMeeting(meetingRef.current);
    elapsedRef.current = 0;
    lastRefinedLenRef.current = 0;
    setMeeting(newMeeting());
    setError('');
    setContext('');
  };

  const openMeeting = (m: Meeting) => {
    if (status !== 'idle') return flash('Stop recording first');
    saveMeeting(meetingRef.current);
    elapsedRef.current = m.duration;
    segIdRef.current = Math.max(0, ...m.segments.map((s) => s.id));
    lastRefinedLenRef.current = m.segments.map((s) => s.text).join(' ').length;
    setMeeting(m);
    setShowHistory(false);
    setView('live');
  };

  // ---- tasks across all meetings ----
  const allMeetings = useMemo(
    () => [
      ...(meeting.segments.length || meeting.tasks.length ? [meeting] : []),
      ...history.filter((h) => h.id !== meeting.id),
    ],
    [meeting, history],
  );
  const allOpenCount = allMeetings.reduce((n, m) => n + m.tasks.filter((t) => !t.done).length, 0);

  const editHistoryMeeting = (meetingId: string, change: (m: Meeting) => Meeting) =>
    setHistory((prev) => {
      const next = prev.map((h) => (h.id === meetingId ? change(h) : h));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

  const updateTaskIn = (meetingId: string, taskId: string, patch: Partial<Task>, markEdited = true) => {
    if (meetingId === meeting.id) return updateTask(taskId, patch, markEdited);
    editHistoryMeeting(meetingId, (m) => ({
      ...m,
      tasks: m.tasks.map((t) => (t.id === taskId ? { ...t, ...patch, edited: t.edited || markEdited } : t)),
    }));
  };

  const removeTaskIn = (meetingId: string, taskId: string) => {
    if (meetingId === meeting.id) return removeTask(taskId);
    editHistoryMeeting(meetingId, (m) => ({ ...m, tasks: m.tasks.filter((t) => t.id !== taskId) }));
  };

  const openMeetingById = (id: string) => {
    if (id === meeting.id) return setView('live');
    const m = history.find((h) => h.id === id);
    if (m) openMeeting(m);
  };

  // ---- move meetings between browsers / sites (localhost → raghavjoshi.dev) ----
  const exportMeetings = () => {
    saveMeeting(meetingRef.current);
    const all = [meetingRef.current, ...history.filter((h) => h.id !== meetingRef.current.id)].filter(
      (m) => m.segments.length || m.tasks.length,
    );
    const blob = new Blob([JSON.stringify({ app: 'meeting-master', version: 1, exportedAt: Date.now(), meetings: all }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meeting-master-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(`Exported ${all.length} meeting${all.length === 1 ? '' : 's'}`);
  };

  const importMeetings = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const incoming: Meeting[] = Array.isArray(data) ? data : data.meetings;
      if (!Array.isArray(incoming) || incoming.some((m) => !m?.id || !Array.isArray(m.segments) || !Array.isArray(m.tasks))) {
        throw new Error('That file is not a Meeting Master export.');
      }
      let added = 0;
      setHistory((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = incoming.filter((m) => !known.has(m.id)); // never overwrite what's already here
        added = fresh.length;
        const next = [...prev, ...fresh].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
      setTimeout(() => flash(added ? `Imported ${added} meeting${added === 1 ? '' : 's'}` : 'Nothing new to import'), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  };

  const deleteMeeting = (id: string) => {
    setHistory((prev) => {
      const next = prev.filter((p) => p.id !== id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // space bar toggles recording
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => () => {
    stopRecognition();
    stopMeter();
  }, []);

  const addManualLine = (e: React.FormEvent) => {
    e.preventDefault();
    const text = manual.trim();
    if (!text) return;
    if (inputMode === 'assistant' || text.startsWith('/')) {
      askAssistant(text);
    } else {
      setMeeting((m) => ({ ...m, segments: [...m.segments, { id: ++segIdRef.current, t: elapsedRef.current, text, typed: true }] }));
    }
    setManual('');
  };

  // ---- transcript corrections ----
  const saveSegmentEdit = (id: number) => {
    const text = editText.trim();
    setEditingSeg(null);
    setMeeting((m) => ({
      ...m,
      segments: m.segments.map((g) =>
        g.id === id && text && text !== g.text ? { ...g, raw: g.raw ?? g.text, text, edited: true } : g,
      ),
    }));
  };

  const restoreSegment = (id: number) =>
    setMeeting((m) => ({
      ...m,
      segments: m.segments.map((g) => (g.id === id && g.raw ? { ...g, text: g.raw, edited: true } : g)),
    }));

  // ---- rolling AI cleanup of the transcript ----
  // Lines are polished a few lines behind the speaker (at line 5, line 1 gets
  // cleaned) so the AI has context from what came after. Only meetings recorded
  // in this session are polished; once recording stops the tail is finished too.
  const polishingRef = useRef(false);
  const polishMeetingRef = useRef<string | null>(null);
  useEffect(() => {
    if (polishingRef.current || polishMeetingRef.current !== meeting.id) return;
    const segs = meeting.segments;
    const finals = segs.filter((g) => !g.live);
    const lag = status === 'recording' ? POLISH_LAG : 0;
    const eligible = finals.slice(0, Math.max(0, finals.length - lag));
    const batch = eligible.filter((g) => !g.polished && !g.edited && !g.typed).slice(0, POLISH_BATCH);
    if (!batch.length) return;

    const firstIdx = segs.findIndex((g) => g.id === batch[0].id);
    const lastIdx = segs.findIndex((g) => g.id === batch[batch.length - 1].id);
    const line = (g: (typeof segs)[number]) => ({ id: g.id, speaker: speakerOf(meeting, g.speaker)?.name ?? '', text: g.text });
    const sent = new Map(batch.map((g) => [g.id, g.text]));
    polishingRef.current = true;
    (async () => {
      let cleaned = new Map<number, string>();
      try {
        const res = await fetch(api('/api/polish'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lines: batch.map(line),
            before: segs.slice(Math.max(0, firstIdx - 3), firstIdx).map(line),
            after: segs.slice(lastIdx + 1, lastIdx + 5).map(line),
            context,
            people: [
              ...new Set([
                ...(meeting.speakers ?? []).filter((x) => x.renamed).map((x) => x.name),
                ...meeting.tasks.map((t) => t.owner).filter((o) => o && o !== 'Unassigned' && o !== 'Me'),
              ]),
            ],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { lines: { id: number; text: string }[] };
          cleaned = new Map(data.lines.map((l) => [l.id, l.text.trim()]));
        }
      } catch {}
      // Mark the batch done either way so a failing request can't loop forever.
      setMeeting((m) => ({
        ...m,
        segments: m.segments.map((g) => {
          if (!sent.has(g.id) || g.edited) return g;
          const next = cleaned.get(g.id);
          // Skip if the line changed while we were waiting, or the AI returned nothing usable.
          if (g.text !== sent.get(g.id) || !next) return { ...g, polished: true };
          return { ...g, polished: true, raw: g.raw ?? g.text, text: next };
        }),
      }));
      polishingRef.current = false;
    })();
  }, [meeting, status, context]);

  // ---- assistant ----
  const pushChat = (msg: Omit<ChatMsg, 'id'>) =>
    setMeeting((m) => ({ ...m, chat: [...(m.chat ?? []), { ...msg, id: crypto.randomUUID() }] }));

  useEffect(() => {
    if (tab === 'assistant') chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [tab, meeting.chat?.length, asking]);

  const askAssistant = async (raw: string) => {
    const m = meetingRef.current;
    // Slash command: "/add <task>" always creates a task.
    const isAdd = /^\/add\b/i.test(raw);
    const text = isAdd ? raw.replace(/^\/add\b\s*/i, '').trim() : raw;
    if (isAdd && !text) {
      pushChat({ role: 'assistant', text: 'Tell me what to add, e.g. /add follow up on the printer with the vendor', error: true });
      setTab('assistant');
      return;
    }
    setInputMode('assistant');
    pushChat({ role: 'user', text: raw });
    setTab('assistant');
    setAsking(true);
    // Short refs the model can use: transcript lines #1.., tasks T1..
    const lineToSeg = m.segments.map((g) => g.id);
    const transcript = m.segments
      .map((g, i) => `#${i + 1} [${fmt(g.t)}] ${speakerOf(m, g.speaker)?.name ?? 'Unknown'}: ${g.text}`)
      .join('\n');
    const refToTask = new Map(m.tasks.map((t, i) => [`T${i + 1}`, t.id]));
    const tasks = m.tasks
      .map((t, i) => `T${i + 1} | ${t.done ? 'done' : 'open'} | ${t.priority} | ${t.owner || 'Unassigned'} | ${t.due || '-'} | ${t.task}`)
      .join('\n');
    const history = (m.chat ?? []).filter((c) => !c.error).map((c) => ({ role: c.role, content: c.text }));
    try {
      const res = await fetch(api('/api/assistant'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, command: isAdd ? 'add' : undefined, transcript, tasks, notes: m.notes, history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      const result = data as AssistantResult;
      // /add must add something; if the model only answered, add the user's words as the task.
      if (isAdd && !result.actions.some((a) => a.type === 'add_task' && a.task.trim())) {
        result.actions.push({
          type: 'add_task', taskRef: '', task: text, owner: 'Unassigned', due: '', priority: 'medium',
          status: 'unchanged', context: '', section: 'none', text: '',
        });
      }
      const changes = applyAssistantActions(result.actions, refToTask);
      const cited = result.citedLines.map((n) => lineToSeg[n - 1]).filter((id): id is number => id !== undefined);
      pushChat({ role: 'assistant', text: result.reply, cited, changes });
    } catch (e) {
      pushChat({ role: 'assistant', text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setAsking(false);
    }
  };

  /** Apply the assistant's actions to the meeting; returns a readable list of changes. */
  const applyAssistantActions = (actions: AssistantResult['actions'], refToTask: Map<string, string>) => {
    const now = Date.now();
    const val = (v: string) => (v && v !== 'unchanged' ? v : undefined);
    // Pure: run once on the current snapshot for the change list, and again inside
    // setMeeting so concurrent live refreshes aren't overwritten.
    const apply = (prev: Meeting) => {
      const changes: string[] = [];
      let tasks = [...prev.tasks];
      let notes = prev.notes;
      let notesLocked = lockedSections(prev);
      for (const a of actions) {
        const id = refToTask.get(a.taskRef);
        const existing = id ? tasks.find((t) => t.id === id) : undefined;
        if (a.type === 'add_task' && a.task.trim()) {
          tasks.push({
            id: crypto.randomUUID(),
            task: a.task.trim(),
            owner: val(a.owner) ?? 'Unassigned',
            due: val(a.due) ?? '',
            priority: a.priority === 'unchanged' ? 'medium' : a.priority,
            context: val(a.context) ?? '',
            done: false,
            manual: true, // live refreshes keep it
            addedAt: now,
          });
          changes.push(`Added task: ${a.task.trim()}`);
        } else if (a.type === 'update_task' && existing) {
          const patch: Partial<Task> = { edited: true };
          if (val(a.task) && a.task !== existing.task) patch.task = a.task;
          if (val(a.owner)) patch.owner = a.owner;
          if (val(a.due)) patch.due = a.due;
          if (a.priority !== 'unchanged') patch.priority = a.priority;
          if (a.status === 'done') patch.done = true;
          if (a.status === 'open') patch.done = false;
          tasks = tasks.map((t) => (t.id === existing.id ? { ...t, ...patch, addedAt: now } : t));
          changes.push(
            a.status === 'done' && !existing.done
              ? `Marked done: ${existing.task}`
              : a.status === 'open' && existing.done
                ? `Reopened: ${existing.task}`
                : `Updated: ${patch.task ?? existing.task}`,
          );
        } else if (a.type === 'delete_task' && existing) {
          tasks = tasks.filter((t) => t.id !== existing.id);
          changes.push(`Removed task: ${existing.task}`);
        } else if (a.type === 'add_note' && a.section !== 'none' && val(a.text)) {
          const base = notes ?? { title: '', summary: '', keyPoints: [], decisions: [], openQuestions: [] };
          notes = { ...base, [a.section]: [...base[a.section], a.text] };
          if (!notesLocked.includes(a.section)) notesLocked = [...notesLocked, a.section]; // keep it through live refreshes
          const label = { keyPoints: 'key point', decisions: 'decision', openQuestions: 'open question' }[a.section];
          changes.push(`Added ${label}: ${a.text}`);
        }
      }
      return { next: { ...prev, tasks, notes, notesLocked }, changes };
    };
    const { changes } = apply(meetingRef.current);
    setMeeting((prev) => apply(prev).next);
    return changes;
  };

  const jumpToSegment = (id: number) => {
    document.getElementById(`seg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashSeg(id);
    setTimeout(() => setFlashSeg((cur) => (cur === id ? null : cur)), 2200);
  };

  // "setup lunch at moon on monday 12:00 @priya !urgent" → task + due + owner + priority
  const quick = newTask.trim() ? parseQuickTask(newTask) : null;
  const addTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    const q = parseQuickTask(newTask);
    setMeeting((m) => ({
      ...m,
      tasks: [
        ...m.tasks,
        {
          id: crypto.randomUUID(),
          task: q.task,
          owner: q.owner ?? 'Me',
          due: q.due,
          dueAt: q.dueAt,
          priority: q.priority ?? 'medium',
          context: '',
          done: false,
          manual: true,
          addedAt: Date.now(),
        },
      ],
    }));
    setNewTask('');
  };

  const updateTask = (id: string, patch: Partial<Task>, markEdited = true) =>
    setMeeting((m) => ({
      ...m,
      tasks: m.tasks.map((t) => (t.id === id ? { ...t, ...patch, edited: t.edited || markEdited } : t)),
    }));
  const updateNotes = (patch: Partial<NonNullable<Meeting['notes']>>) =>
    setMeeting((m) =>
      m.notes
        ? {
            ...m,
            notes: { ...m.notes, ...patch },
            notesLocked: [...new Set([...lockedSections(m), ...(Object.keys(patch) as NoteKey[])])],
          }
        : m,
    );
  const editList = (key: 'keyPoints' | 'decisions' | 'openQuestions', i: number, value: string | null) => {
    const list = [...(meetingRef.current.notes?.[key] ?? [])];
    if (value === null) list.splice(i, 1);
    else list[i] = value;
    updateNotes({ [key]: list });
  };
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 3000); // fade "new" badges
    return () => clearInterval(id);
  }, []);
  const removeTask = (id: string) => setMeeting((m) => ({ ...m, tasks: m.tasks.filter((t) => t.id !== id) }));

  // ---- speakers ----
  const renameSpeaker = (id: string, name: string) =>
    setMeeting((m) => ({
      ...m,
      speakers: m.speakers?.map((s) => (s.id === id ? { ...s, name, renamed: true } : s)),
    }));

  /** Move one line to another speaker ("new" creates one). Manual fixes don't retrain voice prints. */
  const reassignSegment = (segId: number, speakerId: string) =>
    setMeeting((m) => {
      let speakers = m.speakers ?? [];
      let target = speakerId;
      if (speakerId === 'new') {
        const s = makeSpeaker(speakers.length);
        speakers = [...speakers, s];
        target = s.id;
      }
      return { ...m, speakers, segments: m.segments.map((g) => (g.id === segId ? { ...g, speaker: target } : g)) };
    });

  const lineCount = (id: string) => meeting.segments.filter((g) => g.speaker === id).length;
  const speakers = (meeting.speakers ?? []).filter((s) => lineCount(s.id) > 0);

  const copyMd = async () => {
    await navigator.clipboard.writeText(toMarkdown(meeting));
    flash('Copied as Markdown');
  };
  const downloadMd = () => {
    const blob = new Blob([toMarkdown(meeting)], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(meeting.notes?.title || 'meeting-notes').replace(/[^\w-]+/g, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sortedTasks = [...meeting.tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const p = { high: 0, medium: 1, low: 2 };
    return p[a.priority] - p[b.priority];
  });

  return (
    <>
    <nav className="navbar">
      <div className="nav-inner">
        <div className="brand">
          <span className="logo">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z" />
            </svg>
          </span>
          <span className="brand-name">
            Meeting<b>Master</b>
          </span>
        </div>
        <div className="nav-links">
          <button
            className={view === 'live' && !showHistory ? 'on' : ''}
            onClick={() => {
              setView('live');
              setShowHistory(false);
            }}
          >
            Live meeting {status === 'recording' && <span className={`rec-dot ${calm ? 'calm' : ''}`} title="Recording" />}
          </button>
          <button
            className={view === 'tasks' && !showHistory ? 'on' : ''}
            onClick={() => {
              setView('tasks');
              setShowHistory(false);
            }}
          >
            All tasks {allOpenCount > 0 && <span className="count">{allOpenCount}</span>}
          </button>
          <button className={showHistory ? 'on' : ''} onClick={() => setShowHistory((s) => !s)}>
            History {history.length > 0 && <span className="count">{history.length}</span>}
          </button>
        </div>
        <div className="actions">
          <button className="ghost" onClick={copyMd} disabled={!meeting.segments.length}>
            Copy
          </button>
          <button className="ghost" onClick={downloadMd} disabled={!meeting.segments.length}>
            Export
          </button>
          <button className="dark" onClick={reset}>
            + New meeting
          </button>
          <button
            className="icon"
            title="Sign out"
            onClick={async () => {
              await fetch(api('/api/logout'), { method: 'POST' });
              location.href = `${BASE_PATH}/login`;
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </div>
    </nav>
    <div className="shell">
      {view === 'tasks' ? (
        <header className="page-head">
          <h1>All tasks</h1>
          <p className="muted">
            Every to-do from {allMeetings.length} {allMeetings.length === 1 ? 'meeting' : 'meetings'}. Edits save back to the meeting
            they came from.
          </p>
        </header>
      ) : (
      <header className="page-head">
        {meeting.notes ? (
          <input
            className="title-edit"
            placeholder="Untitled meeting"
            value={meeting.notes.title}
            title="Click to rename"
            onChange={(e) => updateNotes({ title: e.target.value })}
          />
        ) : (
          <h1>New meeting</h1>
        )}
        <p className="muted">
          {new Date(meeting.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          {' · '}
          {status === 'recording' ? 'listening and taking notes live.' : 'hit the mic and let the notes write themselves.'}
        </p>
      </header>
      )}

      {view === 'tasks' && (
        <AllTasks meetings={allMeetings} onUpdate={updateTaskIn} onRemove={removeTaskIn} onOpen={openMeetingById} />
      )}

      <div className="stats" hidden={view !== 'live'}>
        {[
          ['clock', fmt(meeting.duration), 'Duration'],
          ['message', String(wordCount), 'Words captured'],
          ['users', String(speakers.length), 'Speakers'],
          ['check', `${openTasks}/${meeting.tasks.length}`, 'Open tasks'],
          ['flag', String(meeting.notes?.decisions.length ?? 0), 'Decisions'],
        ].map(([icon, value, label]) => (
          <div key={label} className="stat">
            <span className="stat-icon">
              <Icon name={icon as IconName} size={15} />
            </span>
            <strong>{value}</strong>
            <span className="muted small">{label}</span>
          </div>
        ))}
      </div>

      {showHistory && (
        <div className="history">
          <div className="history-tools">
            <span className="muted small">
              Meetings are saved in this browser. Export them here, then Import on another browser or on raghavjoshi.dev.
            </span>
            <button className="ghost" onClick={exportMeetings} disabled={!history.length && !meeting.segments.length}>
              Export all
            </button>
            <label className="ghost import-btn">
              Import
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importMeetings(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {history.length === 0 && <p className="muted">No saved meetings yet.</p>}
          {history.map((h) => (
            <div key={h.id} className={`history-item ${h.id === meeting.id ? 'active' : ''}`}>
              <button className="history-open" onClick={() => openMeeting(h)}>
                <strong>{h.notes?.title || 'Untitled meeting'}</strong>
                <span className="muted small">
                  {new Date(h.createdAt).toLocaleString()} · {fmt(h.duration)} · {h.tasks.length} tasks
                </span>
              </button>
              <button className="icon" title="Delete" onClick={() => deleteMeeting(h.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {!supported && (
        <div className="banner">
          Live speech recognition isn&apos;t available in this browser. Use <b>Chrome</b>, <b>Edge</b> or <b>Safari</b>, or
          type notes manually below.
        </div>
      )}
      {error && (
        <div className="banner error" onClick={() => setError('')}>
          {error}
        </div>
      )}

      <main className="grid" hidden={view !== 'live'}>
        {/* ---------- left: recorder + transcript ---------- */}
        <section className={`card recorder ${calm ? 'calm' : ''} ${collapse && status !== 'idle' && !expanded ? 'strip' : ''}`}>
          {collapse && status !== 'idle' && !expanded ? (
            <div className="rec-strip">
              <button className="strip-play" onClick={toggle} title={status === 'recording' ? 'Pause' : 'Resume'}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  {status === 'recording' ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5v14l11-7z" />}
                </svg>
              </button>
              <span className={`strip-status ${status}`}>
                <i /> {status === 'recording' ? 'Recording' : 'Paused'} <b>{fmt(meeting.duration)}</b>
              </span>
              <button className="strip-icon" title="Settings" onClick={() => setShowMic((v) => !v)}>
                <Icon name="sliders" size={13} />
              </button>
              <button className="strip-stop" onClick={stop}>
                ■ Stop
              </button>
              <button className="strip-icon" title="Show full recorder" onClick={() => setExpanded(true)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
          ) : (
          <div className="rec-top">
            <button
              className={`mic ${status}`}
              onClick={toggle}
              disabled={!supported}
              style={{ ['--lvl' as string]: level }}
              aria-label={status === 'recording' ? 'Pause recording' : 'Start recording'}
            >
              <span className="ring" />
              <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor">
                {status === 'recording' ? (
                  <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                ) : (
                  <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z" />
                )}
              </svg>
            </button>
            <div className="rec-info">
              <div className="timer">{fmt(meeting.duration)}</div>
              <div className={`status-dot ${status}`}>
                {status === 'recording' ? 'Listening…' : status === 'paused' ? 'Paused' : 'Ready'}
                <span className="muted small"> · {status === 'recording' && engineNote ? engineNote : 'press Space'}</span>
              </div>
              <div className="bars">
                {Array.from({ length: 24 }).map((_, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${status === 'recording' ? 8 + level * 100 * (0.4 + Math.abs(Math.sin(i * 1.7 + meeting.duration))) : 6}%`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="rec-controls">
              <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={status === 'recording'}>
                {LANGS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <button className={`mic-btn ${showMic ? 'on' : ''}`} onClick={() => setShowMic((v) => !v)}>
                <Icon name="sliders" size={13} /> Settings
              </button>
              {status !== 'idle' && (
                <button className="danger" onClick={stop}>
                  ■ Stop &amp; refine
                </button>
              )}
              {collapse && status !== 'idle' && (
                <button className="mic-btn" onClick={() => setExpanded(false)}>
                  Collapse
                </button>
              )}
            </div>
          </div>
          )}

          {consentNotice && status !== 'idle' && (
            <div className="consent">
              <span>Recording for AI notes. Let the room know you&apos;re taking notes.</span>
              <button onClick={() => setRoomBanner(true)}>Show banner</button>
              <button className="consent-ok" onClick={() => setConsentNotice(false)}>
                Done
              </button>
            </div>
          )}

          {showMic && (
            <div className="mic-panel">
              <button className="icon mic-close" title="Close" onClick={() => setShowMic(false)}>
                ✕
              </button>
              <label className="mic-row">
                <span className="mic-label">
                  Sensitivity <b>{micGain.toFixed(1)}x</b>
                </span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={0.25}
                  value={micGain}
                  onChange={(e) => setMicGain(Number(e.target.value))}
                />
                <span className="muted small">Raise it if people far from the mic are missed. Lower it if it picks up noise.</span>
              </label>
              <div className="mic-row two">
                <label className="switch" title="Turns off noise suppression and evens out loud and quiet voices">
                  <input
                    type="checkbox"
                    checked={roundTable}
                    disabled={status !== 'idle'}
                    onChange={(e) => setRoundTable(e.target.checked)}
                  />
                  <span />
                  Round-table mode
                </label>
                <select
                  value={deviceId}
                  disabled={status !== 'idle'}
                  onChange={(e) => setDeviceId(e.target.value)}
                  onFocus={refreshDevices}
                >
                  <option value="">Default microphone</option>
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="display-opts">
                <span className="mic-label">Display</span>
                <label className="switch">
                  <input type="checkbox" checked={calm} onChange={(e) => setCalm(e.target.checked)} />
                  <span />
                  Calm recorder
                  <small className="muted">no pulsing red or waveform</small>
                </label>
                <label className="switch">
                  <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
                  <span />
                  Collapse while recording
                  <small className="muted">slim bar, more room for notes</small>
                </label>
                <label className="switch">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span />
                  Consent reminder
                  <small className="muted">prompt to tell the room when you start</small>
                </label>
              </div>
              <p className="muted small mic-note">
                {roundTable
                  ? 'Round-table mode picks up distant voices and evens out loud and quiet speakers. '
                  : ''}
                {status !== 'idle' && 'Mode and microphone changes apply next time you start. '}
                {trackInputSupported() && !trackFailed
                  ? 'Sensitivity is applied to the transcription live.'
                  : trackFailed
                  ? 'Boosted audio did not start in this browser, so transcription uses the raw mic. Raise the input volume in your system sound settings instead.'
                  : 'This browser transcribes the raw mic, so sensitivity here only moves the meter. Use Chrome 135 or newer, or raise the input volume in your system sound settings.'}
              </p>
            </div>
          )}

          <input
            className="context"
            placeholder="Optional context, e.g. Weekly sync with design team, Priya owns the launch"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />

          <div className="speakers-bar">
            <label className="switch" title="Detect who is speaking from their voice">
              <input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} />
              <span />
              Speakers
            </label>
            {diarize && (
              <label className="sens" title="Higher = splits similar voices into separate speakers more eagerly">
                <span className="muted small">Split</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sensitivity}
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                />
              </label>
            )}
            <div className="speaker-chips">
              {speakers.map((sp) => (
                <label key={sp.id} className="speaker-chip" style={{ ['--c' as string]: sp.color }} title="Click to rename">
                  <i />
                  <input
                    value={sp.name}
                    size={Math.max(4, sp.name.length)}
                    onChange={(e) => renameSpeaker(sp.id, e.target.value)}
                  />
                  <span className="muted small">{lineCount(sp.id)}</span>
                </label>
              ))}
              {diarize && speakers.length === 0 && (
                <span className="muted small">Voices are grouped automatically. Rename them here.</span>
              )}
            </div>
          </div>

          <div className="transcript">
            {meeting.segments.length === 0 && (
              <div className="empty">
                <div className="empty-icon"><Icon name="mic" size={20} /></div>
                <p>Hit the mic and start talking.</p>
                <p className="muted small">Your words appear here live. Notes &amp; to-dos update live as you talk.</p>
              </div>
            )}
            {meeting.segments.map((s, i) => {
              const sp = speakerOf(meeting, s.speaker);
              const showLabel = sp && meeting.segments[i - 1]?.speaker !== s.speaker;
              return (
                <div
                  key={s.id}
                  id={`seg-${s.id}`}
                  className={`seg ${sp ? 'has-speaker' : ''} ${flashSeg === s.id ? 'flash' : ''} ${s.live ? 'live' : ''}`}
                  style={{ ['--c' as string]: sp?.color }}
                >
                  <span className="ts">{fmt(s.t)}</span>
                  <div className="seg-body">
                    {sp && (
                      <select
                        className={`who ${showLabel ? '' : 'quiet'}`}
                        value={sp.id}
                        title="Wrong speaker? Change it"
                        onChange={(e) => reassignSegment(s.id, e.target.value)}
                      >
                        {(meeting.speakers ?? []).map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                        <option value="new">+ New speaker</option>
                      </select>
                    )}
                    {editingSeg === s.id ? (
                      <textarea
                        className="seg-edit"
                        autoFocus
                        rows={Math.max(1, Math.ceil(editText.length / 60))}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onBlur={() => saveSegmentEdit(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            saveSegmentEdit(s.id);
                          }
                          if (e.key === 'Escape') setEditingSeg(null);
                        }}
                      />
                    ) : (
                      <span
                        className={`seg-text ${s.live ? '' : 'editable'}`}
                        title={s.live ? 'Still listening…' : 'Click to correct'}
                        onClick={() => {
                          if (s.live) return;
                          setEditingSeg(s.id);
                          setEditText(s.text);
                        }}
                      >
                        {s.text}
                        {s.polished && s.raw && s.raw !== s.text && !s.edited && (
                          <button
                            className="polish-mark"
                            title={`Cleaned up by AI. Heard: "${s.raw}". Click to restore what was heard.`}
                            onClick={(e) => {
                              e.stopPropagation();
                              restoreSegment(s.id);
                            }}
                          >
                            <Icon name="sparkle" size={11} />
                          </button>
                        )}
                        {s.edited && <span className="edited-mark">edited</span>}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={transcriptEndRef} />
          </div>

          {manual.startsWith('/') && !/^\/add\s/i.test(manual) && (
            <div className="slash-hint">
              <button
                type="button"
                onClick={() => {
                  setManual('/add ');
                  setInputMode('assistant');
                }}
              >
                <b>/add</b>
                <span className="muted small">Create a task. Uses the meeting to fill owner, due date and context.</span>
              </button>
            </div>
          )}
          <form onSubmit={addManualLine} className={`inline-form composer ${inputMode}`}>
            <div className="mode-switch" role="tablist">
              <button type="button" className={inputMode === 'note' ? 'on' : ''} onClick={() => setInputMode('note')}>
                <Icon name="pencil" size={12} /> Note
              </button>
              <button
                type="button"
                className={inputMode === 'assistant' ? 'on' : ''}
                onClick={() => {
                  setInputMode('assistant');
                  setTab('assistant');
                }}
              >
                <Icon name="sparkle" size={12} /> Assistant
              </button>
            </div>
            <input
              placeholder={
                inputMode === 'assistant'
                  ? 'Ask anything, or /add a task, e.g. /add printer issue'
                  : 'Type a note into the transcript…'
              }
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button type="submit" className={inputMode === 'assistant' ? 'dark' : 'ghost'} disabled={asking && inputMode === 'assistant'}>
              {inputMode === 'assistant' ? (asking ? <span className="spinner" /> : 'Send') : 'Add'}
            </button>
          </form>
        </section>

        {/* ---------- right: AI output ---------- */}
        <section className="card output">
          <div className="out-head">
            <div className="tabs">
              <button className={tab === 'todo' ? 'on' : ''} onClick={() => setTab('todo')}>
                To-do {openTasks > 0 && <span className="pill">{openTasks}</span>}
              </button>
              <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
                Notes
              </button>
              <button className={tab === 'assistant' ? 'on' : ''} onClick={() => setTab('assistant')}>
                <Icon name="sparkle" size={12} /> Assistant
              </button>
            </div>
            {status === 'idle' && finalizing && (
              <span className="final-chip working">
                <span className="spinner dark" /> Finalizing notes…
              </span>
            )}
            {status === 'idle' && !finalizing && meeting.finalizedAt && (
              <span className="final-chip" title={`Final pass over the whole transcript at ${new Date(meeting.finalizedAt).toLocaleTimeString()}`}>
                <Icon name="check" size={12} /> Final notes
              </span>
            )}
            {status === 'recording' && (
              <span className={`live ${calm ? 'calm' : ''}`}>
                <i /> LIVE · {refining ? 'updating…' : lastRefinedAt ? `updated ${Math.max(0, Math.round((Date.now() - lastRefinedAt) / 1000))}s ago` : 'listening'}
              </span>
            )}
            <button
              className="primary"
              onClick={() => (status === 'idle' ? refine(false, true) : refine())}
              disabled={refining || wordCount < 4}
            >
              {refining ? <span className="spinner" /> : <Icon name="sparkle" size={13} />} {refining ? 'Refining…' : status === 'idle' && meeting.segments.length ? 'Re-finalize' : 'Refine now'}
            </button>
          </div>

          {tab === 'assistant' ? (
            <div className="chat">
              {(meeting.chat ?? []).length === 0 && (
                <div className="empty">
                  <div className="empty-icon">
                    <Icon name="sparkle" size={20} />
                  </div>
                  <p>Ask the assistant about this meeting.</p>
                  <p className="muted small">It reads the transcript, then creates or edits tasks and notes for you.</p>
                  <div className="examples">
                    {ASSISTANT_EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        onClick={() => {
                          setInputMode('assistant');
                          askAssistant(ex);
                        }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {(meeting.chat ?? []).map((c) => (
                <div key={c.id} className={`msg ${c.role} ${c.error ? 'error' : ''}`}>
                  <p>{c.text}</p>
                  {!!c.changes?.length && (
                    <ul className="changes">
                      {c.changes.map((ch, i) => (
                        <li key={i}>
                          <Icon name="check" size={12} /> {ch}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!!c.cited?.length && (
                    <div className="cites">
                      <span className="muted small">From the meeting:</span>
                      {c.cited.map((id) => {
                        const g = meeting.segments.find((x) => x.id === id);
                        return g ? (
                          <button key={id} onClick={() => jumpToSegment(id)} title={g.text}>
                            {fmt(g.t)}
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                </div>
              ))}
              {asking && (
                <div className="msg assistant thinking">
                  <span /> <span /> <span />
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          ) : tab === 'todo' ? (
            <div className="tasks">
              {sortedTasks.length === 0 && (
                <div className="empty">
                  <div className="empty-icon"><Icon name="check" size={20} /></div>
                  <p>No tasks yet.</p>
                  <p className="muted small">Action items you mention (“I’ll send the deck by Friday”) show up here, cleaned up.</p>
                </div>
              )}
              {sortedTasks.map((t) => {
                const fresh = !!t.addedAt && Date.now() - t.addedAt < 8000;
                return (
                  <div key={t.id} className={`task p-${t.priority} ${t.done ? 'done' : ''} ${fresh ? 'fresh' : ''}`}>
                    <div className="task-tags">
                      <button
                        className="tag"
                        title="Click to change priority"
                        onClick={() =>
                          updateTask(t.id, {
                            priority: t.priority === 'high' ? 'medium' : t.priority === 'medium' ? 'low' : 'high',
                          })
                        }
                      >
                        {t.priority === 'high' ? 'Urgent' : t.priority === 'medium' ? 'Normal' : 'Later'}
                      </button>
                      {fresh && <span className="tag new">New</span>}
                      {t.edited && !t.manual && <span className="tag">Edited</span>}
                      <button className="icon task-x" title="Remove" onClick={() => removeTask(t.id)}>
                        ✕
                      </button>
                    </div>
                    <textarea
                      className="task-title"
                      rows={Math.max(1, Math.ceil(t.task.length / 30))}
                      value={t.task}
                      onChange={(e) => updateTask(t.id, { task: e.target.value })}
                    />
                    {t.context && <p className="task-ctx">{t.context}</p>}
                    <div className="task-foot">
                      <label className="chip edit">
                        <Icon name="user" size={12} />
                        <input
                          value={t.owner}
                          placeholder="Owner"
                          size={Math.max(5, t.owner.length + 1)}
                          onChange={(e) => updateTask(t.id, { owner: e.target.value })}
                        />
                      </label>
                      <label className="chip edit">
                        <Icon name="calendar" size={12} />
                        <input
                          value={t.due}
                          placeholder="Due"
                          size={Math.max(3, t.due.length + 1)}
                          onChange={(e) => updateTask(t.id, { due: e.target.value })}
                        />
                      </label>
                      <button
                        className={`check ${t.done ? 'on' : ''}`}
                        title={t.done ? 'Mark as open' : 'Mark as done'}
                        onClick={() => updateTask(t.id, { done: !t.done }, false)}
                      >
                        ✓
                      </button>
                    </div>
                  </div>
                );
              })}
              <form onSubmit={addTask} className="inline-form quick-add">
                <input
                  placeholder="+ Add a task, e.g. lunch at Moon on Monday 12:00 @priya"
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                />
                {quick && (quick.due || quick.owner || quick.priority) && (
                  <div className="quick-preview">
                    <span className="muted small">Will add</span>
                    <b>{quick.task}</b>
                    {quick.due && (
                      <span className="chip">
                        <Icon name="calendar" size={12} /> {quick.due}
                      </span>
                    )}
                    {quick.owner && (
                      <span className="chip">
                        <Icon name="user" size={12} /> {quick.owner}
                      </span>
                    )}
                    {quick.priority && <span className={`chip prio-${quick.priority}`}>{quick.priority === 'high' ? 'Urgent' : quick.priority === 'low' ? 'Later' : 'Normal'}</span>}
                    <span className="muted small">↵ Enter</span>
                  </div>
                )}
              </form>
            </div>
          ) : (
            <div className="notes">
              {!meeting.notes ? (
                <div className="empty">
                  <div className="empty-icon"><Icon name="file" size={20} /></div>
                  <p>Notes will appear after the first refine.</p>
                </div>
              ) : (
                <>
                  {lockedSections(meeting).length > 0 && (
                    <p className="muted small">
                      <Icon name="pencil" size={12} /> Sections you edited keep your wording. Everything else keeps updating live.
                    </p>
                  )}
                  <div className="note-block nb-summary">
                    <h3>Summary</h3>
                    <textarea
                      className="note-edit"
                      rows={Math.max(3, Math.ceil(meeting.notes.summary.length / 60))}
                      value={meeting.notes.summary}
                      onChange={(e) => updateNotes({ summary: e.target.value })}
                    />
                  </div>
                  {(
                    [
                      ['keyPoints', 'Key points', ''],
                      ['decisions', 'Decisions', 'decisions'],
                      ['openQuestions', 'Open questions', 'questions'],
                    ] as const
                  ).map(([key, label, cls]) => (
                    <div key={key} className={`note-block nb-${key}`}>
                      <h3>{label}</h3>
                      <ul className={cls}>
                        {meeting.notes![key].map((p, i) => (
                          <li key={i}>
                            <input className="note-edit line" value={p} onChange={(e) => editList(key, i, e.target.value)} />
                            <button className="icon" title="Remove" onClick={() => editList(key, i, null)}>
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button className="add-line" onClick={() => editList(key, meeting.notes![key].length, '')}>
                        + Add
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </main>

      {roomBanner && (
        <div className="room-banner" onClick={() => setRoomBanner(false)}>
          <div>
            <span className="room-icon">
              <Icon name="mic" size={30} />
            </span>
            <h2>This meeting is being recorded for notes</h2>
            <p>An AI assistant is turning the discussion into notes and a to-do list. Let us know if you would rather not be recorded.</p>
            <small>Click anywhere to close</small>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
    </>
  );
}
