/**
 * work/ 落盘：事件流、session 审计、分析产物。
 */
import fs from "node:fs";
import path from "node:path";

export class EvidenceStore {
  constructor(root) {
    this.root = path.resolve(String(root));
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 相对路径 → 绝对路径；拒绝穿越出 work/ 根目录，并补齐父目录。 */
  _abs(rel) {
    const p = path.resolve(this.root, String(rel));
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes work dir: '${rel}'`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }

  /** 追加写 jsonl，供长生命周期事件流使用（返回可写流，.write() 行追加）。 */
  open_jsonl(rel) {
    return fs.createWriteStream(this._abs(rel), { flags: "a" });
  }

  write_json(rel, obj) {
    const p = this._abs(rel);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
    return p;
  }

  write_text(rel, text) {
    const p = this._abs(rel);
    fs.writeFileSync(p, String(text), "utf8");
    return p;
  }
}
