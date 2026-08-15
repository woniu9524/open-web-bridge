/**
 * ESM 入口守卫：这个模块是不是被直接当命令跑的？
 *
 * 不能直接写 `import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href`。
 * Node 默认把模块路径解析到 realpath（`--preserve-symlinks` 不开），
 * 而 `process.argv[1]` 原样保留调用时写的路径。只要安装方式里有符号链接
 * ——`npm link`、pnpm 的 store、全局 bin 指向别处——两边就永远不相等，
 * 守卫静默为假：**命令什么都不做，还退出码 0**。
 *
 * 实测：`npm link` 之后 `owb status` 无任何输出、exit 0，看着像 daemon 挂了，
 * 其实 main() 根本没被调用过。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows 路径大小写不敏感，且盘符大小写会随调用路径变（D: vs d:）
function samePath(a, b) {
  if (a === b) return true;
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase();
}

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(metaUrl);
  const entryPath = path.resolve(entry);
  // 快路径：没有符号链接时直接相等；也兜住 argv[1] 不存在于磁盘的情况
  if (samePath(selfPath, entryPath)) return true;
  // 慢路径：两边都解到 realpath 再比，跨过 npm link / pnpm / 全局 bin 的软链
  try {
    return samePath(
      fs.realpathSync.native(selfPath),
      fs.realpathSync.native(entryPath),
    );
  } catch {
    return false;
  }
}
