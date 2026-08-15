/**
 * BUG-119: _slug 把非 ASCII 全抹掉，纯中文名字塌成空串。
 * 后果是 SKILL.md 自己的例子 `owb flow save 周报` 报 "name is required"——
 * 明明给了名字却说没给。flow / state / har 文件名 / replay 文件名同一条路径。
 * 运行：node owb-daemon/tests/slug_test.js
 */
import { _slug } from "../src/server.js";
import { makeChecker } from "./kit.js";

const { check, summarize } = makeChecker();

// 核心回归：中文名必须活下来
check("纯中文名不再塌成空串", _slug("周报") === "周报", `got ${JSON.stringify(_slug("周报"))}`);
check("中文任务名保留", _slug("竞品定价调研") === "竞品定价调研", _slug("竞品定价调研"));
check("中英混合保留两边", _slug("周报 report") === "周报-report", _slug("周报 report"));
check("其他非 ASCII 文字同样保留", _slug("café") === "café" && _slug("Привет") === "привет",
  `${_slug("café")} / ${_slug("Привет")}`);

// 既有行为不能回退
check("BUG-5 扩展名不重复", _slug("my_analysis.har") === "my-analysis.har", _slug("my_analysis.har"));
check("空白/标点折成连字符", _slug("a  b__c") === "a-b-c", _slug("a  b__c"));
check("首尾连字符剥掉", _slug("--a--") === "a", _slug("--a--"));
check("统一小写", _slug("MyFlow") === "myflow", _slug("MyFlow"));
check("长度截到 40", _slug("x".repeat(80)).length === 40, String(_slug("x".repeat(80)).length));
check("截断不留尾部连字符", !/-$/.test(_slug("ab-".repeat(30))), _slug("ab-".repeat(30)));

// 真正为空的输入仍要判为空，"name is required" 这类检查才站得住
check("空输入仍为空", _slug("") === "" && _slug(null) === "" && _slug(undefined) === "");
check("纯标点仍为空", _slug("???") === "" && _slug("///") === "", `${_slug("???")}|${_slug("///")}`);

// 路径分隔符不能穿过去（slug 会被拼进文件路径）
check("路径分隔符被折掉，不能穿越目录",
  !_slug("../../etc/passwd").includes("/") && !_slug("..\win").includes("\\"),
  _slug("../../etc/passwd"));

process.exit(summarize());
