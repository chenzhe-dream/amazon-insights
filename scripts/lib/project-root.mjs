import fs from "node:fs";
import path from "node:path";

/** 运行时读取 app/*.ts 数据文件的仓库根目录（团队服务 cwd 即为项目根） */
export function getProjectRoot() {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "app", "competitor-data.ts"))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, "app", "competitor-data.ts"))) return parent;
  return cwd;
}
