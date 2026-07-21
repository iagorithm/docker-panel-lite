export type RepositoryAccessUser = {
  uid: string;
  email?: string;
};

export type RepositoryAccessRecord = Record<string, unknown> & {
  ownerUid?: string;
  createdBy?: string;
  sharing?: "private" | "shared" | "public";
  public?: boolean;
  sharedEmails?: unknown;
};

export function normalizeRepositoryEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function repositoryOwnerUid(repository: RepositoryAccessRecord) {
  return String(repository.ownerUid || repository.createdBy || "").trim();
}

export function repositorySharedEmails(repository: RepositoryAccessRecord) {
  const value = repository.sharedEmails;
  const emails = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : typeof value === "string"
        ? value.split(/[\s,;]+/)
        : [];
  return [...new Set(emails.map(normalizeRepositoryEmail).filter(Boolean))];
}

export function repositorySharingMode(repository: RepositoryAccessRecord): "private" | "shared" | "public" {
  if (repository.sharing === "private" || repository.sharing === "shared" || repository.sharing === "public") return repository.sharing;
  if (repository.public === true) return "public";
  // Legacy workspace-wide records stay private until their owner explicitly shares them.
  return "private";
}

export function canManageRepository(repository: RepositoryAccessRecord, user: RepositoryAccessUser) {
  const ownerUid = repositoryOwnerUid(repository);
  return Boolean(ownerUid && ownerUid === user.uid);
}

export function canAccessRepository(repository: RepositoryAccessRecord, user: RepositoryAccessUser) {
  if (canManageRepository(repository, user)) return true;
  const sharing = repositorySharingMode(repository);
  if (sharing === "public") return true;
  if (sharing !== "shared") return false;
  const email = normalizeRepositoryEmail(user.email);
  return Boolean(email && repositorySharedEmails(repository).includes(email));
}

export function sanitizeRepositoryForClient<T extends RepositoryAccessRecord>(repository: T, user: RepositoryAccessUser): Record<string, unknown> {
  const safeRepository = { ...repository };
  if (!canManageRepository(repository, user)) delete safeRepository.sharedEmails;
  return safeRepository;
}
