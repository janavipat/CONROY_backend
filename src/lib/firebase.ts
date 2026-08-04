import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { env } from "../config/env.js";

/**
 * True once a Firebase service account is configured. Firebase console →
 * Project settings → Service accounts → Generate new private key gives you
 * all three values (project_id, client_email, private_key).
 */
export const firebaseConfigured = Boolean(
  env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
);

let db: Firestore | null = null;

/**
 * Lazily initialises the Firebase Admin app and returns a Firestore handle.
 * Private keys from a downloaded service account JSON contain literal `\n`
 * escapes once they pass through a .env file — un-escape them here.
 */
function getDb(): Firestore | null {
  if (!firebaseConfigured) return null;
  if (!db) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    }
    db = getFirestore();
  }
  return db;
}

interface FirebaseMailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Queues an email by writing a document to the Firestore collection the
 * "Trigger Email" extension watches (default: "mail"). The extension picks
 * it up and sends it via whatever SMTP provider was configured when the
 * extension was installed — Firebase itself doesn't deliver the email.
 */
export async function queueFirebaseMail({ to, subject, html, text }: FirebaseMailArgs): Promise<void> {
  const firestore = getDb();
  if (!firestore) return;
  await firestore.collection(env.FIREBASE_MAIL_COLLECTION).add({
    to,
    message: { subject, html, text },
  });
}
