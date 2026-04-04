"""
问题图谱推荐微服务 — 给 Node 后端提供推荐 API
--------------------------------------------------------------
启动：python scripts/recommend_server.py
端口：9100（可通过 PORT 环境变量修改）

API：
  POST /recommend
    body: { "problem_id": "1007", "mode": "next"|"easier"|"topic", "topic": "DP", "count": 3 }
    response: { "success": true, "recommendations": [...] }

  GET /graph/info
    response: { nodes, edges, edge_types }

  GET /graph/node/:id
    response: { success, node, neighbors }

  POST /graph/edit
    body: { "action": "add_edge"|"remove_edge"|"update_difficulty", ...params }

  GET /health
"""

import json
import os
import pickle
import sys
import numpy as np
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

GRAPH_FILE    = DATA_DIR / "problem_graph.pkl"
EMB_FILE      = DATA_DIR / "embeddings.npy"
IDX_FILE      = DATA_DIR / "embedding_index.json"
ANALYZED_FILE = DATA_DIR / "problems_analyzed.jsonl"

graph = None
embeddings = None
emb_index = None
normed_embs = None
problems_data = {}


def load_data():
    global graph, embeddings, emb_index, normed_embs, problems_data

    if GRAPH_FILE.exists():
        with open(GRAPH_FILE, "rb") as f:
            graph = pickle.load(f)
        print(f"[图谱] 已加载：{graph.number_of_nodes()} 节点，{graph.number_of_edges()} 边")
    else:
        print(f"[警告] 图谱文件不存在：{GRAPH_FILE}，推荐功能将降级为纯 embedding")
        import networkx as nx
        graph = nx.DiGraph()

    if EMB_FILE.exists() and IDX_FILE.exists():
        embeddings = np.load(str(EMB_FILE))
        with open(IDX_FILE, "r", encoding="utf-8") as f:
            emb_index = json.load(f)
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.maximum(norms, 1e-8)
        normed_embs = embeddings / norms
        print(f"[Embedding] 已加载：{embeddings.shape}")
    else:
        print(f"[警告] Embedding 文件不存在，相似度推荐不可用")

    if ANALYZED_FILE.exists():
        with open(ANALYZED_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    p = json.loads(line)
                    problems_data[str(p["id"])] = p
                except Exception:
                    pass
        print(f"[题目数据] 已加载 {len(problems_data)} 题")


def get_embedding_similarity(pid: str, exclude: set, top_n: int = 20) -> list:
    """用 embedding 相似度找最近的题"""
    if normed_embs is None or emb_index is None:
        return []
    id_to_row = emb_index.get("id_to_row", {})
    row_to_id = emb_index.get("row_to_id", {})
    if pid not in id_to_row:
        return []
    row = id_to_row[pid]
    sims = normed_embs[row] @ normed_embs.T
    sims[row] = -1
    top_indices = np.argsort(sims)[::-1][:top_n + len(exclude)]
    result = []
    for idx in top_indices:
        rid = row_to_id.get(str(int(idx)))
        if rid and rid not in exclude:
            result.append({"id": rid, "similarity": float(sims[idx])})
            if len(result) >= top_n:
                break
    return result


def recommend_next(pid: str, count: int = 3) -> list:
    """推荐下一题：图上出边邻居 + embedding 兜底"""
    results = []
    seen = {pid}

    if graph and pid in graph:
        node_data = graph.nodes.get(pid, {})
        curr_diff = node_data.get("difficulty", 5)

        out_edges = []
        for _, neighbor, data in graph.out_edges(pid, data=True):
            if neighbor in seen:
                continue
            rel = data.get("relation", "")
            conf = data.get("confidence", 0)
            n_data = graph.nodes.get(neighbor, {})
            n_diff = n_data.get("difficulty", 5)
            diff_delta = n_diff - curr_diff

            score = conf
            if rel == "HARDER_VERSION":
                score += 2.0
            elif rel == "SAME_TECHNIQUE":
                score += 1.5
            elif rel == "PREREQUISITE_OF":
                score += 0.5

            if 1 <= diff_delta <= 2:
                score += 1.0
            elif diff_delta == 0:
                score += 0.5
            elif diff_delta > 3:
                score -= 0.5

            if data.get("source") == "teacher":
                score += 3.0

            reason = _build_reason(rel, diff_delta, n_diff)
            out_edges.append((neighbor, score, rel, reason))

        out_edges.sort(key=lambda x: -x[1])
        for nid, score, rel, reason in out_edges[:count]:
            seen.add(nid)
            p = problems_data.get(nid, {})
            results.append({
                "id":         nid,
                "title":      p.get("title", graph.nodes.get(nid, {}).get("title", "")),
                "difficulty":  p.get("difficulty", graph.nodes.get(nid, {}).get("difficulty", 0)),
                "tags":       p.get("tags", []),
                "reason":     reason,
                "source":     "graph",
            })

    # embedding 兜底
    if len(results) < count:
        sims = get_embedding_similarity(pid, seen, top_n=count * 3)
        curr_diff = problems_data.get(pid, {}).get("difficulty", 5)
        for s in sims:
            if len(results) >= count:
                break
            p = problems_data.get(s["id"], {})
            n_diff = p.get("difficulty", 5)
            diff_delta = n_diff - curr_diff
            if diff_delta >= 0:
                reason = "再来一题！（差不多难度）" if diff_delta <= 1 else "再来一题！（更难的）"
                results.append({
                    "id":         s["id"],
                    "title":      p.get("title", ""),
                    "difficulty":  n_diff,
                    "tags":       p.get("tags", []),
                    "reason":     reason,
                    "source":     "embedding",
                })
                seen.add(s["id"])

    return results[:count]


def recommend_easier(pid: str, count: int = 3) -> list:
    """推荐铺垫题：图上入边 + embedding 中更简单的"""
    results = []
    seen = {pid}
    curr_diff = problems_data.get(pid, {}).get("difficulty", 5)

    if graph and pid in graph:
        in_edges = []
        for source, _, data in graph.in_edges(pid, data=True):
            if source in seen:
                continue
            rel = data.get("relation", "")
            conf = data.get("confidence", 0)
            s_data = graph.nodes.get(source, {})
            s_diff = s_data.get("difficulty", 5)

            if s_diff > curr_diff:
                continue

            score = conf
            if rel == "PREREQUISITE_OF":
                score += 2.0
            elif rel == "SAME_TECHNIQUE":
                score += 1.0
            if data.get("source") == "teacher":
                score += 3.0

            in_edges.append((source, score, rel))

        in_edges.sort(key=lambda x: -x[1])
        for nid, score, rel in in_edges[:count]:
            seen.add(nid)
            p = problems_data.get(nid, {})
            results.append({
                "id":        nid,
                "title":     p.get("title", ""),
                "difficulty": p.get("difficulty", 0),
                "tags":      p.get("tags", []),
                "reason":    "卡住了？来题简单的",
                "source":    "graph",
            })

    if len(results) < count:
        sims = get_embedding_similarity(pid, seen, top_n=count * 5)
        for s in sims:
            if len(results) >= count:
                break
            p = problems_data.get(s["id"], {})
            n_diff = p.get("difficulty", 5)
            if n_diff < curr_diff:
                results.append({
                    "id":        s["id"],
                    "title":     p.get("title", ""),
                    "difficulty": n_diff,
                    "tags":      p.get("tags", []),
                    "reason":    "卡住了？来题简单的",
                    "source":    "embedding",
                })
                seen.add(s["id"])

    return results[:count]


def recommend_topic(topic: str, count: int = 10) -> list:
    """按知识点/标签专项训练"""
    results = []
    topic_lower = topic.lower()

    for pid, p in problems_data.items():
        tags = [t.lower() for t in p.get("tags", [])]
        kps = [k.lower() for k in p.get("knowledge_points", [])]
        if topic_lower in tags or topic_lower in kps or any(topic_lower in t for t in tags) or any(topic_lower in k for k in kps):
            results.append({
                "id":        pid,
                "title":     p.get("title", ""),
                "difficulty": p.get("difficulty", 0),
                "tags":      p.get("tags", []),
                "reason":    "专项训练！",
                "source":    "topic",
            })

    results.sort(key=lambda x: x["difficulty"])
    return results[:count]


def _build_reason(rel: str, diff_delta: int, n_diff: int) -> str:
    if rel == "HARDER_VERSION":
        return "再来一题！（更难的）"
    elif rel == "SAME_TECHNIQUE":
        if diff_delta <= 1:
            return "再来一题！（同技巧，差不多难度）"
        else:
            return "再来一题！（同技巧，更难的）"
    elif rel == "PREREQUISITE_OF":
        return "进阶练习"
    elif rel == "SIMILAR_TO":
        return "再来一题！（差不多难度）"
    return "推荐练习"


def edit_graph(action: str, params: dict) -> dict:
    """教师手动编辑图谱"""
    global graph

    if action == "add_edge":
        id_a = str(params.get("id_a", ""))
        id_b = str(params.get("id_b", ""))
        relation = params.get("relation", "SIMILAR_TO")
        reason = params.get("reason", "教师标注")
        if not id_a or not id_b:
            return {"success": False, "error": "缺少 id_a 或 id_b"}

        edge_attrs = {
            "relation":   relation,
            "confidence": 1.0,
            "reason":     reason,
            "source":     "teacher",
            "similarity": 0,
        }

        if relation in ("SIMILAR_TO", "SAME_TECHNIQUE"):
            graph.add_edge(id_a, id_b, **edge_attrs)
            graph.add_edge(id_b, id_a, **edge_attrs)
        else:
            graph.add_edge(id_a, id_b, **edge_attrs)

        _save_graph()
        return {"success": True}

    elif action == "remove_edge":
        id_a = str(params.get("id_a", ""))
        id_b = str(params.get("id_b", ""))
        if graph.has_edge(id_a, id_b):
            graph.remove_edge(id_a, id_b)
        if graph.has_edge(id_b, id_a):
            edge_data = graph.edges.get((id_b, id_a), {})
            if edge_data.get("relation") in ("SIMILAR_TO", "SAME_TECHNIQUE"):
                graph.remove_edge(id_b, id_a)
        _save_graph()
        return {"success": True}

    elif action == "update_difficulty":
        pid = str(params.get("id", ""))
        difficulty = params.get("difficulty")
        reason = params.get("reason", "")
        if pid in graph:
            graph.nodes[pid]["difficulty"] = difficulty
            graph.nodes[pid]["difficulty_note"] = reason
        if pid in problems_data:
            problems_data[pid]["difficulty"] = difficulty
        _save_graph()
        _save_problems_data()
        return {"success": True}

    return {"success": False, "error": f"未知操作: {action}"}


def _save_graph():
    with open(GRAPH_FILE, "wb") as f:
        pickle.dump(graph, f)


def _save_problems_data():
    with open(ANALYZED_FILE, "w", encoding="utf-8") as f:
        for pid in sorted(problems_data.keys(), key=lambda x: int(x) if x.isdigit() else x):
            f.write(json.dumps(problems_data[pid], ensure_ascii=False) + "\n")


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._send_json({"status": "ok", "nodes": graph.number_of_nodes(), "edges": graph.number_of_edges()})

        elif path == "/graph/info":
            edge_types = {}
            for _, _, d in graph.edges(data=True):
                t = d.get("relation", "UNKNOWN")
                edge_types[t] = edge_types.get(t, 0) + 1
            self._send_json({
                "nodes": graph.number_of_nodes(),
                "edges": graph.number_of_edges(),
                "edge_types": edge_types,
            })

        elif path.startswith("/graph/node/"):
            pid = path.split("/")[-1]
            if pid not in graph:
                self._send_json({"success": False, "error": "节点不存在"}, 404)
                return
            node = dict(graph.nodes[pid])
            neighbors = []
            for _, nb, d in graph.out_edges(pid, data=True):
                neighbors.append({"id": nb, "title": graph.nodes.get(nb, {}).get("title", ""), **d})
            in_neighbors = []
            for src, _, d in graph.in_edges(pid, data=True):
                in_neighbors.append({"id": src, "title": graph.nodes.get(src, {}).get("title", ""), **d})
            self._send_json({"success": True, "node": node, "out_neighbors": neighbors, "in_neighbors": in_neighbors})

        elif path == "/graph/all-edges":
            edges = []
            for a, b, d in graph.edges(data=True):
                edges.append({"id_a": a, "id_b": b, **d})
            self._send_json({"success": True, "edges": edges})

        elif path == "/problems/tags":
            tag_counts = {}
            for p in problems_data.values():
                for t in p.get("tags", []):
                    tag_counts[t] = tag_counts.get(t, 0) + 1
            sorted_tags = sorted(tag_counts.items(), key=lambda x: -x[1])
            self._send_json({"success": True, "tags": [{"name": t, "count": c} for t, c in sorted_tags]})

        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/recommend":
            body = self._read_body()
            pid = str(body.get("problem_id", ""))
            mode = body.get("mode", "next")
            count = body.get("count", 3)

            if mode == "next":
                recs = recommend_next(pid, count)
            elif mode == "easier":
                recs = recommend_easier(pid, count)
            elif mode == "topic":
                topic = body.get("topic", "")
                recs = recommend_topic(topic, count)
            else:
                self._send_json({"success": False, "error": f"未知模式: {mode}"})
                return

            self._send_json({"success": True, "recommendations": recs})

        elif path == "/graph/edit":
            body = self._read_body()
            action = body.get("action", "")
            result = edit_graph(action, body)
            self._send_json(result)

        elif path == "/graph/reload":
            load_data()
            self._send_json({"success": True, "message": "已重新加载"})

        else:
            self._send_json({"error": "Not found"}, 404)


def main():
    load_data()
    port = int(os.environ.get("PORT", 9100))
    server = HTTPServer(("127.0.0.1", port), RequestHandler)
    print(f"\n推荐服务已启动：http://127.0.0.1:{port}")
    print(f"  GET  /health")
    print(f"  POST /recommend")
    print(f"  GET  /graph/info")
    print(f"  GET  /graph/node/:id")
    print(f"  POST /graph/edit")
    print(f"  GET  /problems/tags\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n推荐服务已停止")


if __name__ == "__main__":
    main()
