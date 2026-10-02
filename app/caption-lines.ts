// Turns Chrome's SpeechRecognition result events into stable transcript lines.
//
// Chrome is inconsistent about how it reports results: some builds append each
// phrase as a new result slot, others reuse slot 0 for every phrase; finals are
// sometimes cut down to the last word (or empty), and occasionally a slot jumps
// straight to a different phrase. Rules here:
//   - every phrase gets its own line, written as soon as it is heard;
//   - a line never loses words it already showed (a shrunken final keeps them);
//   - a slot whose text changes to a different phrase starts a new line instead
//     of overwriting the old one.

export type CaptionResult = { text: string; isFinal: boolean };
export type CaptionUpdate = {
  upserts: { id: number; text: string; isNew: boolean }[];
  finished: number[]; // line ids that are complete
};

const words = (t: string) => (t ? t.split(/\s+/).length : 0);

/** Share of `a`'s words that also appear in `b`. */
function overlap(a: string, b: string) {
  const B = new Set(b.toLowerCase().split(/\s+/));
  const A = a.toLowerCase().split(/\s+/).filter(Boolean);
  return A.length ? A.filter((w) => B.has(w)).length / A.length : 1;
}

export class CaptionLines {
  private lineFor = new Map<number, number>(); // result slot -> line id
  private longest = new Map<number, string>(); // longest text shown for the slot's current line
  private finishedSlots = new Set<number>();
  readonly lines: number[] = [];

  constructor(private nextId: () => number) {}

  handle(results: ArrayLike<CaptionResult>, resultIndex: number): CaptionUpdate {
    const upserts: CaptionUpdate['upserts'] = [];
    const finished: number[] = [];

    for (let i = resultIndex; i < results.length; i++) {
      const r = results[i];
      let text = r.text.trim();

      // Slot reused after it was finalised: new phrase, new line.
      if (this.finishedSlots.has(i)) {
        this.finishedSlots.delete(i);
        this.lineFor.delete(i);
        this.longest.delete(i);
      }

      const best = this.longest.get(i) ?? '';
      const differentPhrase = !!text && words(best) >= 3 && overlap(best, text) < 0.3 && overlap(text, best) < 0.5;
      if (differentPhrase) {
        // Keep the old line exactly as heard; the new phrase gets its own line.
        const oldId = this.lineFor.get(i);
        if (oldId !== undefined) finished.push(oldId);
        this.lineFor.delete(i);
        this.longest.set(i, text);
      } else if (words(text) >= words(best)) {
        this.longest.set(i, text);
      } else if (r.isFinal && words(text) < words(best) * 0.6) {
        text = best; // final cut short (or empty): keep what was heard
      }

      if (!text) continue;
      let id = this.lineFor.get(i);
      const isNew = id === undefined;
      if (isNew) {
        id = this.nextId();
        this.lineFor.set(i, id);
        this.lines.push(id);
      }
      upserts.push({ id: id!, text, isNew });
      if (r.isFinal) {
        finished.push(id!);
        this.finishedSlots.add(i);
      }
    }
    return { upserts, finished };
  }
}
