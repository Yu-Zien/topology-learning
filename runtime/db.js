import { createInitialState, reduceState, validateState, validateBackup, makeBackup } from './state.js';
import { initializeFlow } from './flow.js';

// One authoritative state record makes each log+card+session mutation atomic.
// All read-modify-writes happen inside an IDB transaction, including across tabs.
export async function openStore({ name = 'topology-learning-v1', catalog, clock = () => new Date().toISOString(), failWrites = false } = {}) {
  if (!globalThis.indexedDB) throw new Error('此浏览器无法使用 IndexedDB，学习记录尚未保存');
  if (!catalog) throw new Error('缺少课程目录');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('learning');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地学习记录'));
    request.onblocked = () => reject(new Error('请关闭其他旧版本学习页面后重试'));
  });
  db.onversionchange = () => db.close();
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name+'-updates') : null;
  const listeners = new Set();
  if(channel)channel.onmessage=()=>listeners.forEach(fn=>fn());
  const shouldFail = () => typeof failWrites === 'function' ? failWrites() : failWrites;

  function transact(mode, operation) {
    return new Promise((resolve, reject) => {
      let result, failure;
      const transaction = db.transaction('learning', mode);
      const store = transaction.objectStore('learning');
      const request = store.get('state');
      request.onsuccess = () => {
        try {
          const existing = request.result;
          const state = existing ? validateState(existing, catalog) : createInitialState(catalog, clock());
          result = operation(state);
          if (mode === 'readwrite') {
            if (shouldFail()) throw new Error('测试注入：写入失败，记录未保存');
            store.put(result, 'state');
          }
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => { failure ||= transaction.error; };
      transaction.onabort = () => reject(failure || transaction.error || new Error('本地写入失败，记录未保存'));
    });
  }
  return {
    read: () => transact('readonly', state => state),
    async dispatch(action) {
      const result=await transact('readwrite', state => reduceState(state, action, catalog, clock()));
      channel?.postMessage('saved');return result;
    },
    async replace(backup) {
      const checked = validateBackup(backup, catalog); // Validate before opening any write transaction.
      initializeFlow(checked.state, catalog); // Add route metadata; never infer confirmations or ratings.
      checked.state = await transact('readwrite', current => ({ ...checked.state, revision: current.revision + 1 }));
      channel?.postMessage('saved');
      return checked;
    },
    async exportBackup() { return makeBackup(await transact('readonly', state => state), catalog, clock()); },
    subscribe: fn => {listeners.add(fn);return ()=>listeners.delete(fn);},
    close: () => {channel?.close();db.close();},
  };
}
