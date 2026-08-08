#!/usr/bin/env python3
"""数据重映射：老 OPENID → h5_uid + 迁移码。
读取 out/ 下导出的 JSON，为每个老用户生成 h5_uid 和 6 位迁移码，
把用户数据文档的 _openid 替换为 h5_uid，输出到 out/processed/。
"""
import json, os, secrets, string

IN_DIR = "out"
OUT_DIR = "out/processed"
USER_COLLECTIONS = ["holdings", "watchlist", "transactions", "profit_snapshots", "feedback"]
SHARED_COLLECTIONS = ["fund_temperatures", "h5_bindings", "migration_codes"]

os.makedirs(OUT_DIR, exist_ok=True)

def gen_h5_uid():
    return "h5_" + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(16))

def gen_code():
    # 去掉易混淆字符 0 O 1 l I
    charset = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(charset) for _ in range(6))

def main():
    # 收集所有老 openid
    openids = set()
    for col in USER_COLLECTIONS:
        path = os.path.join(IN_DIR, f"{col}.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for doc in json.load(f):
                if doc.get("_openid"):
                    openids.add(doc["_openid"])
    print(f"老用户数: {len(openids)}")

    # 生成映射
    mapping = {}
    for oid in sorted(openids):
        mapping[oid] = {"h5Uid": gen_h5_uid(), "code": gen_code(), "createTime": "2026-08-07T21:30:00.000Z"}

    # 重映射用户集合
    for col in USER_COLLECTIONS:
        path = os.path.join(IN_DIR, f"{col}.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            docs = json.load(f)
        for doc in docs:
            oid = doc.get("_openid")
            if oid and oid in mapping:
                doc["_openid"] = mapping[oid]["h5Uid"]
        with open(os.path.join(OUT_DIR, f"{col}.json"), "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False)
        print(f"[OK] {col}: {len(docs)} 条已重映射")

    # 共享集合原样复制
    for col in SHARED_COLLECTIONS:
        path = os.path.join(IN_DIR, f"{col}.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            docs = json.load(f)
        with open(os.path.join(OUT_DIR, f"{col}.json"), "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False)
        print(f"[OK] {col}: {len(docs)} 条原样复制")

    # 生成迁移码表（新环境：按 code 索引；含 h5Uid、used 标记）
    codes = [{"h5Uid": m["h5Uid"], "code": m["code"], "createTime": m["createTime"], "used": False}
             for m in mapping.values()]
    with open(os.path.join(OUT_DIR, "migration_codes_new.json"), "w", encoding="utf-8") as f:
        json.dump(codes, f, ensure_ascii=False)
    print(f"[OK] migration_codes_new: {len(codes)} 条")

    # 迁移码表（老环境：老 openid → code，供老小程序展示）
    codes_old = [{"_openid": oid, "h5Uid": m["h5Uid"], "code": m["code"], "createTime": m["createTime"], "used": False}
                 for oid, m in mapping.items()]
    with open(os.path.join(OUT_DIR, "migration_codes_old.json"), "w", encoding="utf-8") as f:
        json.dump(codes_old, f, ensure_ascii=False)
    print(f"[OK] migration_codes_old: {len(codes_old)} 条")

    # 映射表备份（本地留档，勿提交）
    with open("out/migration-map.json", "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=1)
    print("[OK] 映射表 → out/migration-map.json（本地留档）")

if __name__ == "__main__":
    main()
