import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

function serviceAccountCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return applicationDefault();
  return cert(JSON.parse(raw));
}

const adminApp =
  getApps()[0] ??
  initializeApp({
    credential: serviceAccountCredential(),
    databaseURL: process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  });

export const adminAuth = getAuth(adminApp);
export const adminDatabase = getDatabase(adminApp);
