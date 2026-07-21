export type CredentialAccessUser = {
  uid: string;
  email?: string;
};

export type CredentialAccessRecord = Record<string, unknown> & {
  ownerUid?: string;
  createdBy?: string;
  sharing?: "private" | "shared" | "public";
  public?: boolean;
  sharedEmails?: unknown;
};

export function normalizeCredentialEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function credentialOwnerUid(credential: CredentialAccessRecord) {
  return String(credential.ownerUid || credential.createdBy || "").trim();
}

export function credentialSharedEmails(credential: CredentialAccessRecord) {
  const value = credential.sharedEmails;
  const emails = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : typeof value === "string"
        ? value.split(/[\s,;]+/)
        : [];
  return [...new Set(emails.map(normalizeCredentialEmail).filter(Boolean))];
}

export function credentialSharingMode(credential: CredentialAccessRecord): "private" | "shared" | "public" {
  if (credential.sharing === "private" || credential.sharing === "shared" || credential.sharing === "public") return credential.sharing;
  if (credential.public === true) return "public";
  // Legacy `shared: true` records stay private until their owner explicitly shares them.
  return "private";
}

export function canManageCredential(credential: CredentialAccessRecord, user: CredentialAccessUser) {
  const ownerUid = credentialOwnerUid(credential);
  return Boolean(ownerUid && ownerUid === user.uid);
}

export function canAccessCredential(credential: CredentialAccessRecord, user: CredentialAccessUser) {
  if (canManageCredential(credential, user)) return true;
  const sharing = credentialSharingMode(credential);
  if (sharing === "public") return true;
  if (sharing !== "shared") return false;
  const email = normalizeCredentialEmail(user.email);
  return Boolean(email && credentialSharedEmails(credential).includes(email));
}

export function sanitizeCredentialForClient<T extends CredentialAccessRecord>(credential: T, user: CredentialAccessUser): Record<string, unknown> {
  const safeCredential = { ...credential };
  if (!canManageCredential(credential, user)) delete safeCredential.sharedEmails;
  return safeCredential;
}
