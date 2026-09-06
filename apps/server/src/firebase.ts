import { getApps, initializeApp, type App } from "firebase-admin/app";
import { createHash } from "node:crypto";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import type { Principal } from "@siftera/shared";

export interface FirebaseRuntimeConfig {
  environment: "development" | "test" | "production";
  projectId: string;
  storageBucket: string;
  authEmulatorHost: string | null;
  firestoreEmulatorHost: string | null;
  storageEmulatorHost: string | null;
}

const host = (value: string | undefined, name: string): string | null => {
  if (!value) return null;
  if (!/^127\.0\.0\.1:\d{1,5}$/u.test(value) && !/^localhost:\d{1,5}$/u.test(value))
    throw new Error(`${name} must use localhost in development/test`);
  return value;
};

/** Fails closed for production so emulator tokens can never be accepted there. */
export function createFirebaseRuntimeConfig(env: NodeJS.ProcessEnv = process.env): FirebaseRuntimeConfig {
  const environment = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const projectId = env.FIREBASE_PROJECT_ID;
  const storageBucket = env.FIREBASE_STORAGE_BUCKET;
  if (!projectId || !storageBucket) throw new Error("FIREBASE_PROJECT_ID and FIREBASE_STORAGE_BUCKET are required");
  const emulatorValues = [env.FIREBASE_AUTH_EMULATOR_HOST, env.FIRESTORE_EMULATOR_HOST, env.FIREBASE_STORAGE_EMULATOR_HOST, env.DEV_AUTH_MODE].filter(Boolean);
  if (environment === "production" && emulatorValues.length) throw new Error("production cannot use Firebase emulator or dev auth configuration");
  const config: FirebaseRuntimeConfig = {
    environment,
    projectId,
    storageBucket,
    authEmulatorHost: host(env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST"),
    firestoreEmulatorHost: host(env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST"),
    storageEmulatorHost: host(env.FIREBASE_STORAGE_EMULATOR_HOST, "FIREBASE_STORAGE_EMULATOR_HOST"),
  };
  if (environment !== "production" && (!config.authEmulatorHost || !config.firestoreEmulatorHost || !config.storageEmulatorHost))
    throw new Error("development/test requires all three localhost Firebase emulator hosts");
  return config;
}

/** Uses ADC in production. It intentionally never loads a service-account key from the repository. */
export function createFirebaseAdmin(config: FirebaseRuntimeConfig): App {
  const ambient = {
    auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? null,
    firestore: process.env.FIRESTORE_EMULATOR_HOST ?? null,
    storage: process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? null,
    devAuth: process.env.DEV_AUTH_MODE ?? null,
  };
  if (config.environment === "production") {
    if (ambient.auth || ambient.firestore || ambient.storage || ambient.devAuth)
      throw new Error("production process contains Firebase emulator or dev auth configuration");
  } else if (
    ambient.auth !== config.authEmulatorHost ||
    ambient.firestore !== config.firestoreEmulatorHost ||
    ambient.storage !== config.storageEmulatorHost
  ) {
    throw new Error("Firebase emulator configuration must match the process environment");
  }
  const name = `siftera-${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 24)}`;
  return getApps().find((app) => app.name === name) ?? initializeApp({ projectId: config.projectId, storageBucket: config.storageBucket }, name);
}

export interface FirebaseServices { app: App; auth: Auth; firestore: Firestore; storage: Storage }
export function firebaseServices(config: FirebaseRuntimeConfig): FirebaseServices {
  const app = createFirebaseAdmin(config);
  return { app, auth: getAuth(app), firestore: getFirestore(app), storage: getStorage(app) };
}

export class FirebaseIdentityVerifier {
  constructor(private readonly auth: Auth) {}
  async verifyAuthorizationHeader(header: string | undefined): Promise<Principal> {
    if (!header || !/^Bearer [^\s]+$/u.test(header)) throw new Error("UNAUTHENTICATED");
    const token = header.slice("Bearer ".length);
    const decoded = await this.auth.verifyIdToken(token, true);
    return { uid: decoded.uid, kind: "user", scopes: [] };
  }
}
