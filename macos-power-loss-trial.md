# Power-loss recovery trial (mac-m1)

## Largely answered without running it (2026-09-03)

A routine reboot showed what this trial was designed to find out, so the risky
part is probably unnecessary. With FileVault on, `/System/Volumes/Data` comes
up **locked** after any reboot, and the daemons live on it, so nothing starts
until a human supplies a password — over SSH, via macOS's remote unlock:

```
This system is locked. To unlock it, use a local
account name and password.
```

That is **state B** in the table below — powered on, volume locked, waiting for
a human — and it will be the power-cut outcome too, since a power cut gives
macOS strictly less opportunity to carry an unlock forward than a clean restart
does. `sudo fdesetup authrestart` covers planned reboots only.

**So: with FileVault on, power-loss recovery is not unattended.** The remaining
question is only whether `pmset autorestart 1` powers the machine back on at
all — worth confirming eventually, but it changes nothing about needing a human.

Run the full procedure below only if you turn FileVault **off** and want to
verify that the box then recovers unattended. Keep the rest of this document
for that case, and for the M5.

## The question

**After an unexpected power cut, does the Mac come back to a serving stack with
nobody touching it — with FileVault on?**

`macos-headless-trial.md` proved the daemons start at boot with nobody logged
in. This is the harder half of the same goal, and it is not implied by that
result.

## Why the first trial did not answer this

That trial used `sudo shutdown -r now` — a clean, software-initiated restart
from an authenticated admin session. The box came back in ~2 minutes with the
daemons running, `/dev/console` owned by `root`, `0 users`, and **FileVault
on**. So encryption and unattended restart already coexist here.

But `fdesetup authrestart` exists precisely because a reboot does *not*
normally carry the FileVault unlock forward. Something granted that unlock on a
clean restart. A power cut gives macOS no opportunity to hand anything forward,
so the same outcome cannot be assumed.

Two independent things have to work, and only one of them was exercised:

| | Needed for power-loss recovery | Proven by the first trial |
| --- | --- | :---: |
| The Mac powers itself on when mains returns (`pmset autorestart 1`) | yes | no |
| The Data volume unlocks with no human, so the daemons can start | yes | **not for a cold boot** |

The daemons live on `/System/Volumes/Data`, which is the FileVault-protected
volume. If it does not unlock, they cannot run — and `autorestart 1` will have
delivered you a Mac sitting at an unlock screen, which is no better than off.

## Read the outcome from devbox, not from the Mac

If the Data volume stays locked, SSH is very likely unavailable too — sshd's
host keys and config live under that volume via firmlinks. So "I can't SSH in"
must not be read as "the machine is off". Distinguish three states from
outside:

| State | ping | port 22 | `:8080/health` | Meaning |
| --- | :---: | :---: | :---: | --- |
| **A** | ✗ | ✗ | ✗ | Still powered off — `autorestart` did not fire |
| **B** | ✓ | ✗ | ✗ | Powered on, **volume locked** — waiting for a human |
| **C** | ✓ | ✓ | `OK` | Fully recovered |

Only **C** is a pass. **B** is the interesting failure: everything works except
the thing that matters.

Poll from devbox (PowerShell), leaving it running across the whole test:

```powershell
$ip = "192.168.86.34"
while ($true) {
  $p    = Test-Connection $ip -Count 1 -Quiet -ErrorAction SilentlyContinue
  $ssh  = (Test-NetConnection $ip -Port 22   -WarningAction SilentlyContinue).TcpTestSucceeded
  $http = try { (Invoke-RestMethod "http://${ip}:8080/health" -TimeoutSec 3) } catch { "-" }
  "{0}  ping={1,-5} ssh={2,-5} health={3}" -f (Get-Date -Format HH:mm:ss), $p, $ssh, $http
  Start-Sleep 10
}
```

## Run the cheap test first

**Test B — cold boot from a clean shutdown.** This isolates the unlock question
from the `autorestart` question and carries no corruption risk. If the volume
will not unlock on a cold boot, you have your answer without ever pulling a
plug.

```bash
ssh mac-m1
sudo shutdown -h now          # clean power-off
```

Wait for state **A**, then press the power button. Do not touch keyboard,
mouse, or Screen Sharing afterwards. Watch the poller.

- Reaches **C** → the unlock survives a cold boot. Go on to Test C.
- Stops at **B** → **stop here.** FileVault will not unlock unattended, and no
  power-cut test can change that. Skip to *Reading the result*.

## Test C — the actual power cut

Only if Test B reached **C**.

1. Confirm `pmset -g | grep autorestart` still reports `1`.
2. Note the time. Pull mains power at the wall or the UPS outlet — **not** a
   clean shutdown, and not by holding the power button, which some firmware
   treats differently.
3. Wait ~30 seconds with power off.
4. Restore power. Do not press the power button; `autorestart 1` is what is
   under test. Do not log in.
5. Watch the poller until it reaches **C**, or for 10 minutes.

Record the elapsed time from power-restored to `health=OK`. That is the real
recovery number for the M5, and it includes llama-swap's startup model preload,
not just boot.

### Risk

An unclean cut risks filesystem damage. APFS is resilient and this is a trial
box, so the trade is fine here — but do not treat this as a routine thing to
repeat, and do not run it on the M5 once it holds anything you care about.

## Reading the result

| Outcome | What it means | What to do |
| --- | --- | --- |
| **C**, fast | FileVault + headless daemons + power-loss recovery all coexist | Nothing. This is the target configuration; carry it to the M5 |
| **C**, slow (>5 min) | Works, but recovery is not quick | Fine for a workstation-class box; note the number |
| **B** | The volume needs a human after a cold boot | Real trade-off, below |
| **A** | `autorestart` did not fire | Recheck `pmset -g`; some firmware ignores it after a hard cut. Retest before blaming FileVault |

If the result is **B**, the choice is explicit and there is no clever way out:

| Option | Unattended after power loss | Encrypted at rest |
| --- | :---: | :---: |
| Turn FileVault off | yes | hardware-only — the SSD is still encrypted by the Secure Enclave, but the key is released without a password, so anyone who can boot the machine reads it |
| Keep FileVault on | no — needs a human at the unlock screen | yes |

For a box on your own network doing coding inference, either is defensible.
Decide it deliberately rather than by default, and record the choice in
`macos-setup.md` → **Start at boot**.

## Before running

Install the log rotator first, so the test exercises the final configuration
rather than a subset — mac-m1 currently has 2 of the 3 daemons:

```bash
cd ~/llm-stuff && git pull
sudo llama-swap/macos/daemons/install-daemons.sh
llama-swap/macos/manage.sh status      # expect: mode ── LaunchDaemons in system
```

## Record the outcome

Append the result and the recovery time to `macos-setup.md` → **Start at
boot**, next to the headless-daemon result. The M5 should inherit an answer,
not the question.
