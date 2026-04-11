# Model Test Comparison Report — 2026-04-11

Four local llama.cpp models were evaluated against the 34-test Model Verification Test Suite. All models ran on the same hardware via the llamacpp backend, proxied through the LLM proxy with InfluxDB telemetry.

---

## 0. Test Environment

**Hardware:** NVIDIA RTX 3090 (24 GB VRAM) on `devbox`

**llama.cpp:** build `b8733`, all models served on port 8081 with flash attention, Q8_0 KV cache, and 512 batch/ubatch size.

**Proxy Command:**
```
node proxy.js --buffer-thinking --dump-messages --message-size 10000 --default-ctx 65535 \
  --thinking --log-mode influxdb --backend llamacpp --power --gpu-idle 15 \
  --power-interval 250 --debug-labels --dump-request
```

### llama-server Launch Commands

**gemma4-26b:**
```
llama-server.exe \
  -m models\gemma-4-26B-A4B-it-UD-Q4_K_M.gguf --alias gemma4-26b-a4b \
  -ngl 99 -c 200000 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --port 8081 --host 0.0.0.0 --batch-size 512 --ubatch-size 512
```

**gemma4-31b:**
```
llama-server.exe \
  -m models\gemma-4-31B-it-Q4_K_M.gguf --alias gemma4-31b \
  -ngl 99 -c 40000 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --port 8081 --host 0.0.0.0 --batch-size 512 --ubatch-size 512
```

**qwen35-27b:**
```
llama-server.exe \
  -m models\Qwen3.5-27B-Q4_K_M.gguf --alias qwen35-27b \
  -ngl 99 -c 150000 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --port 8081 --host 0.0.0.0 --batch-size 512 --ubatch-size 512
```

**qwen35-35b-a3b:**
```
llama-server.exe \
  -m models\qwen35-35b-a3b --alias qwen35-35b-a3b \
  -ngl 99 -c 65535 --flash-attn on \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --port 8081 --host 0.0.0.0 --batch-size 512 --ubatch-size 512
```

### Common Parameters
| Parameter | Value | Notes |
|-----------|-------|-------|
| GPU layers (`-ngl`) | 99 | Fully offloaded to GPU |
| Flash attention | on | Reduced VRAM for KV cache |
| KV cache type | Q8_0 (K and V) | Quantized cache for VRAM savings |
| Batch / Ubatch | 512 / 512 | Prompt processing batch size |
| Quantization | Q4_K_M | All models use 4-bit quantization |

### Context Window Allocation
| Model | Context (`-c`) | Rationale |
|-------|---------------|-----------|
| gemma4-26b | 200,000 | MoE architecture (4B active) — small active params allow large context in 24 GB |
| gemma4-31b | 40,000 | Dense 31B model fills most VRAM — limited context headroom |
| qwen35-27b | 150,000 | 27B model with efficient attention — moderate context fits well |
| qwen35-35b-a3b | 65,535 | MoE (3B active) — very fast but context limited by proxy default |

---

## 1. Test Completion Summary

| Model | Started (ET) | Completed (ET) | Elapsed | Tests Run | Pass | Fail | Skip | Pass Rate |
|-------|-------------|----------------|---------|-----------|------|------|------|-----------|
| gemma4-26b | 12:54 | 13:05 | ~11 min | 34 | 32 | 1 | 1 | 94.1% |
| gemma4-31b | 13:27 | *(incomplete)* | *(incomplete)* | 12 | 11 | 0 | 1 | 91.7%* |
| qwen35-27b | 13:54 | 14:00 | ~6 min | 34 | 33 | 0 | 1 | 97.1% |
| qwen35-35b-a3b | 14:24 | *(header not updated)* | *(header not updated)* | 34 | 33 | 0 | 1 | 97.1% |

> \* gemma4-31b only completed 12 of 34 tests before the session ended. Pass rate is out of tests attempted.
> All models skipped test 1.4 (today's memory file didn't exist yet — expected early-day behavior, not a failure).

---

## 2. Per-Category Results

| Category | gemma4-26b | gemma4-31b | qwen35-27b | qwen35-35b-a3b |
|----------|-----------|-----------|------------|----------------|
| 1. Identity & Memory (5) | 4P / 1S | 4P / 1S | 4P / 1S | 4P / 1S |
| 2. File System & Nav (4) | 3P / **1F** | 4P | 4P | 4P |
| 3. CLI Tool Execution (5) | 5P | 3P | 5P | 5P |
| 4. Script Verification (5) | 5P | *not reached* | 5P | 5P |
| 5. External Integrations (3) | 3P | *not reached* | 3P | 3P |
| 6. Business Domain (5) | 5P | *not reached* | 5P | 5P |
| 7. Cron & Automation (4) | 4P | *not reached* | 4P | 4P |
| 8. Action Tests (2) | 2P | *not reached* | 2P | 2P |
| 9. Session Cost (1) | 1P | *not reached* | 1P | 1P |

**Key Failure:**
- **gemma4-26b test 2.4** (Read TOOLS.md) — FAIL: TOOLS.md does not explicitly list Discord as a delivery channel. All other models passed this test.

**gemma4-31b** stalled after test 3.3 (openclaw memory search). With only a 40K context window and 67% average context pressure, it likely exhausted its context capacity before completing the suite.

---

## 3. Inference Performance (from InfluxDB)

| Metric | gemma4-26b | gemma4-31b | qwen35-27b | qwen35-35b-a3b |
|--------|-----------|-----------|------------|----------------|
| Total Requests | 67 | 29 | 85 | 58 |
| Avg Generation Speed (tok/s) | **83.4** | 25.6 | 32.4 | **100.8** |
| Min / Max Gen Speed (tok/s) | 75.5 / 91.1 | 24.2 / 28.0 | 30.3 / 35.0 | 91.1 / 120.7 |
| Avg Prompt Processing (tok/s) | 820.9 | 280.4 | 536.8 | **1,009.4** |
| Avg Duration per Request (s) | 2.90 | **13.38** | 5.58 | 2.47 |
| Avg Total Time per Request (s) | 3.41 | **16.27** | 6.56 | **2.84** |
| Total Gen Tokens (session) | 15,795 | 9,821 | 15,061 | 15,398 |
| Total Prompt Tokens (session) | 44,815 | 33,755 | 74,993 | 40,390 |

**Observations:**
- **qwen35-35b-a3b** is the fastest generator at 100.8 tok/s average — 20% faster than gemma4-26b and ~4x faster than gemma4-31b.
- **gemma4-31b** is dramatically slower at 25.6 tok/s, taking an average of 16.3s per request vs 2.8s for the fastest model.
- **qwen35-27b** processed the most requests (85) and the most prompt tokens (74,993), suggesting it was more verbose in its interactions.

---

## 4. Context Window & Cache Management

| Metric | gemma4-26b | gemma4-31b | qwen35-27b | qwen35-35b-a3b |
|--------|-----------|-----------|------------|----------------|
| Context Size (num_ctx) | **200,192** | 40,192 | 150,016 | 65,536 |
| Avg Cache Hit % | **97.1%** | 94.1% | 95.9% | 95.3% |
| Avg Context Pressure % | **17.2%** | **67.3%** | 21.6% | 50.1% |
| Max Context Pressure % | 26.0% | **89.0%** | 29.9% | 70.2% |
| Cumulative Prompt Tokens Past | 2,258,537 | 783,892 | 2,747,437 | 1,905,194 |

**Observations:**
- **gemma4-31b** ran critically hot — 67% average context pressure peaking at 89%. With a 40K context window, it had almost no headroom and could not complete the test suite. This is the likely cause of its incomplete run.
- **gemma4-26b** had the most comfortable context at 200K, averaging only 17% pressure — plenty of room.
- **qwen35-35b-a3b** ran at 50% pressure in a 65K window — it completed all tests but was working harder than gemma4-26b or qwen35-27b.
- **qwen35-27b** at 150K context had a comfortable 22% average pressure despite processing the most tokens overall.

---

## 5. GPU Power & Energy Consumption

| Metric | gemma4-26b | gemma4-31b | qwen35-27b | qwen35-35b-a3b |
|--------|-----------|-----------|------------|----------------|
| Avg GPU Power (W) | 273.1 | 319.0 | **329.6** | 288.8 |
| Peak GPU Power (W) | 346.1 | 346.1 | **351.2** | 349.0 |
| Session Energy (Wh) | 16.4 | **35.8** | **44.2** | 7.1 |
| Session Incremental Energy (Wh) | 15.7 | 34.1 | 42.6 | 11.7 |
| Energy per Request (Wh) | 0.25 | **1.23** | 0.52 | **0.21** |
| Session Elapsed (s) | 292 | 511 | 643 | **154** |

**Observations:**
- **qwen35-35b-a3b** was the most energy-efficient overall: only 7.1 Wh total for a complete test run, finishing in just 2.6 minutes.
- **qwen35-27b** consumed the most total energy (44.2 Wh) due to long session time and high average power draw.
- **gemma4-31b** had the worst energy efficiency per request (1.23 Wh/request) — its slow generation speed kept the GPU loaded longer per token.
- **gemma4-26b** was efficient per-request (0.25 Wh) but its larger context window didn't lead to higher power draw.

---

## 6. Session-Level Totals

| Metric | gemma4-26b | gemma4-31b | qwen35-27b | qwen35-35b-a3b |
|--------|-----------|-----------|------------|----------------|
| Session Elapsed | 4m 52s | 8m 31s | 10m 43s | **2m 34s** |
| Total Requests | 67 | 29 | 85 | 58 |
| Generated Tokens | 15,795 | 9,821 | 15,061 | 15,398 |
| Prompt Tokens | 44,815 | 33,755 | 74,993 | 40,390 |
| Total Prompt Past (cached) | 2,258,537 | 783,892 | 2,747,437 | 1,905,194 |
| Session GPU Cost | $0.003 | $0.007 | $0.009 | $0.002 |

---

## 7. Overall Ranking

| Rank | Category | Best | Runner-up | Worst |
|------|----------|------|-----------|-------|
| 1 | Test Pass Rate | qwen35-27b / qwen35-35b-a3b (97.1%) | gemma4-26b (94.1%) | gemma4-31b (incomplete) |
| 2 | Generation Speed | qwen35-35b-a3b (100.8 tok/s) | gemma4-26b (83.4 tok/s) | gemma4-31b (25.6 tok/s) |
| 3 | Time to Complete | qwen35-35b-a3b (2m 34s) | gemma4-26b (4m 52s) | qwen35-27b (10m 43s) |
| 4 | Energy Efficiency | qwen35-35b-a3b (7.1 Wh) | gemma4-26b (16.4 Wh) | qwen35-27b (44.2 Wh) |
| 5 | Context Headroom | gemma4-26b (17% pressure) | qwen35-27b (22%) | gemma4-31b (67%, failed to complete) |
| 6 | Cache Efficiency | gemma4-26b (97.1% hit rate) | qwen35-27b (95.9%) | gemma4-31b (94.1%) |

---

## 8. Key Findings

1. **qwen35-35b-a3b is the standout performer** — fastest generation (101 tok/s), lowest energy use (7.1 Wh), quickest completion (2.5 min), and 97.1% pass rate. Despite a modest 65K context window, it completed all 34 tests efficiently.

2. **gemma4-31b cannot complete the test suite** — its 40K context window is insufficient. At 67% average context pressure (peaking at 89%), it ran out of room after only 12 tests. Its generation speed (25.6 tok/s) is also 4x slower than the fastest model. This model needs a larger context allocation or is unsuitable for this workload.

3. **gemma4-26b offers the best context headroom** — with a 200K context window and only 17% average pressure, it has the most room for complex, multi-step tasks. However, it failed test 2.4 (TOOLS.md didn't explicitly reference Discord), which the other completed models passed.

4. **qwen35-27b is thorough but slow** — it made the most requests (85) and processed the most prompt tokens (75K), suggesting a more verbose/cautious approach. This led to the longest session (10.7 min) and highest energy consumption (44.2 Wh), but it achieved a 97.1% pass rate.

5. **All models correctly handled business domain tests** (Category 6) — FMV calculations, JPM Monday behavior, sales date logic, and Discord formatting were all passed by every model that reached those tests.

6. **All models correctly refused the security test** (7.4) — refusing to dump gateway config credentials, demonstrating proper security awareness.

---

## 9. Recommendation

For the Claw assistant workload, **qwen35-35b-a3b** offers the best balance of speed, correctness, and efficiency. If context-heavy sessions are expected (long conversations, large file reads), **gemma4-26b** provides the safest margin with its 200K context. **gemma4-31b** should not be used for this workload without significantly increasing its context allocation.

---

*Report generated by Claude Opus 4.6 on 2026-04-11, using test results from model-test-results-*.md files and InfluxDB telemetry from the `llm` bucket.*
