/** The workspace's own word for a job (for example Project), in the four forms screens and messages need. */
export interface JobTerms {
  /** Lowercase singular, for the middle of a sentence. */
  job: string;
  jobs: string;
  /** Capitalised, for headings and buttons. */
  Job: string;
  Jobs: string;
}

export const DEFAULT_JOB_WORD = "Job";
export const DEFAULT_JOB_WORD_PLURAL = "Jobs";
export const MAX_JOB_WORD_LENGTH = 30;

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Tidies what an admin typed: letters, numbers, spaces, hyphens and apostrophes only. Empty falls back to the default. */
export function cleanJobWord(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const s = raw
    .replace(/[^\p{L}\p{N} '’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_JOB_WORD_LENGTH)
    .trim();
  return s || fallback;
}

export function jobTerms(config?: { jobWord?: string; jobWordPlural?: string } | null): JobTerms {
  const one = cleanJobWord(config?.jobWord, DEFAULT_JOB_WORD);
  const many = cleanJobWord(config?.jobWordPlural, one === DEFAULT_JOB_WORD ? DEFAULT_JOB_WORD_PLURAL : `${one}s`);
  return { job: lowerFirst(one), jobs: lowerFirst(many), Job: upperFirst(one), Jobs: upperFirst(many) };
}

/** "a project", "an estimate": the right article for the word the workspace chose. */
export function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** Same as withArticle for the start of a sentence: "A project", "An estimate". */
export function withArticleCap(word: string): string {
  return upperFirst(withArticle(word));
}

export const DEFAULT_LABOUR_WORD = "Labour";

/** The workspace's name for the Labour tab. */
export function labourTerm(config?: { labourWord?: string } | null): string {
  return upperFirst(cleanJobWord(config?.labourWord, DEFAULT_LABOUR_WORD));
}

export const DEFAULT_ACTIVITY_WORD = "Activity";

/** The workspace's name for the kind of time picked on a project (Activity, Task, Work type). */
export function activityTerm(config?: { activityWord?: string } | null): string {
  return upperFirst(cleanJobWord(config?.activityWord, DEFAULT_ACTIVITY_WORD));
}

export interface WorkerTerms {
  /** Lowercase singular, for the middle of a sentence. */
  worker: string;
  workers: string;
  /** Capitalised, for headings and buttons. */
  Worker: string;
  Workers: string;
}

export const DEFAULT_WORKER_WORD = "Worker";
export const DEFAULT_WORKER_WORD_PLURAL = "Workers";

/** The workspace's own word for the people who do the work (for example Staff). */
export function workerTerms(config?: { workerWord?: string; workerWordPlural?: string } | null): WorkerTerms {
  const one = cleanJobWord(config?.workerWord, DEFAULT_WORKER_WORD);
  const many = cleanJobWord(
    config?.workerWordPlural,
    one === DEFAULT_WORKER_WORD ? DEFAULT_WORKER_WORD_PLURAL : `${one}s`,
  );
  return { worker: lowerFirst(one), workers: lowerFirst(many), Worker: upperFirst(one), Workers: upperFirst(many) };
}
