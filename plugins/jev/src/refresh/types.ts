import type { CatalogueSource, ProbeResult } from '../core/catalogue.js';

/** What a discoverer hands to `buildCatalogue`, plus the bookkeeping the command prints. */
export interface DiscoveryOutcome {
  source: CatalogueSource;
  results: ProbeResult[];
  /** Paid calls made (Claude Code probe only). */
  calls: number;
  /** Sum of `total_cost_usd` reported by the probes. */
  costUsd: number;
  /** Candidate ids not probed because of the call cap. */
  dropped: string[];
  /** Why the run stopped early, when it did. */
  aborted?: string;
  /** Ids that were probed but gave no usable answer (timeout, spawn failure, rate limit): left as they were. */
  inconclusive: string[];
  notes: string[];
}

export type LogFn = (line: string) => void;
