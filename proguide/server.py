from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


LOCAL_URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1):\d+[^\s]*")


def is_url_ready(url: str, timeout_seconds: float = 2.0) -> bool:
    try:
        request = Request(url, headers={"User-Agent": "proguide-test-e2e"})
        with urlopen(request, timeout=timeout_seconds) as response:
            return response.status < 500
    except (OSError, URLError, ValueError):
        return False


class ServerManager:
    def __init__(
        self,
        *,
        root: Path,
        command: str,
        base_url: str,
        ready_timeout_seconds: int,
        log_path: Path,
    ) -> None:
        self.root = root
        self.command = command
        self.base_url = base_url
        self.ready_timeout_seconds = ready_timeout_seconds
        self.log_path = log_path
        self.process: subprocess.Popen[str] | None = None
        self.resolved_url = base_url
        self._log_thread: threading.Thread | None = None
        self._stop_requested = False

    def start(self) -> str:
        if not self.command:
            raise RuntimeError("No frontend start command was detected or configured.")

        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        self.process = subprocess.Popen(
            self.command,
            cwd=self.root,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            creationflags=creationflags,
        )
        self._log_thread = threading.Thread(target=self._capture_output, daemon=True)
        self._log_thread.start()
        return self.wait_until_ready()

    def wait_until_ready(self) -> str:
        deadline = time.monotonic() + self.ready_timeout_seconds
        while time.monotonic() < deadline:
            if self.process and self.process.poll() is not None:
                raise RuntimeError(f"Frontend server exited early with code {self.process.returncode}. See {self.log_path}.")
            if is_url_ready(self.resolved_url):
                return self.resolved_url
            time.sleep(1)
        raise TimeoutError(f"Frontend server was not ready at {self.resolved_url} after {self.ready_timeout_seconds}s. See {self.log_path}.")

    def stop(self) -> None:
        self._stop_requested = True
        if not self.process or self.process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(self.process.pid)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()

    def __enter__(self) -> "ServerManager":
        self.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.stop()

    def _capture_output(self) -> None:
        if not self.process or not self.process.stdout:
            return
        with self.log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"$ {self.command}\n")
            for line in self.process.stdout:
                log_file.write(line)
                log_file.flush()
                match = LOCAL_URL_RE.search(line)
                if match:
                    self.resolved_url = match.group(0).rstrip("/")
                if self._stop_requested:
                    break
