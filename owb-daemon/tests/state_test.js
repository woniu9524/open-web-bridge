/**
 * export_state / import_state 页面表达式的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 STATE_EXPORT_EXPR / STATE_IMPORT_EXPR，
 * 用 mock 的 localStorage / sessionStorage / IndexedDB 验证：
 *   导出结构（keyPath 元数据、records k/v）、恢复（外线键 vs keyPath 两种 put 路径）、
 *   ls/ss 清空重建、缺失 store 容错。
 *
 * 运行：node owb-daemon/tests/state_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "owb-extension", "background.js"), "utf8")
  .replace(/\r\n/g, "\n");
const exportMatch = bg.match(/const STATE_EXPORT_EXPR = `([\s\S]*?)`;\n/);
const importMatch = bg.match(/const STATE_IMPORT_EXPR = `([\s\S]*?)`;\n/);
if (!exportMatch || !importMatch) {
  console.error("[FAIL] 无法从 background.js 提取 STATE 表达式");
  process.exit(1);
}
const EXPORT_SRC = exportMatch[1];
const IMPORT_SRC = importMatch[1];

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- Storage mock ----
function makeStorage() {
  let map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    clear() { map = new Map(); },
    _map: () => map,
  };
}

// ---- IndexedDB mock ----
// 数据结构：{ dbName: { storeName: { keyPath, autoIncrement, records: [{k, v}] } } }
function makeIDB(data) {
  return {
    databases: async () => Object.keys(data).map((name) => ({ name })),
    open(name) {
      const req = {};
      setTimeout(() => {
        const dbData = data[name];
        if (!dbData) { req.error = "not found"; req.onerror && req.onerror(); return; }
        req.result = makeDB(dbData);
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
}

function makeDB(stores) {
  return {
    get objectStoreNames() { return Object.keys(stores); },
    transaction(sn) {
      const storeData = stores[sn];
      const store = {
        keyPath: storeData.keyPath,
        autoIncrement: storeData.autoIncrement,
        getAllKeys() {
          const r = {};
          setTimeout(() => { r.result = storeData.records.map((x) => x.k); r.onsuccess && r.onsuccess(); }, 0);
          return r;
        },
        getAll() {
          const r = {};
          setTimeout(() => { r.result = storeData.records.map((x) => x.v); r.onsuccess && r.onsuccess(); }, 0);
          return r;
        },
        clear() { storeData.records = []; },
        put(v, k) {
          if (storeData.keyPath == null) {
            storeData.records = storeData.records.filter((x) => x.k !== k);
            storeData.records.push({ k, v });
          } else {
            const kp = storeData.keyPath;
            storeData.records = storeData.records.filter((x) => x.v[kp] !== v[kp]);
            storeData.records.push({ k: v[kp], v });
          }
        },
      };
      const tx = { objectStore: () => store, oncomplete: null, onerror: null };
      setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 5);
      return tx;
    },
    close() {},
  };
}

(async () => {
  // ---- 场景 1：导出 ----
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  localStorage.setItem("token", "abc");
  sessionStorage.setItem("tmp", "1");
  const idbData = {
    sdkdb: {
      device: { keyPath: "id", autoIncrement: false,
                records: [{ k: 1, v: { id: 1, fp: "fp-001" } }] },
      kv: { keyPath: null, autoIncrement: false,
            records: [{ k: "ck", v: "cookie-cache" }] },
    },
  };
  global.indexedDB = makeIDB(idbData);

  const dump = await eval(EXPORT_SRC);
  check("导出 ls", dump.ls.token === "abc", JSON.stringify(dump.ls));
  check("导出 ss", dump.ss.tmp === "1");
  check("导出 idb keyPath store",
    dump.idb.sdkdb.device.keyPath === "id" &&
    dump.idb.sdkdb.device.records[0].v.fp === "fp-001",
    JSON.stringify(dump.idb.sdkdb.device));
  check("导出 idb 外线键 store",
    dump.idb.sdkdb.kv.keyPath === null && dump.idb.sdkdb.kv.records[0].k === "ck");

  // ---- 场景 2：导入到"干净的"环境 ----
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  localStorage.setItem("stale", "should-be-cleared");
  const idbData2 = {
    sdkdb: {
      device: { keyPath: "id", autoIncrement: false, records: [] },
      kv: { keyPath: null, autoIncrement: false, records: [] },
    },
  };
  global.indexedDB = makeIDB(idbData2);

  const importFn = eval(IMPORT_SRC);
  const result = await importFn(dump);
  check("导入 ls 条数 + 清 stale",
    result.ls === 1 && localStorage.getItem("stale") === null && localStorage.getItem("token") === "abc",
    JSON.stringify({ result, stale: localStorage.getItem("stale") }));
  check("导入 ss", result.ss === 1 && sessionStorage.getItem("tmp") === "1");
  check("导入 idb keyPath store 恢复",
    idbData2.sdkdb.device.records.length === 1 && idbData2.sdkdb.device.records[0].v.fp === "fp-001",
    JSON.stringify(idbData2.sdkdb.device.records));
  check("导入 idb 外线键 store 恢复",
    idbData2.sdkdb.kv.records.length === 1 && idbData2.sdkdb.kv.records[0].k === "ck"
    && idbData2.sdkdb.kv.records[0].v === "cookie-cache");

  // ---- 场景 3：store 缺失容错 ----
  global.indexedDB = makeIDB({ sdkdb: {} }); // 目标 DB 没有 store
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  const result3 = await importFn(dump);
  check("缺失 store 容错",
    result3.idb.sdkdb.errors && result3.idb.sdkdb.errors.some((e) => e.includes("store missing")),
    JSON.stringify(result3.idb));

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});
