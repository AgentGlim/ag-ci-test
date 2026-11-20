#!/usr/bin/env python3
"""Transactional checks for owner-run Linux harness installers."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone

HERE = Path(__file__).resolve()
LAUNCH_PATH = re.compile(
    r"(?:agent\.sh|worker(?:-launch)?[.-].*|.*(?:launch|listener|heartbeat|spawn-guard|"
    r"tracked-(?:job|work)|disk-guard|auditq-wait|watcher-bridge|superagent-wake|headless-take|api-take).*|"
    r"jev-.*|jobs-track.*|run-mode.*|dispatch.*|budget\.mjs|driver\.mjs|settings(?:\.local)?\.json|config\.toml)$", re.I
)
SMOKE_SOURCES = (
    "plans/_run/bin/agent.sh", "plans/_run/bin/job-scratch.sh",
    "plans/_run/bin/harness-config.mjs", "plans/_run/bin/jev-guard-core.mjs",
    "plans/_run/bin/jev-override.mjs", "plans/_run/bin/model-cooldown.mjs",
    "plans/_run/bin/free-models.mjs", "plans/_run/bin/worker-launch.sh",
    "plans/_run/bin/worker-launch.mjs", "plans/_run/bin/auditq-wait.sh",
    "plans/_run/bin/auditq-wait.mjs", "plans/_run/bin/auditq-triage.mjs",
    "app/harness/bin/auditq-wait.mjs", "app/harness/bin/auditq-triage.mjs",
    "app/harness/jev-routes.json", "app/app/run-mode.mjs",
    "app/app/settings.mjs", "app/app/settings.defaults.json", "app/app/paths.mjs",
    "app/harness/bin/worker-launch.mjs", "app/app/cli-spawn.mjs",
)


class CheckError(Exception):
    pass


def fingerprint(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        kind = "link"
        digest = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
    elif stat.S_ISREG(info.st_mode):
        kind = "file"
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    else:
        raise CheckError(f"expected a regular file or symlink at {path}")
    return dict(kind=kind, sha256=digest, mode=stat.S_IMODE(info.st_mode),
                uid=info.st_uid, gid=info.st_gid)


def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-a", "--", source, destination], check=True)


def save(path, data):
    # Keep the old receipt usable if an atomic update fails.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".postcheck-",
                                     delete=False) as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(stream.name, path)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def commands(kit):
    declaration = kit / "tests/POSTCHECK"
    if declaration.exists():
        lines = declaration.read_text().splitlines()
    else:
        result = kit / "RESULT.md"
        content = result.read_text() if result.is_file() else ""
        heading = re.search(r"(?im)^(#{1,6})[ \t]+Post-install tests[ \t]*$", content)
        if not heading:
            raise CheckError("declare tests in tests/POSTCHECK or RESULT.md")
        level = len(heading[1])
        fence = 0
        shell = False
        lines = []
        for line in content[heading.end():].splitlines():
            marker = re.fullmatch(r"(`{3,})(.*)", line)
            if fence:
                if marker and len(marker[1]) >= fence and not marker[2].strip():
                    fence = 0
                elif shell:
                    lines.append(line)
            elif marker:
                fence = len(marker[1])
                shell = marker[2].strip() in ("bash", "sh", "shell")
            elif re.match(rf"^#{{1,{level}}}[ \t]+", line):
                break
        if fence:
            raise CheckError("unclosed fenced block in Post-install tests")
    tests = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]
    if not tests:
        raise CheckError("postcheck declaration contains no commands")
    return tests


def supervise_hook(timeout, label, argv):
    """Run as private PID 1; no hook descendant may survive this boundary."""
    if os.getpid() != 1:
        raise CheckError("hook supervisor requires a private PID namespace")

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            print(f"{label} timed out after {timeout:g} seconds", file=sys.stderr, flush=True)
            return 124
        except KeyboardInterrupt:
            return 130
    finally:
        # PID namespaces scope this signal to our own descendants, even after
        # setsid/double-fork. Reap every child before bwrap reports completion.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            os.kill(-1, signal.SIGKILL)
        except ProcessLookupError:
            pass  # The hook may have exited without leaving descendants.
        while True:
            try:
                os.waitpid(-1, 0)
            except InterruptedError:
                continue
            except ChildProcessError:
                break


def run(argv, cwd, env, log, timeout, label, supervise=False):
    if supervise:
        argv = ["bwrap", "--die-with-parent", "--unshare-pid", "--as-pid-1",
                "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc",
                "--", sys.executable, "-B", str(HERE),
                "--hook-supervisor", str(timeout), label, *argv]
    with log.open("ab") as stream:
        stream.write(f"\n--- {label} ---\n".encode())
        stream.flush()
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=stream, stderr=stream, start_new_session=True)
        try:
            # The supervisor owns the hook deadline. Keep the install lock
            # until it has reaped every descendant, even if cleanup is slow.
            code = process.wait(timeout=None if supervise else timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            if supervise:
                # Do not kill bwrap's monitor ahead of its namespace reaper.
                # On Ctrl-C, wait for the hook deadline and cleanup barrier.
                previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
                try:
                    process.wait()
                finally:
                    signal.signal(signal.SIGINT, previous)
            else:
                # Declared checks also run in a private PID namespace.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            reason = "interrupted" if isinstance(error, KeyboardInterrupt) else f"timed out after {timeout:g} seconds"
            raise CheckError(f"{label} {reason}") from error
        if supervise and code == 124:
            raise CheckError(f"{label} timed out after {timeout:g} seconds")
        if code:
            raise CheckError(f"{label} exited {code}")


class Kit:
    def __init__(self, args):
        self.kit = args.kit.resolve(strict=True)
        self.roots = dict(plans=args.plans_root.resolve(strict=True), app=args.app_root.resolve(),
                          home=args.home_root.resolve(strict=True))
        self.timeout = args.timeout
        self.attempt = None
        self.history = self.kit / "_archive"
        self.pointer = self.kit / ".postcheck-active"

    def configure(self):
        spec = json.loads((self.kit / "POSTCHECK.json").read_text())
        if not isinstance(spec, dict) or not isinstance(spec.get("launch", False), bool):
            raise CheckError("POSTCHECK.json must be an object with an optional boolean launch flag")
        self.files = self.paths(spec.get("files"))
        if not self.files:
            raise CheckError("POSTCHECK.json files must contain every install target")
        self.inputs = self.paths(spec.get("inputs", []))
        self.tests = commands(self.kit)
        self.launch = bool(spec.get("launch")) or any(LAUNCH_PATH.fullmatch(Path(key).name) for key in self.files)

    def target(self, key):
        root, _, rel = key.partition("/")
        if root not in self.roots or not rel or any(part in ("", ".", "..") for part in rel.split("/")):
            raise CheckError(f"invalid source path {key!r}")
        base = self.roots[root]
        path = base / rel
        if path.parent.resolve() != path.parent:
            raise CheckError(f"symlinked source parent: {key}")
        return path

    def paths(self, keys):
        if not isinstance(keys, list) or any(not isinstance(key, str) for key in keys):
            raise CheckError("POSTCHECK.json files and inputs must be arrays of paths")
        paths = {key: self.target(key) for key in keys}
        if len(set(paths.values())) != len(keys):
            raise CheckError("POSTCHECK.json contains duplicate paths")
        return paths

    def capture(self, files):
        return {key: fingerprint(self.target(key)) for key in files}

    def assert_matches(self, expected, reason):
        actual = self.capture(expected)
        changed = [key for key in expected if expected[key] != actual[key]]
        if changed:
            raise CheckError(f"{reason}: {', '.join(changed)}")

    def update(self, status, **fields):
        self.receipt.update(fields, status=status)
        save(self.attempt / "receipt.json", json.dumps(self.receipt, indent=2) + "\n")

    def start(self):
        folder = self.history / f"{date.today():%Y%m%d}-postcheck"
        if folder.resolve() != folder:
            raise CheckError("postcheck archive must be inside the kit")
        folder.mkdir(parents=True, exist_ok=True)
        self.attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=folder))
        self.log = self.attempt / "checks.log"
        self.receipt = {"roots": {key: str(value) for key, value in self.roots.items()},
                        "before": self.capture(self.files), "tests": self.tests, "launch": self.launch}
        self.update("preparing")

    def open_receipt(self, path):
        path = Path(path).resolve(strict=True)
        if not path.is_relative_to(self.history) or path.name != "receipt.json":
            raise CheckError("receipt must be inside this kit's postcheck archive")
        receipt = json.loads(path.read_text())
        if receipt["roots"] != {key: str(value) for key, value in self.roots.items()}:
            raise CheckError("receipt belongs to a different deployment")
        self.attempt, self.receipt, self.log = path.parent, receipt, path.parent / "checks.log"

    def active(self):
        if not self.pointer.exists():
            return False
        self.open_receipt(self.pointer.read_text().strip())
        return True

    def preflight(self):
        self.start()
        mounts = {}
        resolved_links = {}
        inputs = self.files | self.inputs
        if self.launch:
            inputs.update({key: self.target(key) for key in SMOKE_SOURCES})
        expected = self.capture(inputs)
        for key, path in inputs.items():
            state = expected[key]
            if state is None:
                continue
            backup = self.attempt / "before" / key
            copy(path, backup)
            if fingerprint(backup) != state:
                raise CheckError(f"copy changed while capturing {key}")
            if state["kind"] == "file":
                mounts[path] = backup
                continue
            # Preserve the link in the receipt. Bind a copy over its regular-file referent for tests.
            referent = path.resolve()
            resolved_links[path] = referent
            if referent.is_file() and referent not in mounts:
                backup = self.attempt / "referents" / str(referent).lstrip("/")
                state = fingerprint(referent)
                copy(referent, backup)
                if fingerprint(backup) != state or fingerprint(referent) != state:
                    raise CheckError(f"referent changed while copying {key}")
                mounts[referent] = backup
        self.assert_matches(self.receipt["before"], "targets changed while preparing")
        self.run_checks("pre", mounts)
        self.assert_matches(expected, "inputs changed during precheck")
        for link, referent in resolved_links.items():
            if link.resolve() != referent:
                raise CheckError(f"input symlink referent changed during precheck: {link}")
        for path, backup in mounts.items():
            if fingerprint(backup) != fingerprint(path):
                raise CheckError(f"input referent changed during precheck: {path}")
        self.update("prepared")

    def environment(self, work, phase):
        return {
            "PATH": os.environ.get("PATH", os.defpath), "HOME": str(work / "home"),
            "LANG": "C.UTF-8", "TMPDIR": str(work / "tmp"), "PYTHONDONTWRITEBYTECODE": "1",
            "POSTCHECK_ROOT": str(self.roots["plans"]), "POSTCHECK_APP": str(self.roots["app"]),
            "POSTCHECK_HOME_ROOT": str(self.roots["home"]), "POSTCHECK_KIT": str(self.kit),
            "POSTCHECK_WORK": str(work), "POSTCHECK_PHASE": phase,
        }

    def run_checks(self, phase, mounts=None):
        work = self.attempt / phase
        for folder in ("home", "tmp"):
            (work / folder).mkdir(parents=True, exist_ok=True)
        script = work / "checks.sh"
        lines = ["set -eo pipefail"]
        for i, command in enumerate(self.receipt["tests"], 1):
            label = f"declared check {i}"
            lines += [f"printf '%s\\n' {shlex.quote(label)} > \"$POSTCHECK_WORK/current-check\"",
                      f"printf '%s\\n' {shlex.quote(label)}",
                      f"/bin/bash -e -o pipefail -c {shlex.quote(command)}"]
        if self.receipt["launch"]:
            lines += ['printf "%s\\n" "launch smoke" > "$POSTCHECK_WORK/current-check"',
                      f"{shlex.quote(sys.executable)} -B {shlex.quote(str(HERE))} --smoke"]
        script.write_text("\n".join(lines) + "\n")
        box = ["bwrap", "--die-with-parent", "--unshare-net", "--unshare-pid", "--unshare-ipc",
               "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
               "--tmpfs", "/run", "--bind", str(work), str(work)]
        for path, backup in (mounts or {}).items():
            box += ["--ro-bind", str(backup), str(path)]
        try:
            run([*box, "--", "/bin/bash", str(script)], self.roots["plans"], self.environment(work, phase),
                self.log, self.timeout, f"{phase} checks")
        except CheckError as error:
            marker = work / "current-check"
            if marker.is_file():
                raise CheckError(f"{error} ({marker.read_text().strip()[:80]})") from error
            raise

    def hook(self, name):
        env = dict(os.environ, POSTCHECK_RECEIPT=str(self.attempt / "receipt.json"),
                   POSTCHECK_ROOT=str(self.roots["plans"]), POSTCHECK_APP=str(self.roots["app"]),
                   POSTCHECK_HOME_ROOT=str(self.roots["home"]), POSTCHECK_KIT=str(self.kit))
        run([str(self.kit / name)], self.kit, env, self.log, self.timeout, name, supervise=True)

    def install(self):
        if self.active():
            status = self.receipt["status"]
            if status == "passed":
                self.assert_matches(self.receipt["after"], "installed targets changed since passing")
                print(f"kit-postcheck: already installed ({self.attempt})")
                return
            if status != "restored":
                raise CheckError(f"prior installation needs recovery from {self.attempt}")
        for hook in ("apply.sh", "rollback.sh"):
            if not (self.kit / hook).is_file() or not os.access(self.kit / hook, os.X_OK):
                raise CheckError(f"missing executable {hook}")
        try:
            self.preflight()
            self.assert_matches(self.receipt["before"], "install targets drifted after precheck")
        except (OSError, CheckError, subprocess.SubprocessError) as error:
            raise CheckError(f"precheck stopped before installation: {error}; evidence: {self.attempt}") from error
        self.update("applying")
        save(self.pointer, str(self.attempt / "receipt.json") + "\n")
        try:
            self.hook("apply.sh")
            self.update("applied", after=self.capture(self.receipt["before"]))
        except (OSError, CheckError, subprocess.SubprocessError) as error:
            self.fail(error)
        self.postcheck()

    def postcheck(self):
        if self.receipt["status"] == "passed":
            self.assert_matches(self.receipt["after"], "installed targets changed since passing")
            print(f"kit-postcheck: already passed ({self.attempt})")
            return
        if self.receipt["status"] != "applied":
            raise CheckError("there is no prepared installation to check")
        try:
            self.assert_matches(self.receipt["after"], "installed targets changed before postcheck")
            self.run_checks("post")
            self.assert_matches(self.receipt["after"], "installed targets changed during postcheck")
            self.update("passed")
        except (OSError, CheckError, subprocess.SubprocessError) as error:
            self.fail(error)
        print(f"kit-postcheck: passed ({self.attempt})")

    def rollback(self):
        if self.receipt["status"] == "restored":
            self.assert_matches(self.receipt["before"], "restored targets changed")
            return
        if self.receipt["status"] not in ("applying", "applied", "passed", "rollback_failed", "restoring"):
            raise CheckError("no applied kit to roll back")
        after = self.receipt.get("after")
        if after is None:
            try:
                after = self.capture(self.receipt["before"])
            except (OSError, CheckError) as error:
                # A custom rollback may be able to recover even from unrecordable outputs.
                with self.log.open("a") as stream:
                    stream.write(f"Could not record failed-install outputs: {error}\n")
        self.update("restoring", after=after)
        try:
            self.hook("rollback.sh")
            self.assert_matches(self.receipt["before"], "rollback hash or metadata mismatch")
        except (OSError, CheckError, subprocess.SubprocessError):
            self.update("rollback_failed")
            raise
        self.update("restored")

    def fail(self, error):
        try:
            self.rollback()
            outcome = "Rollback restored all recorded hashes and metadata."
        except (OSError, CheckError, subprocess.SubprocessError) as rollback_error:
            outcome = f"Rollback could not be verified. {rollback_error}"
        report = (f"# Post-install check failed\n\n{error}.\n\n{outcome}\n\n"
                  f"Receipt and log: {self.attempt}\n")
        save(self.attempt / "POSTCHECK-FAIL.md", report)
        save(self.kit / "POSTCHECK-FAIL.md", report)
        self.notify(f"{self.kit.name}: {error}. {outcome} See {self.kit / 'POSTCHECK-FAIL.md'}")
        raise CheckError(f"{error}. {outcome}") from error

    def notify(self, message):
        notifier = shutil.which("agent-notify")
        if not notifier or os.environ.get("AGENT_NOTIFY_DISABLE") == "1":
            with self.log.open("a") as stream:
                stream.write("agent-notify is unavailable or disabled\n")
            return
        try:
            with (self.attempt / "alert-attempted").open("x"):
                pass
        except FileExistsError:
            return
        try:
            run([notifier, "--force", "--event", "blocked", "--", message], self.kit, os.environ,
                self.log, min(15, self.timeout), "owner notification")
        except (OSError, CheckError) as error:
            print(f"kit-postcheck: {error}", file=sys.stderr)

    def restore_files(self):
        """Optional rollback implementation for file-only kits."""
        if self.receipt["status"] != "restoring":
            raise CheckError("--restore-files is only for the rollback.sh hook")
        after = self.receipt["after"]
        if after is None:
            raise CheckError("file rollback requires fingerprints of the installed targets")
        before = self.receipt["before"]
        pending = {}
        for key, state in before.items():
            path = self.target(key)
            actual = fingerprint(path)
            if actual == state:
                continue
            if actual != after[key]:
                raise CheckError(f"rollback would overwrite an unrelated change: {key}")
            backup = self.attempt / "before" / key
            if state is not None and fingerprint(backup) != state:
                raise CheckError(f"rollback archive hash mismatch: {key}")
            pending[key] = (path, backup, state)
        for key, (path, backup, state) in pending.items():
            if fingerprint(path) != after[key]:
                raise CheckError(f"target changed during rollback: {key}")
            archived = self.attempt / "installed" / key
            archived.parent.mkdir(parents=True, exist_ok=True)
            if state is None:
                subprocess.run(["mv", "-T", "--", path, archived], check=True)
                sync_directory(archived.parent)
            else:
                if after[key] is not None and not os.path.lexists(archived):
                    copy(path, archived)
                temp = path.with_name(f".{path.name}.postcheck-restore-{self.attempt.name}")
                if not os.path.lexists(temp):
                    copy(backup, temp)
                if fingerprint(temp) != state:
                    raise CheckError(f"rollback staging hash mismatch: {key}")
                os.replace(temp, path)
            sync_directory(path.parent)


def smoke():
    root = Path(os.environ["POSTCHECK_ROOT"])
    work = Path(os.environ["POSTCHECK_WORK"])
    run_dir = root / "_run"
    isolated = work / "listener"
    for name in ("audit_queue", "status_ask", "flags"):
        (isolated / name).mkdir(parents=True)
    prompt = work / "smoke-prompt.md"
    plan = "SuperAgent"
    prompt.write_text(f"Postcheck dry run.\n\n[plan: {plan}]\n[jev: codex-sol high]\n")
    gate = work / "smoke-gate.ndjson"
    gate.write_text(json.dumps({"t": datetime.now(timezone.utc).isoformat(), "src": "check",
                                "decision": "route", "jev": {"pick": "codex-sol", "effort": "high"}}) + "\n")
    env = dict(os.environ, AGENT_SH_GUARD_ONLY="1", JEV_PLANS_ROOT=str(root),
               JEV_GATE_LOG=str(gate), JEV_GUARD_LOG=str(work / "jev-guard.jsonl"),
               JEV_GUARD_ERR_LOG=str(work / "jev-errors.log"), JEV_OVERRIDE_LOG=str(work / "jev-overrides.ndjson"))
    missing_cli = work / "no-provider-binary"
    env["AGENTGLIM_CODEX_BIN"] = str(missing_cli)
    args = [root, prompt, work / "agent", "5", "high", "--plan", plan]
    marker = work / "current-check"
    marker.write_text("agent.sh guard dry run\n")
    print("Smoke: agent.sh guard dry run", flush=True)
    agent = subprocess.check_output(["bash", run_dir / "bin/agent.sh", "codex-only", *args], env=env, text=True)
    print(agent, end="")
    if f"agent.sh: guard ok (plan {plan})" not in agent or (work / "agent/rc").exists():
        raise CheckError("agent.sh did not complete the guard-only path")
    marker.write_text("worker-launch dry run\n")
    print("Smoke: worker-launch --dry-run", flush=True)
    args[2] = work / "worker"
    args[-1] = "00-postcheck-smoke"
    worker = subprocess.check_output(["bash", run_dir / "bin/worker-launch.sh", "codex", *args, "--dry-run"],
                                     env=env, text=True)
    print(worker, end="")
    dry_run = json.loads(worker)
    if (dry_run.get("dryRun") is not True or dry_run.get("refused") or
            not dry_run.get("cmd") or dry_run["cmd"][0] != str(missing_cli) or args[2].exists()):
        raise CheckError("worker-launch did not complete its dry-run path")
    marker.write_text("listener heartbeat and status wake\n")
    print("Smoke: listener heartbeat and status wake", flush=True)
    wake = isolated / "status_ask/kit-postcheck-smoke.json"
    wake.write_text("{}\n")
    (isolated / "config.json").write_text('{"listener":{"settleSec":0}}\n')
    env = dict(os.environ, AGENTGLIM_RUN=str(isolated), AGENTGLIM_PLANS=str(root),
               AGENTGLIM_DATA=str(work / "data"), JOBS_TRACK_DIR=str(work / "tracked-jobs"),
               AGENTGLIM_WAIT_ROUNDS="1",
               AGENTGLIM_WAIT_POLL="0")
    started = time.time()
    output = subprocess.check_output(["bash", run_dir / "bin/auditq-wait.sh"], env=env, text=True)
    print(output, end="")
    if not re.search(r"(?m)^STATUS:.*kit-postcheck-smoke\.json", output):
        raise CheckError("listener did not surface the isolated status request")
    for marker in ("audit_queue/.alive", "heartbeats/auditq-wait"):
        if (isolated / marker).stat().st_mtime < started - 1:
            raise CheckError(f"listener did not refresh {marker}")


def main():
    if sys.argv[1:2] == ["--hook-supervisor"]:
        sys.exit(supervise_hook(int(sys.argv[2]), sys.argv[3], sys.argv[4:]))
    if sys.argv[1:] == ["--smoke"]:
        smoke()
        return
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--install", action="store_true", help="check, apply, then check installed files")
    operation.add_argument("--pre", action="store_true", help="check current files without applying the kit")
    operation.add_argument("--rollback", action="store_true", help="roll back the active installation")
    operation.add_argument("--restore-files", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("kit", type=Path)
    parser.add_argument("--plans-root", type=Path,
                        default=os.environ.get("POSTCHECK_ROOT", Path.home() / "dev/projects/plans"))
    parser.add_argument("--app-root", type=Path, default=os.environ.get("POSTCHECK_APP"))
    parser.add_argument("--home-root", type=Path,
                        default=os.environ.get("POSTCHECK_HOME_ROOT", Path.home()))
    parser.add_argument("--timeout", type=int, default=600, help="deadline in seconds per phase or hook")
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    if args.app_root is None:
        args.app_root = args.plans_root.resolve().with_name("agentglim")
    kit = Kit(args)
    if args.restore_files:
        receipt = os.environ.get("POSTCHECK_RECEIPT")
        if not receipt:
            raise CheckError("--restore-files requires the active rollback receipt")
        kit.open_receipt(receipt)
        kit.restore_files()
    elif args.pre:
        kit.configure()
        try:
            kit.preflight()
        except (OSError, CheckError, subprocess.SubprocessError) as error:
            raise CheckError(f"precheck stopped before installation: {error}; evidence: {kit.attempt}") from error
        print(f"kit-postcheck: precheck passed ({kit.attempt})")
    else:
        fd = os.open(kit.roots["plans"], os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.install:
                kit.configure()
                kit.install()
            elif not kit.active():
                raise CheckError("no active installation receipt")
            elif args.rollback:
                kit.rollback()
                print(f"kit-postcheck: rollback verified ({kit.attempt})")
            else:
                kit.postcheck()
        except BlockingIOError as error:
            raise CheckError("another kit installation or rollback holds the plans lock") from error
        finally:
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, CheckError, subprocess.SubprocessError) as error:
        print(f"kit-postcheck: {error}", file=sys.stderr)
        sys.exit(1)
