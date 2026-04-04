"""
新题加入流程：自动完成 分析→生成 embedding→寻找候选→LLM 判断边→更新图
----------------------------------------------------------------------
用法：
  export DEEPSEEK_API_KEY="sk-..."
  python scripts/add_problem.py <题目ID>

也可批量处理多个题目：
  python scripts/add_problem.py 1007 1008 1009

该脚本复用已有的 analyze_problems / generate_embeddings / infer_relations / build_graph 逻辑。
"""

import json
import os
import sys
import time
import numpy as np
from pathlib import Path
from openai import OpenAI, RateLimitError

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

PROBLEMS_FILE  = DATA_DIR / "problems.json"
ANALYZED_FILE  = DATA_DIR / "problems_analyzed.jsonl"
EMB_FILE       = DATA_DIR / "embeddings.npy"
IDX_FILE       = DATA_DIR / "embedding_index.json"
RELATIONS_FILE = DATA_DIR / "relations.json"

DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

SIM_THRESHOLD = 0.7
TOP_K = 15
CONFIDENCE_THRESHOLD = 0.6
RETRY_TIMES = 3
RETRY_DELAY = 5


# 复用 analyze_problems 的 prompt
ANALYZE_SYSTEM = "你是OI竞赛题目分析专家。只返回JSON对象，不含markdown代码块或任何其他文字。"

def build_analyze_prompt(p: dict) -> str:
    desc = (p.get("description") or "")[:800]
    inp  = (p.get("inputDesc")   or "")[:300]
    out  = (p.get("outputDesc")  or "")[:200]
    return f"""分析以下OI竞赛题目，只返回一个JSON对象，不含任何markdown标记或多余文字。

字段要求：
- difficulty: 整数1-10
- tags: 算法标签数组，最多5项
- knowledge_points: 细粒度知识点数组，最多6项
- solution_approach: 解题思路摘要，50-100字中文
- key_insight: 核心观察，15-30字中文
- problem_type: 字符串

题目标题：{p.get("title", "")}
题目描述：{desc}
输入说明：{inp}
输出说明：{out}"""


def build_embedding_text(p: dict) -> str:
    parts = []
    if p.get("tags"): parts.append("标签: " + ", ".join(p["tags"]))
    if p.get("knowledge_points"): parts.append("知识点: " + ", ".join(p["knowledge_points"]))
    if p.get("solution_approach"): parts.append("解题思路: " + p["solution_approach"])
    if p.get("key_insight"): parts.append("核心观察: " + p["key_insight"])
    if p.get("problem_type"): parts.append("题型: " + p["problem_type"])
    if p.get("title"): parts.append("题目: " + p["title"])
    return "\n".join(parts)


RELATION_SYSTEM = """你是OI竞赛题目关系分析专家。给定两道OI题目的摘要信息，判断它们之间的关系。

可能的关系类型：
- SIMILAR_TO: 解法思路高度相似（无方向）
- SAME_TECHNIQUE: 使用同一核心算法技巧（无方向）
- PREREQUISITE_OF: 做题A有助于理解题B（A→B方向）
- HARDER_VERSION: 题B是题A的加强版（A→B方向）
- NONE: 无关系

只返回JSON对象：
{"relation": "类型", "direction": "A_TO_B"/"B_TO_A"/"BOTH", "confidence": 0.0-1.0, "reason": "理由"}"""


def build_pair_prompt(pa, pb):
    def s(p):
        return f"题目：{p.get('title','')}（#{p.get('id','')}）\n标签：{', '.join(p.get('tags',[]))}\n知识点：{', '.join(p.get('knowledge_points',[]))}\n思路：{p.get('solution_approach','')}\n难度：{p.get('difficulty','?')}/10"
    return f"分析关系：\n\n【题目A】\n{s(pa)}\n\n【题目B】\n{s(pb)}\n\n只返回JSON。"


def call_llm(client, system, user, max_tokens=500, temp=0.3):
    for attempt in range(1, RETRY_TIMES + 1):
        try:
            resp = client.chat.completions.create(
                model=MODEL, max_tokens=max_tokens, temperature=temp,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            )
            raw = (resp.choices[0].message.content or "").strip()
            raw = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(raw)
        except RateLimitError:
            time.sleep(RETRY_DELAY * attempt)
        except json.JSONDecodeError:
            time.sleep(RETRY_DELAY)
        except Exception as e:
            print(f"    LLM 错误：{e}")
            time.sleep(RETRY_DELAY)
    return None


def main():
    if len(sys.argv) < 2:
        print("用法：python scripts/add_problem.py <题目ID> [题目ID2] ...")
        sys.exit(1)

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("错误：请先设置环境变量 DEEPSEEK_API_KEY")
        sys.exit(1)

    target_ids = [str(x) for x in sys.argv[1:]]
    client = OpenAI(api_key=api_key, base_url=f"{DEEPSEEK_BASE_URL}/v1")

    # 加载现有数据
    with open(PROBLEMS_FILE, "r", encoding="utf-8") as f:
        all_problems = json.load(f)

    existing_analyzed = {}
    if ANALYZED_FILE.exists():
        with open(ANALYZED_FILE, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                try:
                    p = json.loads(line)
                    existing_analyzed[str(p["id"])] = p
                except: pass

    # 步骤 1：分析每道新题
    print("步骤 1：分析题目…")
    new_analyzed = {}
    for pid in target_ids:
        if pid in existing_analyzed:
            print(f"  #{pid} 已有分析，跳过")
            new_analyzed[pid] = existing_analyzed[pid]
            continue
        if pid not in all_problems:
            print(f"  #{pid} 不在题库中，跳过")
            continue
        p = all_problems[pid]
        print(f"  #{pid} {p.get('title', '')}…", end=" ", flush=True)
        result = call_llm(client, ANALYZE_SYSTEM, build_analyze_prompt(p))
        if result:
            entry = {"id": pid, "title": p.get("title", ""), "timeLimit": p.get("timeLimit"), "memoryLimit": p.get("memoryLimit"), **result}
            new_analyzed[pid] = entry
            existing_analyzed[pid] = entry
            print(f"✓ 难度:{result.get('difficulty')}")
        else:
            print("✗ 分析失败")

    # 写回 analyzed 文件
    with open(ANALYZED_FILE, "w", encoding="utf-8") as f:
        for pid in sorted(existing_analyzed.keys(), key=lambda x: int(x) if x.isdigit() else x):
            f.write(json.dumps(existing_analyzed[pid], ensure_ascii=False) + "\n")
    print(f"  已更新 {ANALYZED_FILE}")

    if not new_analyzed:
        print("没有需要处理的题目")
        return

    # 步骤 2：生成 embedding
    print("\n步骤 2：生成 embedding…")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("BAAI/bge-m3")

    all_ids = sorted(existing_analyzed.keys(), key=lambda x: int(x) if x.isdigit() else x)
    texts = [build_embedding_text(existing_analyzed[pid]) for pid in all_ids]
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=True, normalize_embeddings=True)
    embeddings = np.array(embeddings, dtype=np.float32)

    np.save(str(EMB_FILE), embeddings)
    index = {
        "id_to_row": {pid: i for i, pid in enumerate(all_ids)},
        "row_to_id": {i: pid for i, pid in enumerate(all_ids)},
    }
    with open(IDX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"  Embedding 矩阵 shape: {embeddings.shape}")

    # 步骤 3：找候选邻居 + LLM 判断关系
    print("\n步骤 3：寻找关系…")
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-8)
    normed = embeddings / norms

    existing_relations = []
    if RELATIONS_FILE.exists():
        try:
            existing_relations = json.load(open(RELATIONS_FILE, "r", encoding="utf-8"))
        except: pass

    existing_pairs = set()
    for r in existing_relations:
        existing_pairs.add((str(r["id_a"]), str(r["id_b"])))
        existing_pairs.add((str(r["id_b"]), str(r["id_a"])))

    new_relations = []
    id_to_row = index["id_to_row"]

    for pid in new_analyzed:
        if pid not in id_to_row:
            continue
        row = id_to_row[pid]
        sims = normed[row] @ normed.T
        sims[row] = -1
        top_indices = np.argsort(sims)[::-1][:TOP_K]

        for j in top_indices:
            if sims[j] < SIM_THRESHOLD:
                break
            other_id = index["row_to_id"][str(int(j))]
            if (pid, other_id) in existing_pairs:
                continue

            pa = existing_analyzed.get(pid)
            pb = existing_analyzed.get(other_id)
            if not pa or not pb:
                continue

            result = call_llm(client, RELATION_SYSTEM, build_pair_prompt(pa, pb), max_tokens=300, temp=0.2)
            if result and result.get("relation") != "NONE" and result.get("confidence", 0) >= CONFIDENCE_THRESHOLD:
                edge = {
                    "id_a": pid, "id_b": other_id,
                    "relation": result["relation"],
                    "direction": result.get("direction", "BOTH"),
                    "confidence": result["confidence"],
                    "reason": result.get("reason", ""),
                    "similarity": float(sims[j]),
                    "source": "auto",
                }
                new_relations.append(edge)
                existing_pairs.add((pid, other_id))
                existing_pairs.add((other_id, pid))
                print(f"  #{pid} ↔ #{other_id}: {result['relation']} ({result['confidence']:.2f})")

    all_relations = existing_relations + new_relations
    with open(RELATIONS_FILE, "w", encoding="utf-8") as f:
        json.dump(all_relations, f, ensure_ascii=False, indent=2)
    print(f"  新增 {len(new_relations)} 条关系，总计 {len(all_relations)} 条")

    # 步骤 4：重建图（JSON 格式，Node.js 直接加载）
    print("\n步骤 4：更新图谱…")
    GRAPH_JSON = DATA_DIR / "problem_graph.json"
    EMB_JSON   = DATA_DIR / "embeddings.json"

    nodes = {}
    for pid, p in existing_analyzed.items():
        nodes[pid] = {
            "title": p.get("title", ""), "difficulty": p.get("difficulty", 0),
            "tags": p.get("tags", []), "knowledge_points": p.get("knowledge_points", []),
            "problem_type": p.get("problem_type", ""), "solution_approach": p.get("solution_approach", ""),
            "key_insight": p.get("key_insight", ""),
        }

    edges = []
    for r in all_relations:
        id_a, id_b = str(r["id_a"]), str(r["id_b"])
        rel = r["relation"]
        direction = r.get("direction", "BOTH")
        base = {
            "relation": rel, "confidence": r.get("confidence", 0.5),
            "reason": r.get("reason", ""), "source": r.get("source", "auto"),
            "similarity": r.get("similarity", 0),
        }
        if rel in ("SIMILAR_TO", "SAME_TECHNIQUE") or direction == "BOTH":
            edges.append({"from": id_a, "to": id_b, **base})
            edges.append({"from": id_b, "to": id_a, **base})
        elif direction == "A_TO_B":
            edges.append({"from": id_a, "to": id_b, **base})
        elif direction == "B_TO_A":
            edges.append({"from": id_b, "to": id_a, **base})

    with open(GRAPH_JSON, "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "edges": edges}, f, ensure_ascii=False)
    print(f"  图谱已更新：{len(nodes)} 节点，{len(edges)} 边 → {GRAPH_JSON}")

    # 保存 embeddings.json
    with open(EMB_JSON, "w") as f:
        json.dump(embeddings.tolist(), f)
    print(f"  Embedding JSON 已更新 → {EMB_JSON}")

    print(f"\n完成！已处理 {len(new_analyzed)} 道题目。")
    print("重启 Node 主服务即可加载最新图谱和推荐数据。")


if __name__ == "__main__":
    main()
