#!/usr/bin/env python3
"""老环境数据导出工具：通过 cloudbase CLI 分页导出指定集合到本地 JSON。
用法: python3 export.py <envId> <输出目录> [集合...] [--page 500]
默认导出: holdings watchlist transactions profit_snapshots fund_temperatures feedback h5_bindings migration_codes
"""
import json, subprocess, sys, os, time

ENV_ID = sys.argv[1] if len(sys.argv) > 1 else "cloudbase-d0gug00io7bfedd97"
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else "out"
PAGE = 500
COLLECTIONS = []
for arg in sys.argv[3:]:
    if arg == "--page":
        continue
    if arg.isdigit():
        PAGE = int(arg)
    else:
        COLLECTIONS.append(arg)
COLLECTIONS = COLLECTIONS or [
    "holdings", "watchlist", "transactions", "profit_snapshots",
    "fund_temperatures", "feedback", "h5_bindings", "migration_codes",
]

os.makedirs(OUT_DIR, exist_ok=True)

def run_cli(command_json, timeout=300, retries=3):
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
            return json.loads(out)
        except Exception as e:
            last_err = e
            time.sleep(2)
    raise last_err

def query(collection, skip, limit):
    cmd = {"TableName": collection, "CommandType": "QUERY",
           "Command": json.dumps({"find": collection, "skip": skip, "limit": limit})}
    return run_cli(json.dumps([cmd]))

def main():
    summary = {}
    for col in COLLECTIONS:
        docs, skip = [], 0
        while True:
            try:
                res = query(col, skip, PAGE)
                batch = res["data"]["results"][0] if res["data"]["results"] else []
                if not batch:
                    break
                docs.extend(batch)
                skip += len(batch)
                if len(batch) < PAGE:
                    break
                time.sleep(0.3)
            except Exception as e:
                print(f"[{col}] 第{len(docs)}条分页失败: {e}")
                break
        path = os.path.join(OUT_DIR, f"{col}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False)
        summary[col] = len(docs)
        print(f"[OK] {col}: {len(docs)} 条 → {path}")
    print("\n导出完成:", json.dumps(summary, ensure_ascii=False))

if __name__ == "__main__":
    main()
