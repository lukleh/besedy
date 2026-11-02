"""Microbatches grouped into complete optimizer updates, including the tail."""

from collections.abc import Iterator, Sequence
from typing import TypeVar

T = TypeVar("T")


def accumulation_windows(
    rows: Sequence[T], batch_size: int, grad_accum: int
) -> Iterator[list[Sequence[T]]]:
    """Yield each update's microbatches; average their losses by the window size.

    Each epoch ends with an update even when fewer than ``grad_accum`` batches
    remain. No gradients need to carry across epochs, and the last update has
    the same loss scale as a full one.
    """
    if batch_size <= 0 or grad_accum <= 0:
        raise ValueError("batch_size and grad_accum must be positive")
    window_size = batch_size * grad_accum
    for start in range(0, len(rows), window_size):
        end = min(start + window_size, len(rows))
        yield [rows[i : min(i + batch_size, end)] for i in range(start, end, batch_size)]
