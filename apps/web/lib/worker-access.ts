export type WorkerAccessUser = {
  uid: string;
  email?: string;
};

export type WorkerAccessRecord = Record<string, unknown> & {
  ownerUid?: string;
  sharing?: "private" | "shared" | "public";
  public?: boolean;
  shared?: boolean;
  sharedEmails?: unknown;
};

export function normalizeWorkerEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function workerSharedEmails(worker: WorkerAccessRecord) {
  const value = worker.sharedEmails;
  const emails = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : typeof value === "string"
        ? value.split(/[\s,;]+/)
        : [];
  return [...new Set(emails.map(normalizeWorkerEmail).filter(Boolean))];
}

export function workerSharingMode(worker: WorkerAccessRecord): "private" | "shared" | "public" {
  if (worker.sharing === "private" || worker.sharing === "shared" || worker.sharing === "public") return worker.sharing;
  if (worker.public === true) return "public";
  if (worker.shared === true) return "shared";
  return "private";
}

export function isWorkerClaimed(worker: WorkerAccessRecord) {
  return Boolean(String(worker.ownerUid || "").trim());
}

export function canManageWorker(worker: WorkerAccessRecord, user: WorkerAccessUser) {
  return isWorkerClaimed(worker) && String(worker.ownerUid) === user.uid;
}

export function canAccessWorker(worker: WorkerAccessRecord, user: WorkerAccessUser) {
  if (!isWorkerClaimed(worker)) return false;
  if (canManageWorker(worker, user)) return true;
  const sharing = workerSharingMode(worker);
  if (sharing === "public") return true;
  if (sharing !== "shared") return false;
  const email = normalizeWorkerEmail(user.email);
  return Boolean(email && workerSharedEmails(worker).includes(email));
}

export function sanitizeWorkerForClient<T extends WorkerAccessRecord>(worker: T, user: WorkerAccessUser): Record<string, unknown> {
  const { workerTokenHash: _workerTokenHash, claimTokenHash: _claimTokenHash, ...safeWorker } = worker;
  if (!canManageWorker(worker, user)) delete safeWorker.sharedEmails;
  return safeWorker;
}
