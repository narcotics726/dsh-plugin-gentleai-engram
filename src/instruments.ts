import type { CandidateMetering } from './recall/protocol.js';

/**
 * The write layer's instruments (design D9).
 *
 * What they are: session-scoped counters in the plugin's own memory, written to
 * the log, answering questions that only become answerable once the feature is
 * running — is the derived index lagging; is the pool empty; is one document
 * dominating every pool; did the model ever look at a candidate's full text
 * before judging it.
 *
 * What they are NOT: behaviour. They never change a ranking, never gate a tool,
 * never persist anything (no file, no DB), never outlive the process, and are
 * dropped with the session. The one thing the spec explicitly allows is exactly
 * this: in-memory counters for self-diagnosis.
 *
 * The numbers are per-CALL, not aggregates: the plugin keeps no history, so a
 * "rate" is something the operator reads off repeated log lines.
 */

interface SessionCounters {
  /** Ids this session has been shown: retrieval hits plus fetched full texts. */
  seen: Set<number>;
  /**
   * Ids this very session wrote through `mem_bridge_save`. They are excluded from
   * the "was it read first" question: the model just wrote that row's content, so
   * demanding a `mem_get_observation` for it would make every verdict look blind.
   */
  written: Set<number>;
  /** Verdict verb -> count. `not_conflict` is counted like any other. */
  verdicts: Map<string, number>;
  /** How many verdicts were cast after the ids involved had been read in full. */
  readFirst: number;
  /** How many verdicts were cast without that. */
  blind: number;
  /** Verdicts whose call carried no observation pair at all (see `noteVerdict`). */
  unknown: number;
}

export interface CandidateInstrumentInput {
  sessionId: string;
  /** The ranked pool BEFORE the project filter: what the scorer actually brought up. */
  poolIds: readonly number[];
  /** The candidates actually shown to the model. */
  shownIds: readonly number[];
  metering: CandidateMetering;
  /** Why the lookup produced nothing, when it did not run or did not finish. */
  degraded?: string;
}

export interface VerdictInstrument {
  verb: string;
  /** Whether every id involved had been read in full earlier in this session. */
  readFirst: boolean;
  /** Verdict counts so far in this session, by verb. */
  distribution: Record<string, number>;
}

export class SaveInstruments {
  readonly #sessions = new Map<string, SessionCounters>();

  #of(sessionId: string): SessionCounters {
    let counters = this.#sessions.get(sessionId);
    if (counters === undefined) {
      counters = {
        seen: new Set(),
        written: new Set(),
        verdicts: new Map(),
        readFirst: 0,
        blind: 0,
        unknown: 0,
      };
      this.#sessions.set(sessionId, counters);
    }
    return counters;
  }

  /** Retrieved (or otherwise shown) observation ids: one half of the consistency question. */
  noteSeen(sessionId: string, ids: readonly number[]): void {
    const counters = this.#of(sessionId);
    for (const id of ids) counters.seen.add(id);
  }

  /**
   * The consistency rate (design D9.4): of the ids in the candidate pool, how
   * many had this session already been shown? It needs no labels, and it asks
   * the question the write layer exists to answer — was the thing the model just
   * looked at among the candidates?
   */
  consistency(sessionId: string, poolIds: readonly number[]): { hits: number; pool: number } {
    const pool = [...new Set(poolIds)];
    const counters = this.#sessions.get(sessionId);
    if (counters === undefined) return { hits: 0, pool: pool.length };
    let hits = 0;
    for (const id of pool) if (counters.seen.has(id)) hits++;
    return { hits, pool: pool.length };
  }

  /**
   * Whether the model pulled the FULL text of a candidate before judging it
   * (design D9.5 / D12b). This is the only observable that can answer "does a
   * compact evidence line make the model lazy"; it records, it does not scold.
   */
  noteObservationRead(sessionId: string, id: number): void {
    this.#of(sessionId).seen.add(id);
  }

  /** Record the id one of this session's saves wrote; see `SessionCounters.written`. */
  noteSaved(sessionId: string, id: number): void {
    const counters = this.#of(sessionId);
    counters.written.add(id);
    counters.seen.add(id);
  }

  /**
   * Record one verdict: its verb, and whether the ids involved had been read in
   * full first. Ids the model never fetched count as "blind" — including the
   * `not_conflict` verdicts, which write no row at all yet are the most common
   * outcome (design D7).
   *
   * `ids === undefined` means "this call does not carry the pair" (the two-step
   * retraction path takes a relation id): the verb is counted, and the
   * read-first question is left unanswered rather than guessed.
   */
  noteVerdict(sessionId: string, verb: string, ids: readonly number[] | undefined): VerdictInstrument {
    const counters = this.#of(sessionId);
    counters.verdicts.set(verb, (counters.verdicts.get(verb) ?? 0) + 1);
    // "Read first" asks about the side the model did NOT just write: a row this
    // session saved is already in front of it, so only the other end has to have
    // been fetched in full.
    const readFirst =
      ids !== undefined &&
      ids.length > 0 &&
      ids.every((id) => counters.written.has(id) || counters.seen.has(id));
    if (ids === undefined) {
      counters.unknown++;
    } else if (readFirst) {
      counters.readFirst++;
    } else {
      counters.blind++;
    }
    return {
      verb,
      readFirst,
      distribution: Object.fromEntries([...counters.verdicts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    };
  }

  /**
   * The candidate lookup's one log line: lag (the read layer's own judgement),
   * pool composition, and how much of the pool this session had already seen.
   * One line per call, because the plugin stores no history — a rate is read off
   * repeated lines.
   */
  candidateLine(input: CandidateInstrumentInput): string {
    const { metering } = input;
    const pool = [...new Set(input.poolIds)];
    const consistency = this.consistency(input.sessionId, input.poolIds);
    const parts = [
      `落后=${metering.sourceChanged ? 'true' : 'false'}`,
      `落后规模=${metering.lagDocs}`,
      `索引条数=${metering.docCount}`,
      `池首位=${pool.length === 0 ? '(空)' : `#${pool[0]}`}`,
      `池内文档数=${pool.length}`,
      `展示=${input.shownIds.length}`,
      `一致=${consistency.hits}/${consistency.pool}`,
      `耗时=${metering.totalMs.toFixed(0)}ms`,
    ];
    if (input.degraded !== undefined) parts.push(`降级=${input.degraded}`);
    return `保存候选计量：${parts.join(' ')}`;
  }

  /** Verdict line for the log. */
  verdictLine(sessionId: string, verdict: VerdictInstrument): string {
    const counters = this.#sessions.get(sessionId);
    const distribution = Object.entries(verdict.distribution)
      .map(([verb, count]) => `${verb}=${count}`)
      .join(' ');
    return (
      `下判：关系=${verdict.verb} 下判前读过候选全文=${verdict.readFirst ? 'true' : 'false'} ` +
      `判词分布 ${distribution} 看过=${counters?.readFirst ?? 0} 未看=${counters?.blind ?? 0} ` +
      `未定=${counters?.unknown ?? 0}`
    );
  }

  /** Diagnostics/tests: the counters as they stand. Nothing here is persisted. */
  snapshot(sessionId: string): {
    seen: number[];
    verdicts: Record<string, number>;
    readFirst: number;
    blind: number;
    unknown: number;
  } {
    const counters = this.#sessions.get(sessionId);
    if (counters === undefined) return { seen: [], verdicts: {}, readFirst: 0, blind: 0, unknown: 0 };
    return {
      seen: [...counters.seen].sort((a, b) => a - b),
      verdicts: Object.fromEntries(counters.verdicts),
      readFirst: counters.readFirst,
      blind: counters.blind,
      unknown: counters.unknown,
    };
  }

  /** Drop one session's counters (session teardown). */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
