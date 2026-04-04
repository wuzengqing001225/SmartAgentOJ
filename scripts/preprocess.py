#!/usr/bin/env python3
"""
preprocess.py — 从 /Users/wuzengqing/Desktop/Data/少年宫OJ题目/ 目录下
依次读取所有 XML 文件，将题目追加/更新到 data/problems.json。
只保留题目元信息字段，不导入测试数据（test_input / test_output）。

用法：
    python3 scripts/preprocess.py
"""

import os
import re
import json
import xml.etree.ElementTree as ET
from html.parser import HTMLParser


# ── HTML 转纯文本 ──────────────────────────────────────────────────────────────

class _HTMLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str):
        self._parts.append(data)

    def get_text(self) -> str:
        raw = ' '.join(self._parts)
        raw = re.sub(r'[ \t]+', ' ', raw)
        raw = re.sub(r'\n{3,}', '\n \n \n ', raw)
        return raw.strip()


def strip_html(html_text: str) -> str:
    if not html_text:
        return ''
    s = _HTMLStripper()
    try:
        s.feed(html_text)
    except Exception:
        return html_text
    return s.get_text()


# ── 从 URL 提取题目 ID ─────────────────────────────────────────────────────────

def extract_id_from_url(url: str) -> str | None:
    m = re.search(r'[?&]id=(\d+)', url or '')
    return m.group(1) if m else None


# ── 解析单个 FPS XML 文件 ──────────────────────────────────────────────────────

# 匹配 <test_input ...>...</test_input> 和 <test_output ...>...</test_output>
# 包括 CDATA 块，用于在解析前剔除二进制/非法内容
_RE_TEST_NODES = re.compile(
    r'<test_(?:input|output)\b[^>]*>.*?</test_(?:input|output)>',
    re.DOTALL,
)


def _sanitize_xml(raw: bytes) -> bytes:
    """剔除 test_input/test_output 节点，并移除 XML 1.0 非法控制字符。"""
    text = raw.decode('utf-8', errors='replace')
    text = _RE_TEST_NODES.sub('', text)
    # 移除 XML 1.0 禁止的控制字符（U+0000-U+0008, U+000B-U+000C, U+000E-U+001F, U+FFFE, U+FFFF）
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]', '', text)
    return text.encode('utf-8')


def parse_fps_file(xml_path: str) -> list[dict]:
    with open(xml_path, 'rb') as f:
        raw = f.read()
    clean = _sanitize_xml(raw)
    root = ET.fromstring(clean)
    problems: list[dict] = []

    for item in root.findall('item'):
        url = (item.findtext('url') or '').strip()
        pid = extract_id_from_url(url)
        if not pid:
            continue

        title        = (item.findtext('title') or '').strip()
        description  = strip_html(item.findtext('description') or '')
        input_desc   = strip_html(item.findtext('input') or '')
        output_desc  = strip_html(item.findtext('output') or '')
        time_limit   = (item.findtext('time_limit') or '1').strip()
        memory_limit = (item.findtext('memory_limit') or '128').strip()

        # 收集样例（sample_input / sample_output 成对出现）
        samples: list[dict] = []
        children = list(item)
        i = 0
        while i < len(children):
            if children[i].tag == 'sample_input':
                si = (children[i].text or '').strip()
                so = ''
                if i + 1 < len(children) and children[i + 1].tag == 'sample_output':
                    so = (children[i + 1].text or '').strip()
                    i += 1
                samples.append({'input': si, 'output': so})
            i += 1

        problems.append({
            'id':          pid,
            'title':       title,
            'description': description,
            'inputDesc':   input_desc,
            'outputDesc':  output_desc,
            'samples':     samples,
            'timeLimit':   time_limit,
            'memoryLimit': memory_limit,
        })

    return problems


# ── 主流程 ─────────────────────────────────────────────────────────────────────

SOURCE_DIR = '/Users/wuzengqing/Desktop/Data/少年宫OJ题目'


def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_file = os.path.join(base_dir, 'data', 'problems.json')

    if not os.path.isdir(SOURCE_DIR):
        print(f'[错误] 源目录不存在：{SOURCE_DIR}')
        return

    xml_files = sorted(
        os.path.join(SOURCE_DIR, f)
        for f in os.listdir(SOURCE_DIR)
        if f.endswith('.xml')
    )

    if not xml_files:
        print('[提示] 未在源目录找到任何 XML 文件。')
        return

    # 读取已有数据（增量更新）
    all_problems: dict = {}
    if os.path.exists(out_file):
        try:
            with open(out_file, encoding='utf-8') as f:
                all_problems = json.load(f)
            print(f'[信息] 已读取现有数据：{len(all_problems)} 道题目')
        except Exception as e:
            print(f'[警告] 读取现有 JSON 失败，将全量重建：{e}')

    total_added = 0
    for xml_path in xml_files:
        fname = os.path.basename(xml_path)
        print(f'[解析] {fname} ...', end=' ', flush=True)
        try:
            problems = parse_fps_file(xml_path)
            for p in problems:
                all_problems[p['id']] = p
            total_added += len(problems)
            print(f'{len(problems)} 题')
        except Exception as e:
            print(f'失败：{e}')

    # 按题目 ID 数值排序后写出
    sorted_problems = dict(
        sorted(all_problems.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else kv[0])
    )

    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(sorted_problems, f, ensure_ascii=False, indent=2)

    print(f'\n[完成] 共处理 {total_added} 道题目，problems.json 现有 {len(sorted_problems)} 道，'
          f'已保存至 {out_file}')


if __name__ == '__main__':
    main()
