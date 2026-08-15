/**
 * work/ 落盘：事件流、session 审计、分析产物。
 */
import fs from "node:fs";
import path from "node:path";

const pad2 = (n) => String(n).padStart(2, "0");

/** 返回 YYYYMMDD（本地时区）。按天切分的文件名真源。 */
export function ymd(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export class EvidenceStore {
  constructor(root) {
    this.root = path.resolve(String(root));
    // work/ 下有明文 cookie（states/）和审计日志。默认 0755/0644 意味着
    // POSIX 共享机上每个用户都能直接读走凭据，根本不用连 daemon 的 socket。
    // Windows 基本忽略 mode，但对 Linux/macOS 用户这一行换掉一整类暴露。
    // 注意：mode 只在**创建**时生效，已存在的旧目录/文件权限不变。
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** 相对路径 → 绝对路径；拒绝穿越出 work/ 根目录，并补齐父目录。 */
  _abs(rel) {
    const p = path.resolve(this.root, String(rel));
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes work dir: '${rel}'`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    return p;
  }

  /**
   * 追加写 jsonl（返回可写流，.write() 行追加）。
   * ⚠️ 无轮转、无上限——只给短生命周期、调用方自己负责收尾的用途。
   * 「每次调用都追加一行、没人负责删」的日志一律用 RollingJsonl。
   */
  open_jsonl(rel) {
    return fs.createWriteStream(this._abs(rel), { flags: "a", mode: 0o600 });
  }

  write_json(rel, obj) {
    const p = this._abs(rel);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2),
                     { encoding: "utf8", mode: 0o600 });
    return p;
  }

  write_text(rel, text) {
    const p = this._abs(rel);
    fs.writeFileSync(p, String(text), { encoding: "utf8", mode: 0o600 });
    return p;
  }
}

/**
 * 长生命周期 jsonl：按天切文件 + 单文件大小上限 + 过期清理。
 *
 * 为什么必须有这个类：events.jsonl 原来走的是裸 open_jsonl —— 无轮转、无上限、
 * 没有任何人负责删。实测开发机上长到 **19,443,306,283 字节（18 GiB）**，而全局
 * 安装时 work/ 在 node_modules 底下，用户永远不会去那儿看一眼。写满盘之后
 * 流的 error handler 也只是打一行日志，事件继续静默丢。
 *
 * 另一个它顺带修掉的 bug：原来文件名里的日期在**构造时**求值一次，长跑的
 * daemon 跨零点后会一直把今天的记录写进昨天的文件。这里每次写入都取当天。
 */
export class RollingJsonl {
  /**
   * @param {EvidenceStore} store
   * @param {string} prefix   work/ 下的目录名，如 "sessions"
   * @param {{maxBytes?: number, keepDays?: number}} opts
   *        keepDays <= 0 关闭过期清理。
   */
  constructor(store, prefix, opts = {}) {
    this.store = store;
    this.prefix = String(prefix);
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.keepDays = opts.keepDays ?? 14;
    this.day = null;
    this.part = 0;
    this.bytes = 0;
    this.stream = null;
  }

  _rel(day, part) {
    return part === 0
      ? `${this.prefix}/${day}.jsonl`
      : `${this.prefix}/${day}.${part}.jsonl`;
  }

  /** 确保当天、未超上限的分片处于打开状态。 */
  _ensure(day) {
    if (this.stream && this.day === day && this.bytes < this.maxBytes) return;
    const dayChanged = this.day !== null && this.day !== day;
    // 同一天、流还开着 = 当前分片写满了，必须前进到下一个。
    // 这里只能信内存里的 this.bytes：流是带缓冲的，刚写的字节未必已经落盘，
    // 拿 statSync 的大小判断会读到滞后值，于是永远滚不动分片。
    const rotating = !!this.stream && !dayChanged;
    if (this.stream) {
      try { this.stream.end(); } catch (e) { /* 关不掉也要继续开新的 */ }
      this.stream = null;
    }
    if (dayChanged) this.part = 0;
    if (rotating) this.part++;
    // 冷启动/同日重启：接着写已有文件，bytes 从磁盘实际大小起算，
    // 否则「重启」就成了绕过大小上限的后门。
    let abs;
    for (;;) {
      abs = this.store._abs(this._rel(day, this.part));
      let size = 0;
      try { size = fs.statSync(abs).size; } catch (e) { /* 不存在即 0 */ }
      if (size < this.maxBytes) { this.bytes = size; break; }
      this.part++;
    }
    this.day = day;
    this.stream = fs.createWriteStream(abs, { flags: "a", mode: 0o600 });
    this.stream.on("error", (e) =>
      console.error(`[owb-daemon] ${this.prefix} log write error:`, e));
    if (dayChanged) this.sweep(); // 跨天时顺手清过期
  }

  write(line) {
    const s = String(line);
    this._ensure(ymd());
    this.bytes += Buffer.byteLength(s);
    this.stream.write(s);
  }

  /** 删掉 keepDays 之前的分片，返回删除数。 */
  sweep() {
    if (!(this.keepDays > 0)) return 0;
    const cutoff = ymd(new Date(Date.now() - this.keepDays * 86400000));
    const dirAbs = path.resolve(this.store.root, this.prefix);
    let entries;
    try {
      entries = fs.readdirSync(dirAbs);
    } catch (e) {
      return 0; // 目录还不存在
    }
    let removed = 0;
    for (const name of entries) {
      // 只认自己生成的 YYYYMMDD.jsonl / YYYYMMDD.N.jsonl，别去动用户放的文件
      const m = /^(\d{8})(?:\.\d+)?\.jsonl$/.exec(name);
      if (!m || m[1] >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(dirAbs, name));
        removed++;
      } catch (e) { /* 占用中/权限不足：下次再说 */ }
    }
    return removed;
  }

  /** 收流。返回 Promise（flush 完成后 resolve）——退出路径可以不等。 */
  end() {
    const s = this.stream;
    this.stream = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      try { s.end(resolve); } catch (e) { resolve(); }
    });
  }
}
