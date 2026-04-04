"""
步骤 2：关系推断 — 余弦相似度筛候选 + DeepSeek LLM 判断边类型
----------------------------------------------------------------------
用法：
  export DEEPSEEK_API_KEY="sk-..."
  python scripts/infer_relations.py

输出（写入 data/ 目录）：
  - relations.json  — 推断出的关系列表

依赖：
  pip install numpy openai
"""

import json
import os
import sys
import time
import numpy as np
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from openai import OpenAI, RateLimitError

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

ANALYZED_FILE = DATA_DIR / "problems_analyzed.jsonl"
EMB_FILE      = DATA_DIR / "embeddings.npy"
IDX_FILE      = DATA_DIR / "embedding_index.json"
OUTPUT_FILE   = DATA_DIR / "relations.json"

# 超参数
SIM_THRESHOLD = 0.70
TOP_K         = 15
CONFIDENCE_THRESHOLD = 0.5
MAX_WORKERS   = 5
RETRY_TIMES   = 3
RETRY_DELAY   = 5

DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

SYSTEM_PROMPT = """你是OI竞赛题目关系分析专家。给定两道OI题目的摘要信息，判断它们之间的关系。

可能的关系类型：
- SIMILAR_TO: 两题解法思路高度相似（无方向）
- SAME_TECHNIQUE: 使用同一核心算法技巧（无方向）
- PREREQUISITE_OF: 做题A有助于理解题B，A是B的前置知识（A→B方向）
- HARDER_VERSION: 题B是题A的加强版，B更难（A→B方向）
- NONE: 两题没有明显关系

只返回一个JSON对象，不含markdown代码块或其他文字。格式：
{
  "relation": "关系类型",
  "direction": "A_TO_B" 或 "B_TO_A" 或 "BOTH" (无向关系用BOTH),
  "confidence": 0.0-1.0的置信度,
  "reason": "10-30字的理由"
}

如果没有关系或不确定，返回 {"relation": "NONE", "direction": "BOTH", "confidence": 0, "reason": "无明显关系"}"""


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


def build_pair_prompt(pa: dict, pb: dict) -> str:
    def summarize(p):
        parts = [f"题目：{p.get('title', '')}（#{p.get('id', '')}）"]
        if p.get("tags"):
            parts.append(f"标签：{', '.join(p['tags'])}")
        if p.get("knowledge_points"):
            parts.append(f"知识点：{', '.join(p['knowledge_points'])}")
        if p.get("solution_approach"):
            parts.append(f"思路：{p['solution_approach']}")
        if p.get("key_insight"):
            parts.append(f"核心观察：{p['key_insight']}")
        if p.get("difficulty"):
            parts.append(f"难度：{p['difficulty']}/10")
        if p.get("problem_type"):
            parts.append(f"题型：{p['problem_type']}")
        return "\n".join(parts)

    return f"""分析以下两道OI题目的关系：

【题目A】
{summarize(pa)}

【题目B】
{summarize(pb)}

只返回JSON对象。"""


def find_candidates(embeddings: np.ndarray, index: dict) -> list:
    """余弦相似度找候选对"""
    n = embeddings.shape[0]
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-8)
    normed = embeddings / norms

    candidates = []
    seen = set()

    for i in range(n):
        sims = normed[i] @ normed.T
        sims[i] = -1  # 排除自身

        top_indices = np.argsort(sims)[::-1][:TOP_K]
        for j in top_indices:
            if sims[j] < SIM_THRESHOLD:
                break
            pair = (min(i, j), max(i, j))
            if pair not in seen:
                seen.add(pair)
                id_a = index["row_to_id"][str(i)]
                id_b = index["row_to_id"][str(j)]
                candidates.append({
                    "id_a": id_a,
                    "id_b": id_b,
                    "similarity": float(sims[j]),
                })

    return candidates


def judge_relation(client: OpenAI, pa: dict, pb: dict) -> dict | None:
    """LLM 判断一对题目的关系"""
    for attempt in range(1, RETRY_TIMES + 1):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                max_tokens=300,
                temperature=0.2,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": build_pair_prompt(pa, pb)},
                ],
            )
            raw = (resp.choices[0].message.content or "").strip()
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return parsed
        except RateLimitError:
            time.sleep(RETRY_DELAY * attempt)
        except json.JSONDecodeError:
            time.sleep(RETRY_DELAY)
        except Exception as e:
            print(f"  请求错误：{e}，重试 ({attempt}/{RETRY_TIMES})")
            time.sleep(RETRY_DELAY)
    return None


def main():
    api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not api_key:
        print("错误：未设置 DEEPSEEK_API_KEY。请先执行：export DEEPSEEK_API_KEY=\"sk-...\"", file=sys.stderr)
        sys.exit(1)

    for f in [ANALYZED_FILE, EMB_FILE, IDX_FILE]:
        if not f.exists():
            print(f"错误：找不到 {f}，请先运行前置脚本")
            sys.exit(1)

    problems = load_problems()
    embeddings = np.load(str(EMB_FILE))
    with open(IDX_FILE, "r", encoding="utf-8") as f:
        index = json.load(f)

    print(f"题目数：{len(problems)}  Embedding 维度：{embeddings.shape}")

    # 阶段一：向量筛候选
    print(f"\n阶段一：余弦相似度筛候选（阈值 {SIM_THRESHOLD}，K={TOP_K}）…")
    candidates = find_candidates(embeddings, index)
    print(f"候选对数量：{len(candidates)}")

    if not candidates:
        print("没有找到候选对，退出")
        return

    # 断点续传：读取已有结果
    existing_relations = []
    done_pairs = set()
    if OUTPUT_FILE.exists():
        try:
            existing_relations = json.load(open(OUTPUT_FILE, "r", encoding="utf-8"))
            for r in existing_relations:
                done_pairs.add((r["id_a"], r["id_b"]))
            print(f"已有 {len(existing_relations)} 条关系，跳过已完成的")
        except Exception:
            pass

    pending = [c for c in candidates if (c["id_a"], c["id_b"]) not in done_pairs]
    print(f"待处理：{len(pending)} 对\n")

    if not pending:
        print("全部已完成！")
        return

    # 阶段二：LLM 判断
    client = OpenAI(api_key=api_key, base_url=f"{DEEPSEEK_BASE_URL}/v1")
    relations = list(existing_relations)
    write_lock = Lock()
    counts = {"done": 0, "skip": 0, "fail": 0}

    def process(cand):
        pa = problems.get(cand["id_a"])
        pb = problems.get(cand["id_b"])
        if not pa or not pb:
            with write_lock:
                counts["skip"] += 1
            return

        result = judge_relation(client, pa, pb)
        if result is None:
            with write_lock:
                counts["fail"] += 1
                print(f"  [{cand['id_a']}↔{cand['id_b']}] ✗ 失败")
            return

        rel_type = result.get("relation", "NONE")
        confidence = result.get("confidence", 0)

        if rel_type == "NONE" or confidence < CONFIDENCE_THRESHOLD:
            with write_lock:
                counts["skip"] += 1
                total = counts["done"] + counts["skip"] + counts["fail"]
                print(f"  [{cand['id_a']}↔{cand['id_b']}] 跳过({rel_type}, conf={confidence:.2f})  ({total}/{len(pending)})")
            return

        edge = {
            "id_a":       cand["id_a"],
            "id_b":       cand["id_b"],
            "relation":   rel_type,
            "direction":  result.get("direction", "BOTH"),
            "confidence": confidence,
            "reason":     result.get("reason", ""),
            "similarity": cand["similarity"],
            "source":     "auto",
        }

        with write_lock:
            relations.append(edge)
            counts["done"] += 1
            total = counts["done"] + counts["skip"] + counts["fail"]
            print(f"  [{cand['id_a']}↔{cand['id_b']}] ✓ {rel_type} ({confidence:.2f})  ({total}/{len(pending)})")

            if total % 10 == 0:
                with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                    json.dump(relations, f, ensure_ascii=False, indent=2)

    print(f"阶段二：LLM 判断边类型（并发数：{MAX_WORKERS}）…\n")
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(process, c): c for c in pending}
        try:
            for _ in as_completed(futures):
                pass
        except KeyboardInterrupt:
            print("\n用户中断，保存已有结果…")
            executor.shutdown(wait=False, cancel_futures=True)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(relations, f, ensure_ascii=False, indent=2)

    elapsed = time.time() - start_time
    print(f"\n{'─'*40}")
    print(f"完成！耗时 {elapsed/60:.1f} 分钟")
    print(f"  有效关系：{counts['done']}  跳过：{counts['skip']}  失败：{counts['fail']}")
    print(f"  总关系数：{len(relations)}")
    print(f"  已写入 → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
