# Headless LaunchDaemon trial (mac-m1)

## The question

**Does Metal GPU acceleration still work when `llama-server` is started by a
LaunchDaemon at boot, with nobody logged in at the desktop?**

Everything else about the daemon route is known to work. This one thing is not,
and it decides how the M5 Ultra gets deployed. Run it on mac-m1 — that box
exists to answer questions like this before the real hardware lands.

## Why it matters

LaunchAgents live in the Aqua session, so today a reboot leaves the stack down
until someone logs in (see `macos-setup.md` → **Start at boot**). The two ways
out are automatic login and LaunchDaemons, and they trade off differently:

| Setup | Unattended after power loss | Encrypted at rest | Desktop session always live |
| --- | :---: | :---: | :---: |
| Agents + auto-login, FileVault **off** | yes | no | **yes** |
| Daemons, FileVault **off** | yes | no | no |
| Daemons, FileVault **on** | **no** — pre-boot unlock | yes | no |
| Agents, FileVault on | no | yes | — |

Two things worth being precise about, because they are easy to get backwards:

- **FileVault does not require a desktop login — it requires a pre-boot
  unlock.** Once the volume is unlocked the system boots and daemons start with
  no login. So daemons + FileVault still means a human at the console after
  every unexpected reboot. `sudo fdesetup authrestart` unlocks for exactly one
  subsequent boot, which covers planned reboots but not power loss.
- **Daemons are not a way to keep FileVault and stay unattended.** Their real
  win over auto-login is that no logged-in desktop sits exposed for anyone with
  physical or Screen Sharing access.

If Metal works from a daemon, the M5 can run headless with no desktop session
at all. If it does not, auto-login is the answer and the daemon files here can
be deleted.

## Pre-flight

- SSH access to mac-m1 that does not depend on a desktop session (it does not).
- Physical or Screen Sharing access as a fallback, in case the daemons fail and
  you need to put the agents back.
- Know the current state: `llama-swap/macos/manage.sh status`.

## Step 0 — capture the logged-in baseline (do not skip)

The trial is a comparison. Without a baseline taken **the same way** on the
same box, a "slow" result afterwards proves nothing.

While logged in at the desktop, with the agents running:

```bash
cd ~/llm-stuff

# Unique prompt: --cache-reuse 256 means a repeated prompt returns from prefix
# cache and reports a meaningless prompt-processing rate.
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"qwen25-coder-1.5b\",\"stream\":true,\"max_tokens\":200,
       \"messages\":[{\"role\":\"user\",\"content\":\"[trial $(date +%s)] Write a bash function that retries a command with exponential backoff, and explain each line.\"}]}" \
  > /dev/null

# The numbers that matter: pp tok/s, tg tok/s, and gpu watts.
grep -a '\[done\]' llama-swap/logs/proxy.log | tail -1
```

Also record that llama.cpp actually initialised Metal. Its stdout goes to
llama-swap's in-memory log monitor, not to a file:

```bash
curl -s --max-time 5 http://127.0.0.1:8080/logs/stream/upstream \
  | grep -iE 'metal|offloaded|backend' | head -20
```

Write down, from a **cold model load** (restart llama-swap first if it is
already warm, so the load lines appear):

| Metric | Baseline (logged in) |
| --- | --- |
| `ggml_metal_init: found device` present | |
| layers offloaded to GPU | |
| pp tok/s | |
| tg tok/s | |
| gpu watts during generation | |

Reference points already measured on this box at `-c 32768` (`macos-setup.md`
→ Context sizing): ~281 pp tok/s and ~30 tg tok/s on a 14K-token prompt. A
CPU-only fallback is not a few percent slower — it is dramatically slower, and
GPU watts collapse toward idle. That is the signal.

## Step 1 — install the daemons and stand the agents down

```bash
cd ~/llm-stuff && git pull

# Stop the agents and keep them from coming back at the next login. Without
# this, logging in later starts a second copy that fights for 8080/8081/8082.
llama-swap/macos/manage.sh stop
launchctl disable "gui/$(id -u)/com.khaney.llama-proxy"
launchctl disable "gui/$(id -u)/com.khaney.llama-swap"

sudo llama-swap/macos/daemons/install-daemons.sh
```

The installer substitutes your home and username, installs to
`/Library/LaunchDaemons` as `root:wheel` 644, lints each plist, and
deliberately does **not** load them.

## Step 2 — reboot, and do not log in

```bash
sudo shutdown -r now
```

Leave the Mac at the login window. If FileVault is on you will have to unlock
at the pre-boot screen — that is expected, and is itself part of the finding.

## Step 3 — verify the stack came up with no session

Over SSH:

```bash
stat -f '%Su' /dev/console          # expect: root  (nobody logged in)

launchctl print system/com.khaney.llama-proxy | grep -E 'state|pid|last exit'
launchctl print system/com.khaney.llama-swap  | grep -E 'state|pid|last exit'

lsof -nP -iTCP:8080 -iTCP:8081 -iTCP:8082 -sTCP:LISTEN
curl -s http://127.0.0.1:8080/health
```

If `/dev/console` shows your username, something logged you in and the test is
invalid — log out and check again.

## Step 4 — the actual question

Run the **exact same** request as Step 0 and compare:

```bash
cd ~/llm-stuff
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"qwen25-coder-1.5b\",\"stream\":true,\"max_tokens\":200,
       \"messages\":[{\"role\":\"user\",\"content\":\"[trial $(date +%s)] Write a bash function that retries a command with exponential backoff, and explain each line.\"}]}" \
  > /dev/null

grep -a '\[done\]' llama-swap/logs/proxy.log | tail -1
curl -s --max-time 5 http://127.0.0.1:8080/logs/stream/upstream \
  | grep -iE 'metal|offloaded|backend' | head -20
```

### Reading the result

| Signal | Metal working | Metal not working |
| --- | --- | --- |
| `ggml_metal_init: found device` | present | absent, or an init error |
| layers offloaded | all (`-ngl 999`) | 0 / CPU fallback |
| tg tok/s | within ~10% of baseline | far below baseline |
| gpu watts in `[done]` | same order as baseline | at or near idle |

Judge on the log lines **and** the numbers together. GPU watts alone can
mislead — `power-macos.js` reports Apple GPU power only, which is already small
on this M1 (~2.5W under load).

## If it works

The M5 Ultra ships headless: daemons, no auto-login, no desktop session. Decide
FileVault separately using the table above, knowing a reboot then needs a
pre-boot unlock.

Follow-ups before that becomes the real setup:

- Point `manage.sh` at `system/` instead of `gui/<uid>`, or teach it to detect
  which domain the stack is installed in.
- `sudo pmset -a sleep 0 disablesleep 1` and `sudo pmset -a autorestart 1` so
  the box neither sleeps nor stays dark after a power failure.
- Log rotation. macOS writes plain files via `StandardOutPath` and launchd does
  not rotate them (`macos-setup.md` → Logs). Add a `/etc/newsyslog.d/` entry
  before a box that runs continuously.
- Re-tune context and the model set: `mac-m1.yaml` is built for 8GB and says so.
  96GB changes every sizing decision in it.

## If it does not work

Auto-login is the answer. Roll back:

```bash
sudo llama-swap/macos/daemons/install-daemons.sh --uninstall
launchctl enable "gui/$(id -u)/com.khaney.llama-proxy"
launchctl enable "gui/$(id -u)/com.khaney.llama-swap"
llama-swap/macos/manage.sh start
```

Then enable automatic login (System Settings → Users & Groups), require a
password immediately after screen saver so the exposed desktop is locked, and
apply the same `pmset` settings above.

## Record the outcome

Append the result — pass or fail, with the two `[done]` lines — to
`macos-setup.md` → **Start at boot**. The M5 arrives later and this question
should not have to be asked twice.
