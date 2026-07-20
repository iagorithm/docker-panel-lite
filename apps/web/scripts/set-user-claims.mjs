import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const [email, role = "admin", workspaceId = "default"] = process.argv.slice(2);
if (!email || !["viewer", "operator", "admin"].includes(role)) {
  console.error("Usage: npm run set-user-claims -- user@example.com admin default");
  process.exit(1);
}
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const credential = serviceAccount ? cert(JSON.parse(serviceAccount)) : applicationDefault();
const app = getApps()[0] ?? initializeApp({ credential });
const auth = getAuth(app);
const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role, workspaceId, admin: role === "admin" });
await auth.revokeRefreshTokens(user.uid);
console.log(`Updated ${email}: role=${role}, workspaceId=${workspaceId}. Sign in again to refresh the claims.`);
