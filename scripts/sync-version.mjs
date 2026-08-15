/**
 * 把 package.json 的版本号同步进扩展 manifest。
 *
 * 由 package.json 的 `version` 脚本调用，也就是 `npm version <x>` 的一部分，
 * 所以正常发版路径上不需要谁记得跑它。
 *
 * 为什么需要：这个项目是双端的，CLI/daemon 跟着 npm 包走、扩展跟着浏览器走，
 * 两个版本号此前没有任何东西约束——实测过 package.json 1.0.2 / manifest 1.0.1
 * 同时存在。对「扩展要手动 reload、CLI 却会自动升级」的工具来说，版本不匹配
 * 导致的静默行为差异是最难排查、也最劝退用户的一类问题。
 *
 * 用定点正则替换而不是 JSON.parse + stringify：后者会把 manifest 整体重排版，
 * 制造与本次改动无关的 diff。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifestPath = path.join(ROOT, "owb-extension", "manifest.json");

const before = fs.readFileSync(manifestPath, "utf8");
const after = before.replace(
  /("version"\s*:\s*")[^"]*(")/,
  `$1${pkg.version}$2`,
);

if (before === after) {
  console.log(`manifest already at ${pkg.version}`);
} else {
  fs.writeFileSync(manifestPath, after);
  console.log(`manifest version -> ${pkg.version}`);
}
