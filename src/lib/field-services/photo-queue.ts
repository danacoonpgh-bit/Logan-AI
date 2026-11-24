const DB_NAME = "field-photo-queue";
const STORE = "photos";
const MAX_AGE_MS = 7 * 24 * 3_600_000;

export interface QueuedPhoto {
  id: string;
  subAccountId: string;
  visitId: string;
  uid: string;
  label: string;
  note: string;
  photo: Blob;
  thumb: Blob;
  queuedAt: number;
  lastError: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function enqueuePhoto(
  entry: Omit<QueuedPhoto, "id" | "queuedAt" | "lastError">,
): Promise<boolean> {
  try {
    await run("readwrite", (s) =>
      s.put({ ...entry, id: crypto.randomUUID(), queuedAt: Date.now(), lastError: null }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function listQueued(): Promise<QueuedPhoto[]> {
  try {
    const all = await run<QueuedPhoto[]>("readonly", (s) => s.getAll());
    const fresh = all.filter((p) => Date.now() - p.queuedAt < MAX_AGE_MS);
    for (const old of all) if (!fresh.includes(old)) void removeQueued(old.id);
    return fresh;
  } catch {
    return [];
  }
}

export async function removeQueued(id: string): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(id));
  } catch {
  }
}

export async function markFailed(id: string, message: string): Promise<void> {
  try {
    const row = await run<QueuedPhoto | undefined>("readonly", (s) => s.get(id));
    if (row) await run("readwrite", (s) => s.put({ ...row, lastError: message }));
  } catch {
  }
}
