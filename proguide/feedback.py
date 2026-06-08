from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn


console = Console()


@contextmanager
def activity(message: str, done: str | None = None) -> Iterator[None]:
    if not console.is_terminal:
        yield
        return

    progress = Progress(
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(bar_width=34, pulse_style="cyan"),
        TimeElapsedColumn(),
        console=console,
        refresh_per_second=8,
        transient=True,
    )
    with progress:
        progress.add_task(message, total=None)
        yield

    if done:
        console.print(f"[green]OK[/green] {done}")
