"""
OI 题目单题分析批处理脚本
-------------------------------
用法：
  1. pip install openai
  2. export DEEPSEEK_API_KEY="sk-..."   # Windows: set DEEPSEEK_API_KEY=...
  3. python analyze_problems.py

输出：
  - problems_analyzed.jsonl   成功分析的结果（每行一题）
  - problems_failed.json      失败题目列表（可重试）

断点续传：
  脚本会自动读取已有的 problems_analyzed.jsonl，跳过已完成的题目。
  中断后直接重跑即可继续。
"""

import json
import os
import time
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from openai import OpenAI, RateLimitError

# ── 配置 ──────────────────────────────────────────────
INPUT_FILE    = "data/problems.json"
OUTPUT_FILE   = "data/problems_analyzed.jsonl"
FAILED_FILE   = "data/problems_failed.json"

# DeepSeek OpenAI 兼容接口：https://api.deepseek.com
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL             = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
MAX_WORKERS       = 3       # 并发数，建议 3-5
RETRY_TIMES       = 3       # 每题最多重试次数
RETRY_DELAY       = 5       # 重试间隔秒数
SAVE_INTERVAL     = 10      # 每处理多少题保存一次进度
# ─────────────────────────────────────────────────────


SYSTEM_PROMPT = "你是OI竞赛题目分析专家。只返回JSON对象，不含markdown代码块或任何其他文字。"

def build_prompt(p: dict) -> str:
    desc = (p.get("description") or "")[:800]
    inp  = (p.get("inputDesc")   or "")[:300]
    out  = (p.get("outputDesc")  or "")[:200]
    return f"""分析以下OI竞赛题目，只返回一个JSON对象，不含任何markdown标记或多余文字。

字段要求：
- difficulty: 整数1-10（1最简单，10最难）
- tags: 算法标签数组，最多5项，如["DP","贪心","图论","线段树","二分"]
- knowledge_points: 细粒度知识点数组，最多6项，如["区间DP","单调队列优化","树的重心"]
- solution_approach: 解题思路摘要，50-100字中文
- key_insight: 核心观察，15-30字中文
- problem_type: 字符串，如"最优化""计数""判断""构造""博弈""模拟"之一

题目标题：{p.get("title", "")}
题目描述：{desc}
输入说明：{inp}
输出说明：{out}"""


def analyze_one(client: OpenAI, key: str, p: dict) -> dict:
    """分析单题，失败时抛出异常"""
    if not (p.get("description") or "").strip():
        return {"id": key, "title": p.get("title", ""), "_skip": True, "reason": "no description"}

    for attempt in range(1, RETRY_TIMES + 1):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                max_tokens=1000,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": build_prompt(p)},
                ],
            )
            raw = (resp.choices[0].message.content or "").strip()
            # 去掉可能的 markdown 代码块
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return {
                "id":          key,
                "title":       p.get("title", ""),
                "timeLimit":   p.get("timeLimit"),
                "memoryLimit": p.get("memoryLimit"),
                **parsed,
            }
        except RateLimitError:
            wait = RETRY_DELAY * attempt
            print(f"  [#{key}] 触发限流，等待 {wait}s 后重试 ({attempt}/{RETRY_TIMES})")
            time.sleep(wait)
        except json.JSONDecodeError as e:
            print(f"  [#{key}] JSON 解析失败（{e}），重试 ({attempt}/{RETRY_TIMES})")
            time.sleep(RETRY_DELAY)
        except Exception as e:
            print(f"  [#{key}] 请求错误：{e}，重试 ({attempt}/{RETRY_TIMES})")
            time.sleep(RETRY_DELAY)

    raise RuntimeError(f"连续 {RETRY_TIMES} 次失败")


def load_done_ids() -> set:
    """读取已完成的题目 id"""
    done = set()
    if not Path(OUTPUT_FILE).exists():
        return done
    with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                done.add(str(obj["id"]))
            except Exception:
                pass
    return done


def main():
    api_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not api_key:
        print("错误：未设置 DEEPSEEK_API_KEY。请先执行：export DEEPSEEK_API_KEY=\"sk-...\"", file=sys.stderr)
        sys.exit(1)

    # 加载题目
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        problems: dict = json.load(f)
    all_keys = list(problems.keys())
    print(f"题目总数：{len(all_keys)}")

    # 断点续传：跳过已完成
    done_ids = load_done_ids()
    pending = [k for k in all_keys if k not in done_ids]
    print(f"已完成：{len(done_ids)}  待处理：{len(pending)}")
    if not pending:
        print("全部完成！")
        return

    client = OpenAI(api_key=api_key, base_url=f"{DEEPSEEK_BASE_URL}/v1")
    print(f"使用模型：{MODEL}  接口：{DEEPSEEK_BASE_URL}/v1")

    # 线程安全的写入
    write_lock = Lock()
    failed: list[dict] = []
    counts = {"done": 0, "skip": 0, "fail": 0}
    buffer: list[str] = []

    def flush_buffer():
        if buffer:
            with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
                f.write("\n".join(buffer) + "\n")
            buffer.clear()

    def process(key: str):
        p = problems[key]
        try:
            result = analyze_one(client, key, p)
            if result.get("_skip"):
                with write_lock:
                    counts["skip"] += 1
                print(f"  [#{key}] 跳过（无题目描述）")
            else:
                line = json.dumps(result, ensure_ascii=False)
                with write_lock:
                    buffer.append(line)
                    counts["done"] += 1
                    total_done = counts["done"] + counts["skip"] + counts["fail"]
                    tag_str = ", ".join(result.get("tags", []))
                    print(f"  [#{key}] ✓ 难度:{result.get('difficulty')}  [{tag_str}]  ({total_done}/{len(pending)})")
                    if total_done % SAVE_INTERVAL == 0:
                        flush_buffer()
        except Exception as e:
            with write_lock:
                counts["fail"] += 1
                failed.append({"id": key, "title": p.get("title", ""), "error": str(e)})
            print(f"  [#{key}] ✗ 失败：{e}")

    print(f"\n开始处理（并发数：{MAX_WORKERS}）…\n")
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(process, k): k for k in pending}
        try:
            for _ in as_completed(futures):
                pass
        except KeyboardInterrupt:
            print("\n用户中断，正在保存已有结果…")
            executor.shutdown(wait=False, cancel_futures=True)

    # 最终保存
    with write_lock:
        flush_buffer()

    elapsed = time.time() - start_time
    print(f"\n{'─'*40}")
    print(f"完成！耗时 {elapsed/60:.1f} 分钟")
    print(f"  成功：{counts['done']}  跳过：{counts['skip']}  失败：{counts['fail']}")
    print(f"  结果已写入 → {OUTPUT_FILE}")

    if failed:
        with open(FAILED_FILE, "w", encoding="utf-8") as f:
            json.dump({"count": len(failed), "items": failed}, f, ensure_ascii=False, indent=2)
        print(f"  失败列表 → {FAILED_FILE}（重新运行脚本可自动重试）")


if __name__ == "__main__":
    main()
