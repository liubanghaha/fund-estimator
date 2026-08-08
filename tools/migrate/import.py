#!/usr/bin/env python3
"""新环境数据导入工具：读取 out/processed/ 的 JSON，分批 INSERT 到指定环境。
用法: python3 import.py <envId> [集合...] [--page 200]
"""
import json, subprocess, sys, os, time

ENV_ID = sys.argv[1] if len(sys.argv) > 1 else "cloud1-d7gu9zv3i796839b8"
IN_DIR = "out/processed"
PAGE = 200
COLLECTIONS = []
for arg in sys.argv[2:]:
    if arg == "--page":
        continue
    if arg.isdigit():
        PAGE = int(arg)
    else:
        COLLECTIONS.append(arg)
COLLECTIONS = COLLECTIONS or [
    "holdings", "watchlist", "transactions", "profit_snapshots",
    "fund_temperatures", "feedback", "migration_codes_new",
]

def run_cli(command_json, timeout=180, retries=3):
    last_err = None
    for i in range(retries):
        try:
            r = subprocess.run(
                ["cloudbase", "db", "nosql", "execute", "--env-id", ENV_ID, "--json", "-c", command_json],
                capture_output=True, text=True, timeout=timeout,
            )
            out = r.stdout.strip()
            if not out.startswith("{"):
                raise RuntimeError(f"非JSON输出: {out[:200]} / stderr: {r.stderr[-200:]}")
            parsed = json.loads(out)
            if "error" in parsed:
                raise RuntimeError(f"CLI错误: {parsed['error'].get('message', parsed['error'])[:200]}")
            return parsed
        except Exception as e:
            last_err = e
            time.sleep(2)
    raise last_err

def insert(collection, docs):
    cmd = {"TableName": collection, "CommandType": "INSERT",
           "Command": json.dumps({"insert": collection, "documents": docs}, ensure_ascii=False)}
    return run_cli(json.dumps([cmd], ensure_ascii=False))

def main():
    summary = {}
    for col in COLLECTIONS:
        path = os.path.join(IN_DIR, f"{col}.json")
        if not os.path.exists(path):
            print(f"[SKIP] {col}: 文件不存在")
            continue
        with open(path, encoding="utf-8") as f:
            docs = json.load(f)
        imported = 0
        for i in range(0, len(docs), PAGE):
            batch = docs[i:i + PAGE]
            try:
                insert(col, batch)
                imported += len(batch)
                print(f"[{col}] 已导入 {imported}/{len(docs)}")
                time.sleep(0.3)
            except Exception as e:
                print(f"[{col}] 第{i}条导入失败: {e}")
                break
        summary[col] = imported
    print("\n导入完成:", json.dumps(summary, ensure_ascii=False))

if __name__ == "__main__":
    main()
