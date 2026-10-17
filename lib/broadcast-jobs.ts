// Shared in-memory store for broadcast jobs.
// Persists across requests within a single server process (Render single instance).
export type BroadcastJob = {
  status: 'running' | 'done' | 'error';
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  reasons: Record<string, number>;
  startedAt: number;
  error?: string;
};

const globalForJobs = globalThis as unknown as {
  broadcastJobs?: Record<string, BroadcastJob>;
};

export const broadcastJobs: Record<string, BroadcastJob> =
  globalForJobs.broadcastJobs || (globalForJobs.broadcastJobs = {});
