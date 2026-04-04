"""
步骤 1：为 problems_analyzed.jsonl 中的题目生成 BGE-M3 embedding。
----------------------------------------------------------------------
用法：
  python scripts/generate_embeddings.py

输出（写入 data/ 目录）：
  - embeddings.npy        — shape (N, dim) 的 float32 矩阵
  - embedding_index.json  — { id: row_number, ... } 和 { row_number: id, ... }

依赖：
  pip install sentence-transformers numpy
"""

import json
import sys
import numpy as np
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
INPUT_FILE = DATA_DIR / "problems_analyzed.jsonl"
EMB_FILE = DATA_DIR / "embeddings.npy"
IDX_FILE = DATA_DIR / "embedding_index.json"


def build_text(p: dict) -> str:
    """拼接用于 embedding 的文本"""
    parts = []
    if p.get("tags"):
        parts.append("标签: " + ", ".join(p["tags"]))
    if p.get("knowledge_points"):
        parts.append("知识点: " + ", ".join(p["knowledge_points"]))
    if p.get("solution_approach"):
        parts.append("解题思路: " + p["solution_approach"])
    if p.get("key_insight"):
        parts.append("核心观察: " + p["key_insight"])
    if p.get("problem_type"):
        parts.append("题型: " + p["problem_type"])
    if p.get("title"):
        parts.append("题目: " + p["title"])
    return "\n".join(parts)


def main():
    if not INPUT_FILE.exists():
        print(f"错误：找不到 {INPUT_FILE}")
        sys.exit(1)

    problems = []
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                problems.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    print(f"读取到 {len(problems)} 道已分析题目")

    texts = [build_text(p) for p in problems]
    ids = [str(p["id"]) for p in problems]

    print("加载 BGE-M3 模型…")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("BAAI/bge-m3")

    print("生成 embedding…")
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=True, normalize_embeddings=True)
    embeddings = np.array(embeddings, dtype=np.float32)
    print(f"Embedding 矩阵 shape: {embeddings.shape}")

    # 保存
    np.save(str(EMB_FILE), embeddings)
    print(f"已保存 → {EMB_FILE}")

    index = {
        "id_to_row": {pid: i for i, pid in enumerate(ids)},
        "row_to_id": {i: pid for i, pid in enumerate(ids)},
    }
    with open(IDX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"已保存 → {IDX_FILE}")

    print("完成！")


if __name__ == "__main__":
    main()
