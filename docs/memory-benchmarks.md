# Memory benchmarks

How the memory book ([memory.md](memory.md)) was measured, against what, and
what the numbers do and do not show. Harness and reproduction steps:
[benchmarks/](benchmarks/README.md). All runs 2026-09-27.

## Setup

- **Benchmark**: [AMB](https://github.com/vectorize-io/agent-memory-benchmark)
  (vectorize-io/agent-memory-benchmark) on **LoCoMo**: long multi-session
  conversations, questions in four categories. Adversarial (unanswerable)
  questions are excluded, as in every published LoCoMo number.
- **Answer model and judge**: local Qwen3.6-35B-A3B (llama-server, thinking
  off) for both — the same for every system, so systems compare within a run.
- **Strict judge**: LoCoMo's stock judge prompt says "cannot answer" is
  correct when the gold answer is missing; a local judge applied that to every
  question. It was removed (bm25 fell from 67.1% to 64.5%). A no-memory floor
  scores 0.0%, so the model does not know LoCoMo by heart.
- **Embeddings**: EmbeddingGemma-300M on the CPU (llama-embed), for the book
  and for mem0 alike.
- **LLM-free metric**: *evidence recall* — the share of the gold evidence turns
  whose text actually reaches the answer model. It isolates retrieval from the
  answer model's skill.

## LoCoMo, one conversation (conv-26, 152 questions)

| Variant | Accuracy (95% CI) | Evidence recall | Context tokens |
|---|---|---|---|
| no memory | 0.0% | 0.0% | 0 |
| bm25 (AMB baseline, 512-token chunks) | 64.5% (±7.6) | 58.6% | 4,874 |
| book, raw sessions, keyword only | 84.2% | 75.4% | 3,190 |
| book, raw sessions, hybrid | 84.2% (±5.8) | 80.8% | 3,218 |
| book, raw sessions, hybrid, k=16 | 86.2% (±5.5) | 84.7% | 5,083 |
| book-extract (notes only) | 71.1% (±7.2) | — | 2,535 |
| **book-tiered** (notes + session digests — what pi uses) | **75.7%** (±6.8) | — | 2,524 |

Per category (correct / questions):

| Variant | single-hop | temporal | multi-hop | open-domain |
|---|---|---|---|---|
| bm25 | 19/32 | 9/37 | 9/11 | 59/70 |
| book, raw, hybrid | 22/32 | 32/37 | 8/11 | 64/70 |
| book, raw, k=16 | 21/32 | 34/37 | 10/11 | 64/70 |
| book-extract | 22/32 | 30/37 | 7/11 | 48/70 |
| book-tiered | 24/32 | 29/37 | 7/11 | 54/70 |

Paired significance (same questions, exact McNemar):

- book (raw) vs bm25: 40 wins, 10 losses, **p < 0.001** — real.
- book-tiered vs book-extract: 23 vs 16, p = 0.34 — not significant yet.
- k=16 vs k=10: 12 vs 9, p = 0.66 — noise.
- raw sessions vs tiered notes: 29 vs 16, p = 0.07 — extraction loses detail;
  pi reaches the raw tier on demand through `memory` action `history`.

Why the book beats bm25: every section carries its session date (temporal
9/37 → 32/37), and hybrid search finds more of the evidence in fewer tokens.

## Read cost: evidence per token (all 10 conversations, 1,535 questions)

LLM-free. Raw sessions stored as the book stores them; each strategy filled a
fixed token budget.

| Budget | whole sections | single bullets | bullets ±1 neighbour | bullets ±2 |
|---|---|---|---|---|
| 500 | 44.5% | **57.4%** | 55.0% | 54.9% |
| 1,000 | 62.6% | **68.6%** | 64.6% | 67.6% |
| 2,000 | 74.5% | **79.6%** | 75.3% | 76.5% |
| 3,000 | 80.1% | **85.0%** | 81.0% | 82.5% |

Bullet-level reads deliver the same evidence as section reads for about a third
fewer tokens (bullets at 2,000 ≈ sections at 3,000). Neighbouring turns spend
budget without adding evidence, so reads default to none. These results made
bullet-level budgeted reads the default for recall and `memory search`.

## Write quality (the coding use case)

`benchmarks/write-quality/`: scripted coding-session transcripts with known
right answers. Each scenario runs twice; a run passes only if capture adds what
it should, in the right scope, and nothing else.

Scenarios: chatter and long explanations (nothing to keep), a stated
preference, a project convention, a contradiction of an existing note, a
duplicate, a pasted token, an unconfirmed suggestion, a decision with its
reason, environment facts, a gotcha buried in tool chatter, a stale fact, a
code dump, a user/project scope split, a temporary state, a paraphrased
duplicate, a claim the assistant read from the code, a targeted update among
several notes, two captures in one session, an oversized fact, promotion on
expiry, and an assistant finding that contradicts a user's note.

| Model (mode) | Scenario set | Runs passed | Junk runs | Facts captured | Secret leaks |
|---|---|---|---|---|---|
| DeepSeek v4.1 Flash (pi) | 23, with tiers | **45/46** | 0/20 | 25/26 | 0 |
| Qwen3.6-35B local (raw) | first 14 | 28/28 | 0/10 | 18/18 | 0 |
| MiMo v2.6 Flash (pi, fallback) | 19 | 35/38 | 2/16 | 24/24 | 0 |

The one DeepSeek miss was variance: the same scenario passed 6 of 6 reruns.
MiMo's misses (turning chatter into a rule, filing a repo fact as a user fact)
led to two guards: a code rule for "this repo" facts and a prompt rule against
inferred rules. Two bugs found by these runs are fixed: an empty digest reply
wiped the session's digest, and a "rewording" guard blocked a real one-word
change (master → main).

## Against mem0

mem0 OSS 2.2.1 through the same harness (`mem0_local.py`): same input lines and
session dates, same embedder, embedded Qdrant, AMB's default of 20 memories.

**Validation, 12 questions, DeepSeek via pi sessions (no GPU):**

| | book-tiered | mem0 2.2.1 |
|---|---|---|
| Correct | 10/12 | 9/12 |
| Date questions | 2/3 | 0/3 |
| Prompt per session ingested | **10.5k chars** | 39.5k chars |
| Ingest, 19 sessions | **539 s** | 634 s |
| Context per question | 2,869 tokens | **985 tokens** |
| Search latency | 79 ms | 14 ms |

12 questions carry a ±25-point margin: this validates the plumbing, not a
ranking. What holds already: the book is ~3.8× cheaper to write. Reads are now
budgeted (≈1k tokens gives 68.6% evidence recall on raw sessions), so a
like-for-like accuracy comparison is the next run.

**Pending**: mem0 vs book-tiered on local Qwen at the same ~1k-token read
budget, 3 or all 10 conversations; mem0 through the write-quality suite.

## Published numbers, for context only

Not comparable with the tables above — different answer models, judges and
question sets.

| System | LoCoMo | Notes |
|---|---|---|
| mem0 ([paper](https://arxiv.org/html/2504.19413), 2025) | 66.9% (graph variant 68.4%) | GPT-4o-mini answers, lenient judge, 1,540 questions; same paper: full context 72.9%, best RAG 60.5% |
| mem0 ([site](https://mem0.ai/research), 2026) | 92.5% | self-reported, newer algorithm |
| Mnemosyne ([paper](https://arxiv.org/abs/2510.08601)) | 54.6% | edge-oriented memory architecture |
| mnemosyne-oss ([repo](https://github.com/mnemosyne-oss/mnemosyne)) | — | reports BEAM 65.2%; withdrew an earlier LongMemEval claim |

The most portable signal is the gain over a keyword-RAG baseline measured in the
same harness: +20 points for the book over bm25 here, +6 for mem0 over its best
RAG in its paper.
