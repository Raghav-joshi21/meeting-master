import type { MeetingNotes } from './api/refine/route';
import type { Speaker } from './diarizer';

export type Segment = {
  id: number;
  t: number;
  text: string;
  speaker?: string;
  live?: boolean; // still being recognised
  raw?: string; // what the mic heard, before AI polish / user edit
  polished?: boolean; // AI cleanup pass done
  edited?: boolean; // corrected by the user; AI never touches it again
  typed?: boolean; // typed in as a note, not heard
};
export type Task = Omit<MeetingNotes['tasks'][number], 'kind' | 'quote'> & {
  id: string;
  done: boolean;
  manual?: boolean; // added by the user
  edited?: boolean; // changed by the user; AI refreshes keep it as-is
  origKey?: string; // key of the AI task this came from, to avoid re-adding it
  addedAt?: number;
  dueAt?: number; // parsed deadline, when known
};
export type Meeting = {
  id: string;
  createdAt: number;
  duration: number;
  segments: Segment[];
  speakers?: Speaker[]; // optional: meetings saved before speaker detection have none
  notes: Omit<MeetingNotes, 'tasks' | 'speakerNames'> | null;
  notesEdited?: boolean; // legacy: all sections locked
  notesLocked?: ('title' | 'summary' | 'keyPoints' | 'decisions' | 'openQuestions')[]; // sections the user edited
  chat?: ChatMsg[];
  finalizedAt?: number; // when the end-of-meeting pass over the whole transcript ran
  tasks: Task[];
};

export type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cited?: number[]; // segment ids
  changes?: string[]; // human-readable list of what the assistant changed
  error?: boolean;
};
