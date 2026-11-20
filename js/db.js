// IndexedDB: notebooks（ノート）と pages（ページ）を保存する
const DB_NAME = 'tegaki', VER = 2;
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('notebooks')) d.createObjectStore('notebooks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' }).createIndex('nb', 'notebookId');
      if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' }); // v2: 分野フォルダ
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  notebooks: () => tx(['notebooks'], 'readonly', (t) => req(t.objectStore('notebooks').getAll())),
  notebook: (id) => tx(['notebooks'], 'readonly', (t) => req(t.objectStore('notebooks').get(id))),
  putNotebook: (nb) => tx(['notebooks'], 'readwrite', (t) => { t.objectStore('notebooks').put(nb); }),
  // ページは notebook.pageIds の順に並べて返す
  pages: (nb) => tx(['pages'], 'readonly', async (t) => {
    const all = await req(t.objectStore('pages').index('nb').getAll(nb.id));
    const m = new Map(all.map((p) => [p.id, p]));
    return nb.pageIds.map((id) => m.get(id)).filter(Boolean);
  }),
  putPages: (pages, nb) => tx(['pages', 'notebooks'], 'readwrite', (t) => {
    const s = t.objectStore('pages');
    for (const p of pages) s.put(p);
    if (nb) t.objectStore('notebooks').put(nb);
  }),
  deletePage: (id, nb) => tx(['pages', 'notebooks'], 'readwrite', (t) => {
    t.objectStore('pages').delete(id);
    t.objectStore('notebooks').put(nb);
  }),
  deleteNotebook: (nb) => tx(['pages', 'notebooks'], 'readwrite', (t) => {
    const s = t.objectStore('pages');
    for (const id of nb.pageIds) s.delete(id);
    t.objectStore('notebooks').delete(nb.id);
  }),
  folders: () => tx(['folders'], 'readonly', (t) => req(t.objectStore('folders').getAll())),
  putFolder: (f) => tx(['folders'], 'readwrite', (t) => { t.objectStore('folders').put(f); }),
  // フォルダを消し、中のノートは未分類にする
  deleteFolder: (f, notebooks) => tx(['folders', 'notebooks'], 'readwrite', (t) => {
    t.objectStore('folders').delete(f.id);
    for (const nb of notebooks) t.objectStore('notebooks').put({ ...nb, folderId: null });
  }),
  exportAll: () => tx(['pages', 'notebooks', 'folders'], 'readonly', async (t) => ({
    app: 'tegaki', version: 2, exportedAt: new Date().toISOString(),
    folders: await req(t.objectStore('folders').getAll()),
    notebooks: await req(t.objectStore('notebooks').getAll()),
    pages: await req(t.objectStore('pages').getAll()),
  })),
  importAll: (data) => tx(['pages', 'notebooks', 'folders'], 'readwrite', (t) => {
    for (const f of data.folders || []) t.objectStore('folders').put(f);
    for (const nb of data.notebooks) t.objectStore('notebooks').put(nb);
    for (const p of data.pages) t.objectStore('pages').put(p);
  }),
};
