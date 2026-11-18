// Tiny IndexedDB wrapper. Stores recordings (WAV blobs + metadata) and settings.
const DB_NAME = "voicebank";
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const saveRecording = (rec) => tx("recordings", "readwrite", (s) => s.put(rec));
export const getRecording = (id) => tx("recordings", "readonly", (s) => s.get(id));
export const deleteRecording = (id) => tx("recordings", "readwrite", (s) => s.delete(id));
export const allRecordings = () => tx("recordings", "readonly", (s) => s.getAll());
export const clearRecordings = () => tx("recordings", "readwrite", (s) => s.clear());

export const getSetting = (key) => tx("kv", "readonly", (s) => s.get(key));
export const setSetting = (key, value) => tx("kv", "readwrite", (s) => s.put(value, key));
