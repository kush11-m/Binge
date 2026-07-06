const DB_NAME = "binge-local-media";
const STORE_NAME = "rooms";
const DB_VERSION = 1;

export type StoredLocalMedia = {
  roomId: string;
  videoFile: File;
  subsFile?: File | null;
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "roomId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open local media store."));
  });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local media store request failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Local media store transaction failed."));
    };
  }));
}

export function saveLocalMedia(roomId: string, videoFile: File, subsFile?: File | null) {
  return transact("readwrite", (store) => store.put({
    roomId,
    videoFile,
    subsFile: subsFile || null,
    savedAt: Date.now()
  }));
}

export function getLocalMedia(roomId: string): Promise<StoredLocalMedia | undefined> {
  return transact("readonly", (store) => store.get(roomId));
}

export function deleteLocalMedia(roomId: string) {
  return transact("readwrite", (store) => store.delete(roomId));
}
