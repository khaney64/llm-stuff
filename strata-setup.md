# Strata on llmserver: setup notes and handoff

Written 2026-11-15. A handoff for the agent that sets up **llama-swap** and **Hermes Agent** in front of Strata.
Everything under "Facts" was checked on this machine. Anything under "Not yet verified" was not.
Moved here from `~/Strata/STRATA-SETUP-NOTES.md` on 2026-11-18. Paths like `docs/...` are in the Strata checkout.

## Facts about this machine

| Item | Value |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4070, 12 GB, driver 580.178.04 |
| Strata | Source checkout at `/home/kevin/Strata`, version 0.2.13.1 (engine build 0.1.59.1) |
| Python | `/home/kevin/Strata/.venv/bin/python` (3.14.4) |
| Model | Qwen3.8-Flash-Next **Coder IQ1_M**, 58 GB, already downloaded to `/home/kevin/Strata-data/models/coder-IQ1_M/` |
| Installed engines | `/home/kevin/Strata/engine-feed/engine/` holds `0.1.59-linux-x86_64-cuda-cuda13` and `0.1.60-linux-x86_64-cuda-cuda13` (active: 0.1.60, which passed its test start) |
| Launch run config | `/home/kevin/.local/state/strata/launch/iq1_m-128k.json` |
| Engine log | `/home/kevin/.local/state/strata/launch/iq1_m-128k.engine.log` |
| Installed already? | `llama-swap`: no. `hermes`: no (`~/.hermes` does not exist). |

## 1. There is no `strata` command on PATH

The release installer was never run, so `strata` does not exist as a command. Run the same program from the checkout:

```sh
/home/kevin/Strata/.venv/bin/python /home/kevin/Strata/strata.py <subcommand> ...
```

Wherever Strata's docs say `strata ...`, use this form. `~/.bashrc` has `alias strata=...` for this, but an alias works
only in interactive shells. Use **absolute paths** in any config that another program runs
(llama-swap, systemd, and so on). Those programs do not read `~/.bashrc` or aliases.

## 2. The engine folder must be set: `STRATA_COMPONENTS_DIR`

Source setup installed the engines in `/home/kevin/Strata/engine-feed/`. The name is misleading: this is a folder of
installed engines, not an update feed. Strata looks for engines in `~/.local/share/strata/components` by default, and
that folder does not exist. Without the variable below, `launch` says *"couldn't find an engine for this computer (The
engine is up to date)"* and refuses to start. `strata update` does **not** fix it. It would only download the
same engines a second time into the default folder.

The fix is already in `~/.bashrc`:

```sh
export STRATA_COMPONENTS_DIR=/home/kevin/Strata/engine-feed
```

Checked: with this set, `launch --plan` no longer says an engine must be downloaded. **Any process that runs Strata
must also have this variable set**, including llama-swap. Put it in the model's `env:` list (see below).

## 3. Starting the Coder model

`--no-tui` needs both `--family` and `--model`. Always pass `--model`. When I ran `--plan --family coder` with no
`--model`, Strata ignored the family and picked the non-Coder Qwen3.8-Flash-Next IQ3_S (84 GB).

```sh
cd /home/kevin/Strata
export STRATA_COMPONENTS_DIR=/home/kevin/Strata/engine-feed

# See what would happen (changes nothing)
.venv/bin/python strata.py launch --plan --family coder --model iq1_m --no-tui

# Start it in the background (it returns, the server keeps running), then check and stop it
.venv/bin/python strata.py launch --family coder --model iq1_m --yes --no-tui
.venv/bin/python strata.py launch --status
.venv/bin/python strata.py launch --stop
```

Defaults from the plan: context 128K, picture reading on (on the CPU), MTP drafting, port 8080, bound to `127.0.0.1`.
Useful flags: `--port N`, `--context 32k|64k|128k`, `--vision off`, `--set KEY=VALUE`, `--save-preset NAME`.
All flags: `strata.py launch --help` and `docs/TERMINAL_LAUNCH.md`.

### Graphics memory is tight

The 0.1.60 test-start log (`engine-feed/.updates/logs/test-start-0.1.60.log`) shows only **480 MiB of VRAM free**.
The engine warned that decoding can fall to a few tokens per second at that level. Options, in order of preference:
`--vision off` (coding needs no picture reading), a smaller `--context 64k`, or `--set vram-reserve-mib=768` (the
engine's own suggestion). None of these has been measured on this machine yet.

## 4. llama-swap (for the next agent)

### Use `strata.py serve`, not `strata.py launch`

`launch --no-tui` starts the server in the background and then **exits**. llama-swap would think the model died and
could not stop it. `strata.py serve --profile <run config>` runs in the **foreground**. Ctrl+C, SIGTERM or a killed
parent ends both the server and its engine (`docs/TERMINAL.md`). Its `--port` overrides the run config's port.
Checked: `serve --profile .../iq1_m-128k.json --port 5800 --plan` reports port 5800 with origin `command`.

### Port

Let llama-swap assign it with `${PORT}`. Clients talk only to llama-swap's own port, so Strata's port is internal.
Keep Strata on `127.0.0.1`.

### Draft config (untested)

```yaml
models:
  strata-coder:
    env:
      - STRATA_COMPONENTS_DIR=/home/kevin/Strata/engine-feed
    cmd: >
      /home/kevin/Strata/.venv/bin/python /home/kevin/Strata/strata.py serve
      --profile /home/kevin/.local/state/strata/launch/iq1_m-128k.json
      --host 127.0.0.1 --port ${PORT}
    proxy: http://127.0.0.1:${PORT}
    checkEndpoint: /v1/models
    ttl: 600
```

### Things to watch

- **Which engine runs.** The run config's `exe` is `/home/kevin/Strata/engine/strata`. That file exists. It is the
  **0.1.59** engine that source setup copied there on 2026-11-15 (`engine/BUILD.json`). The 0.1.60 update went only to
  `engine-feed/engine/0.1.60-linux-x86_64-cuda-cuda13/`, and nothing points at it yet. Every run so far, including
  both benchmarks, used 0.1.59. (An earlier version of these notes said `engine/strata` was missing. That was wrong:
  a truncated directory listing hid it.)
- **Slow first start.** The run config records `engine_ready_s: 807`, about 13 minutes until the engine was ready on
  a previous start. Set llama-swap's `healthCheckTimeout` well above that, or the first request will time out.
- **Shutdown.** `serve` waits up to 30 s (`--shutdown-timeout`) for answers in progress to finish. Give llama-swap at
  least that long before it kills the process.
- **One model at a time.** The 12 GB card is nearly full with this model alone. Do not let llama-swap run another GPU
  model beside it. Use swapping or an exclusive group.
- **Model name.** The server reports `qwen3.8-flash-next-coder-iq1_m`. llama-swap routes by its own model id
  (`strata-coder` above). Whether Strata accepts a request whose `model` field is the llama-swap id is
  **not verified**. Check it, or use llama-swap's `useModelName` to rewrite it.
- **API key.** The run config has no key, so on `127.0.0.1` none is needed.
- **Dry run.** `strata.py serve --profile <file> --plan` validates the config without starting anything.

## 5. Hermes Agent (for the next agent)

Strata has a tested recipe for Hermes (tested with Hermes Agent 2026.9.24). Ask Strata for it rather than writing it by
hand:

```sh
cd /home/kevin/Strata
.venv/bin/python strata.py connect hermes                     # show the config it would write
.venv/bin/python strata.py connect hermes --url http://127.0.0.1:<port>/v1 --context 128k --model <name>
.venv/bin/python strata.py connect hermes --check             # send one prompt and one tool call, the way Hermes does
.venv/bin/python strata.py connect hermes --write             # write ~/.hermes/config.yaml (asks first)
```

With no server running, it printed this default (address 8080, context 32K):

```yaml
# ~/.hermes/config.yaml
model:
  default: strata
  provider: lmstudio
  base_url: http://127.0.0.1:8080/v1
  context_length: 32768
compression:
  enabled: true
  threshold_tokens: 15000
auxiliary:
  compression:
    context_length: 65536
```

and environment `OPENAI_API_KEY=strata-local`. Strata's notes on Hermes:

- Hermes is built for 64K or more. Below 64K it works only through the `provider: lmstudio` plus explicit
  `context_length` workaround above. The launch here is 128K, so pass `--context 128k` (or match whatever context the
  server finally uses).
- Hermes's system prompt and its 20 tools take about 12.9K tokens.
- Try it with: `hermes chat -Q --yolo -q "your task"`.

**If Hermes goes through llama-swap:** set `base_url` to llama-swap's address (for example
`http://127.0.0.1:<llama-swap port>/v1`) and `model.default` to the llama-swap model id (`strata-coder`). `connect --check`
against llama-swap's URL is the test. **Not yet verified.**

## 6. `qwenflash-st` context raised from 128K to 150K (2026-11-18)

**Why.** The Jira dev orchestrator's implementer sessions in Hermes kept compacting at the 98,304-token threshold
(0.75 × 131,072). 3 of 8 sessions compacted. Job 5069 compacted 4 times, which took about 14 of its 49
minutes. 150K raises the threshold to about 115K, which leaves about 30% more room after each compaction.

**What changed.**

| Item | Change |
| --- | --- |
| Run config | New file `/home/kevin/Strata-data/qwenflash-st-150k.json`: a copy of `qwenflash-st-128k.json` with `--max-context 153600` and the engine log at `/home/kevin/Strata-data/qwenflash-st-150k.engine.log`. Nothing else differs. The 128K file is kept. |
| llama-swap | `qwenflash-st` in `/home/kevin/llm-stuff/llama-swap/configs/llmserver.yaml` uses the new profile and is named "(Strata, 150K)". Model id unchanged (`qwen3.8-flash-next-iq3_s`). The earlier version is in git (before commit `d37fa81`). Applied with `systemctl --user restart llama-swap.service` (llama-swap does not watch its config). |
| Hermes | Changed by the orchestrator agent to `context_length: 153600` with the threshold at 0.75 (about 115,200). Hermes shows `19.5k/153.6k`. **Both sides must change together**: the pinned Hermes value overrides what the server reports. |

**Checked after the change** (engine 0.1.60, IQ3_S, 8-bit KV, KV streaming with 32K on the card, pictures on the CPU):

- `/v1/models` reports `n_ctx: 153600`.
- Graphics memory: 2,252 expert slots (2,272 at 128K, −0.9%), 729 MiB free with everything loaded (727 MiB at 128K).
  The extra context costs almost no VRAM, because only 32K of the KV cache is kept on the card. The rest stays in RAM,
  about 13.7 KB per token (≈ +0.3 GB for the extra 22.5K tokens, from `~/Strata/docs/DETAILS.md`, not measured here).
- RAM: 4.3 GB still available after the test below, with no swap in use.
- A 138,471-token prompt (longer than the old limit) was read cold in 69 s (2,012 tok/s), and a code word hidden in
  its middle was answered correctly.
- A 292K-token prompt was refused cleanly ("requests are never truncated").
- Ready about 1 minute after the restart (model files still in the page cache; a cold start took ~13 min before).

**Not measured:** output speed for calls near the top of the 150K window. The test answered in 9 tokens, too few to
tell.

**To undo:** point `qwenflash-st` back at `qwenflash-st-128k.json` (or restore the backup), restart
`llama-swap.service`, and set Hermes back to `context_length: 131072`.

**Further room, if needed:** 192K (`196608`) would cost about 0.9 GB of RAM instead of 0.3 GB. Past 262,144 needs yarn
rope scaling (experimental), which isn't worth it on this machine. In job 5069 the binding limit was Hermes's
`max_turns` 80, not the context.

## 7. The Coder IQ1_M setup was removed (2026-11-18)

The Coder is no longer used, so the paths for it in sections 3–5 and the "Facts" table no longer exist.

- Deleted: `Strata-data/models/coder-IQ1_M`, `Strata-data/packs/coder-iq1_m`, `Strata-data/coder-st-128k.json` (with
  its `.bak` and engine log), `~/.local/state/strata/launch/iq1_m-128k.*`, `~/.config/strata/profiles/launch-iq1_m-128k.json`
  and its history, and `strata-coder-iq1_m.json(.bak)` and `run-coder-iq1_m.sh` in the checkout. 52 GB freed.
- The Coder's `…IQ1_M-00002-of-00002.gguf` was a **hard link** to IQ3_S's `…IQ3_S-00002-of-00002.gguf` (same file,
  28.8 GB). Only the Coder's name was removed, and IQ3_S's file is intact.
- Kept: `Strata-data/mtp/rt` (the draft head, which `qwenflash-st` also uses), the mmproj files, and
  `data/expert-profile-coder.bin` (tracked in git).
- llama-swap: the `coder-st` entry was removed (the earlier version is in git, before commit `d37fa81`) and the service was
  restarted. `qwenflash-st` came back at `n_ctx: 153600`.
- Left as they are, since they do no harm: the `qwen38-coder-strata` rule in `~/llm-stuff/proxy-models.json` (plus a test in
  `proxy.test.js` that uses the Coder's model name), and a Coder calibration entry in `~/.config/strata/settings.json`.

## 8. Switching engines: `switch-engine.sh`

`~/llm-stuff/switch-engine.sh` (moved here from `~/Strata` on 2026-11-18) points the Strata run configs at another
installed engine. With no arguments it lists the installed engines and the engine each llama-swap profile runs.
`switch-engine.sh 0.1.61` switches the profiles named in `llmserver.yaml`, `--bench` also switches the benchmark
configs `~/Strata/strata-*.json`, and `--dry-run` changes nothing. Install the engine first (`strata update`), and
restart the model in llama-swap afterwards.

## Not yet verified

- A full start of the Coder model with the engine from `engine-feed` (only `--plan` was run after the fix).
- Whether the rewritten run config's `exe` points at the `engine-feed` engine.
- Any part of the llama-swap setup, including model-name routing and health check timing.
- Hermes through Strata on this machine, directly or through llama-swap.
- The speed of the Coder IQ1_M model on this RTX 4070, and the effect of the VRAM options in step 3.
