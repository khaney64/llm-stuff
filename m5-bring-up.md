# M5 Ultra bring-up

Written 2026-09-03, while waiting on the hardware. mac-m1 (8GB, Mac mini) was
used to answer as much as possible in advance; this collects what it settled,
what it could not, and the order to do things in. Detail lives in the documents
linked from each section — this exists so none of it has to be rediscovered.

The M5 is a 96GB Ultra intended to do most real coding inference, **headless**.
How far "comes back on its own" can go depends on one decision — see FileVault
below; with it on, a reboot needs a password over SSH before anything starts.

## Settled — carry these over, do not re-litigate

| Decision | Evidence |
| --- | --- |
| **LaunchDaemons, not LaunchAgents + auto-login.** Starts at boot with nobody logged in, and leaves no desktop session exposed. | `macos-headless-trial.md` — verified on mac-m1 with `/dev/console` owned by `root` and `0 users` |
| **Metal works from a pre-login daemon.** This was the open risk; it is not real. | tg 53.1 vs 53.7 tok/s logged-in, GPU watts in the same band — a CPU fallback would have collapsed them |
| **FileVault is a real trade, not a free win.** With it on, *no* reboot is unattended — the Data volume comes up locked and the daemons live on it. macOS unlocks it over SSH, so recovery needs a password but not physical access. | observed directly: `This system is locked... System successfully unlocked.` See `macos-setup.md` → *FileVault gates every reboot* |
| **llama.cpp, not MLX.** | `m1-discovery-plan.md` §4 — see *The MLX question* below |
| **Log rotation must copy-and-truncate, never rename.** | `llama-swap/macos/rotate-logs.sh` — launchd holds fd 1/2 open, so `newsyslog` would silently write into the archive |
| **`manage.sh` auto-detects its launchd domain** from `/Library/LaunchDaemons`, and system-domain mutations need `sudo`. | verified: `bootout system/...` as a normal user gives `1: Operation not permitted` |

## Not settled — must be redone on the M5

- **Decide FileVault before anything else — it is the one real trade.**
  With it on, every reboot needs a password over SSH before the stack starts;
  `pmset autorestart 1` gets the machine powered on and no further. With it off
  the box recovers unattended, but the volume key is released without a
  password, so anyone who can boot the machine reads the disk. There is no
  third option: `fdesetup authrestart` covers planned reboots only.
  For a box doing coding inference on your own network, either is defensible —
  decide it deliberately. `macos-power-loss-trial.md` is only worth running if
  you choose FileVault **off** and want to confirm unattended recovery.
- **Metal-from-daemon on a newer macOS.** Verified once, on one OS version.
  Re-run the headless trial after bring-up and after major OS updates; it is a
  20-minute job now that the plists and procedure exist.
- **`mac-m5.yaml`.** `mac-m1.yaml` says in its own header that it is a
  pipeline-validation node holding one tiny model at a time. **None of its
  sizing carries.** Expect a new config and a new model set; `server.sh`'s
  per-model block is where context/batch/offload settings live.
- **Every performance number.** The M1's figures are meaningless in absolute
  terms by that document's own framing. Only the *shape* of findings carries.

## Bring-up order

`macos-setup.md` is the full runbook. The order that matters:

1. `llama-swap/macos/install.sh` — pinned llama-swap binary, checksum-verified.
2. Create `influxdb-env.sh` (gitignored) with the `INFLUXDB_*` exports.
3. Build llama.cpp with Metal; populate `~/llama/models`; write `mac-m5.yaml`
   and the matching `server.sh` model block.
4. `sudo llama-swap/macos/daemons/install-daemons.sh`, then reboot **without
   logging in at the desktop** and confirm the stack comes up — that is the
   headless trial, and doing it before the box matters is free. With FileVault
   on you will have to unlock over SSH first; that is expected and does not
   invalidate the test, which is about the *desktop* session, not the volume.
5. `sudo pmset -a sleep 0` and `autorestart 1`. Check `pmset -g cap` first:
   `disablesleep` is not supported on all hardware, and was not on the M1.
6. Optional: the narrow sudoers rule so `restart-proxy`/`restart-swap` skip the
   password prompt. `kickstart` only, named labels only — **never** `bootstrap`,
   which takes an arbitrary plist path and is root escalation.
7. Confirm the log rotator daemon is installed and sized for the disk
   (`MAX_BYTES`/`KEEP` come from its plist).

## The MLX question

Tested and rejected for now, on evidence rather than assumption. On mac-m1 with
the same weights, warm:

| | tg tok/s | gpu avg | notes |
| --- | ---: | ---: | --- |
| llama.cpp | **52.9** | 7.7W | |
| MLX | 50.1 | **4.4W** | ~40% better energy per token |

MLX was **slower**, not faster — the opposite of the usual assumption. The
power win is real but small in absolute terms at this scale. Against it: no
GGUF reuse (every model is a second download), a Python venv instead of a
binary, a much smaller model catalog, and no `timings` in its responses, which
makes its metrics second-class.

The plumbing is kept and working (`server-mlx.sh`, a `mac-m1.yaml` entry, and
the proxy's wall-clock fallback), so re-testing on the M5 is a short job if the
answer ever looks like changing — at real model sizes, or if Ultra-scale
wattage makes 40% worth having. Do not assume the M1 result holds; large models
and long contexts stress backends very differently.

## Gotchas that will recur

- **`Bootstrap failed: 125: Domain does not support specified action`** means
  nobody is logged in at the desktop and you are targeting `gui/<uid>`. Check
  `stat -f '%Su' /dev/console` — `root` is the login window. Not an error to
  debug; it is the reason daemons exist.
- **`newsyslog` will look like it works and silently lose logs.** It renames;
  launchd keeps writing to the renamed file.
- **Homebrew is not on launchd's PATH.** The plists set it explicitly because
  `node` and `macmon` live there and `power-macos.js` resolves `macmon` by bare
  name.
- **If MLX is ever revisited:** `mlx-lm` resolves the *request's* model field,
  not just its `--model`, and anything it does not recognise becomes a Hugging
  Face download attempt. The model directory name must equal the llama-swap
  model id.
- **Do not benchmark a Mac in the first ~20 minutes after a boot.** Spotlight
  reindexing cost 6.5% of throughput and looked like a real regression until
  the box went idle.
- **After a reboot with FileVault on, the first `ssh` times out**, and the
  second answers with `This system is locked`. That is the unlock service, not
  a network fault — give a password, let the connection close, then reconnect
  normally.
