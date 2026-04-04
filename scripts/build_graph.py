"""
步骤 3：构建问题图谱，输出 JSON 格式供 Node.js 直接加载
----------------------------------------------------------------------
用法：
  python scripts/build_graph.py

输入（data/ 目录）：
  - problems_analyzed.jsonl
  - relations.json
  - embeddings.npy, embedding_index.json

输出（data/ 目录）：
  - problem_graph.json  — { nodes: {id: {...}}, edges: [{id_a, id_b, ...}] }
  - embeddings.json     — 二维数组 [[...], ...] 供 Node.js 加载

依赖：
  pip install numpy
"""

import json
import sys
import numpy as np
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

ANALYZED_FILE  = DATA_DIR / "problems_analyzed.jsonl"
RELATIONS_FILE = DATA_DIR / "relations.json"
EMB_FILE       = DATA_DIR / "embeddings.npy"
IDX_FILE       = DATA_DIR / "embedding_index.json"
GRAPH_JSON     = DATA_DIR / "problem_graph.json"
EMB_JSON       = DATA_DIR / "embeddings.json"


def load_problems() -> dict:
    problems = {}
    with open(ANALYZED_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
                problems[str(p["id"])] = p
            except (json.JSONDecodeError, KeyError):
                pass
    return problems


def main():
    for f in [ANALYZED_FILE, RELATIONS_FILE]:
        if not f.exists():
            print(f"错误：找不到 {f}")
            sys.exit(1)

    problems = load_problems()
    print(f"题目数：{len(problems)}")

    with open(RELATIONS_FILE, "r", encoding="utf-8") as f:
        relations = json.load(f)
    print(f"关系数：{len(relations)}")

    # 构建节点
    nodes = {}
    for pid, p in problems.items():
        nodes[pid] = {
            "title":            p.get("title", ""),
            "difficulty":       p.get("difficulty", 0),
            "tags":             p.get("tags", []),
            "knowledge_points": p.get("knowledge_points", []),
            "problem_type":     p.get("problem_type", ""),
            "solution_approach": p.get("solution_approach", ""),
            "key_insight":      p.get("key_insight", ""),
        }

    # 构建边列表（展开为有向边）
    edges = []
    for r in relations:
        id_a = str(r["id_a"])
        id_b = str(r["id_b"])
        rel = r["relation"]
        direction = r.get("direction", "BOTH")
        edge_base = {
            "relation":   rel,
            "confidence": r.get("confidence", 0.5),
            "reason":     r.get("reason", ""),
            "source":     r.get("source", "auto"),
            "similarity": r.get("similarity", 0),
        }

        if rel in ("SIMILAR_TO", "SAME_TECHNIQUE") or direction == "BOTH":
            edges.append({"from": id_a, "to": id_b, **edge_base})
            edges.append({"from": id_b, "to": id_a, **edge_base})
        elif direction == "A_TO_B":
            edges.append({"from": id_a, "to": id_b, **edge_base})
        elif direction == "B_TO_A":
            edges.append({"from": id_b, "to": id_a, **edge_base})

    print(f"图节点：{len(nodes)}  图边：{len(edges)}")

    edge_types = {}
    for e in edges:
        t = e.get("relation", "UNKNOWN")
        edge_types[t] = edge_types.get(t, 0) + 1
    for t, c in sorted(edge_types.items()):
        print(f"  {t}: {c}")

    with open(GRAPH_JSON, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "edges": edges}, f, ensure_ascii=False)
    print(f"\n图谱已保存 → {GRAPH_JSON}")

    # 转换 embeddings.npy → embeddings.json
    if EMB_FILE.exists():
        emb = np.load(str(EMB_FILE))
        with open(EMB_JSON, "w") as f:
            json.dump(emb.tolist(), f)
        print(f"Embedding JSON 已保存 → {EMB_JSON}（{emb.shape}）")
    else:
        print("[跳过] embeddings.npy 不存在")


if __name__ == "__main__":
    main()
