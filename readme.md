# Smart Agent OJ

## What Is This

A training tool for competitive programming (OI) students. The core idea: **separate algorithmic thinking from coding practice**, letting AI step in at the right moments to accelerate learning without replacing genuine thought.

## Usage

```
npm install
node app.js
```

## Problems It Solves

- **Slow feedback loop**: Students have to write a full solution before they can validate their approach, often discovering an hour later that their direction was wrong. There is no way to quickly ask "is my thinking correct?"
- **Erosion of fundamentals**: Over-relying on AI for code generation leaves students unable to write basic templates by hand.
- **Thinking and coding entangled**: When tackling hard problems, constantly switching between the two means neither gets practiced deeply.

![Screenshot](https://github.com/wuzengqing001225/SmartAgentOJ/blob/main/image/image.png?raw=true)

## Two Training Modes

| Mode | Best For | What AI Does |
|------|----------|--------------|
| **Handwriting Mode** | Foundational problems (DFS/BFS, sorting, basic DP, etc.) | Does not intervene in coding or algorithmic thinking. Provides compile-and-run only. Students may ask about their own written code ("Why is this wrong?" / "Is there a better approach?"), and AI responds with guiding questions rather than direct answers. |
| **Idea Validation Mode** | Hard problems (complex DP, network flow, number theory, etc.) | Student describes their approach → AI asks clarifying questions to sharpen it → generates code **strictly following the student's idea** (no silent optimizations) → student can view a code-explanation Q&A → student asks follow-up questions, ensuring they can explain why the code is written that way after using it. |

Core principles:
- **Socratic questioning** runs through both modes as a feature, not a mode. AI always guides through questions and never gives direct answers.
- All questions are initiated by the student; AI never proactively generates questions. This trains students to ask well, naturally nudging them to anticipate what the next question might be — something traditional methods rarely formalize.
- Modes have strict boundaries: in Handwriting Mode students cannot ask "what algorithm should I use for this problem"; in Idea Validation Mode AI cannot redirect the student's chosen approach.
- Code generated in Idea Validation Mode must be **honest** — it implements exactly what the student described, even if AI knows a more optimal solution.

## Key Features

**Online C++ Compile & Run** — Write, compile, and test code directly within the platform.

**Socratic Q&A Panel** — A right-side panel with starter question templates for reference. Students ask on their own initiative; AI responds with guiding follow-ups.

**Idea-to-Code Generation** *(Idea Validation Mode only)* — After the student confirms their approach, one click generates a C++ implementation that follows it faithfully.

**Code Explanation Q&A** *(Idea Validation Mode only)* — Triggered manually by the student, explaining which part of their idea each code section corresponds to and which algorithms are used.

**API Usage Tracking** — View token consumption, estimated cost, and call count in the settings panel.

## Typical Workflow (Idea Validation Mode)

1. Student reads the problem.
2. Student describes their approach: "I think interval DP works here — the state dp[i][j] represents…"
3. AI asks: "What exactly does j represent? How do you handle boundary transitions?"
4. Student fills in the details.
5. Student clicks **Generate Code**; AI produces a C++ implementation strictly following the student's approach.
6. Student compiles and runs to verify.
7. Student clicks **Explain Code** and reviews the Q&A to fully understand the implementation.

---

# Technical Design

## Architecture

Single-process Express + Handlebars (HBS) application running on port 3000.

```
smartoj/
├── app.js                  # Entry point — starts Express, loads backend/server.js
├── backend/
│   └── server.js           # Routes + API (compile, chat, usage)
├── views/
│   └── index.hbs           # Main page template
├── public/
│   ├── css/style.css
│   └── js/app.js           # Frontend logic
└── package.json
```

## C++ Compilation

Calls the system `g++` (MacOS) directly — no Docker required:

```bash
g++ -std=c++17 -O2 -o /tmp/xxx/a.out /tmp/xxx/main.cpp
```

Backend flow: write temp files → compile with `g++` → execute (5 s timeout) → return stdout / stderr / elapsed time → clean up temp files.

## LLM Integration

Uses the DeepSeek API, configured via the `DEEPSEEK_API_KEY` field in `data/config.json`.

Each mode's AI behavior is governed by a distinct system prompt:
- **Handwriting Mode**: AI is prohibited from providing code, approaches, or algorithm suggestions. It may only help clarify the problem statement and ask guiding questions about code the student has already written.
- **Idea Validation Mode**: AI asks clarifying questions to sharpen the student's thinking → generates code strictly following the student's approach → does not redirect or modify the student's chosen direction.

---

If you find our work useful, please give us credit by citing:

```bibtex
@software{smartagentoj2026,
  author       = {Zengqing Wu and Chuan Xiao},
  title        = {SmartAgentOJ: An AI-Assisted Training Tool for Competitive Programming},
  year         = {2026},
  url          = {https://github.com/wuzengqing001225/SmartAgentOJ},
}
```
