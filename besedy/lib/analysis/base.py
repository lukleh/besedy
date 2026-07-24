"""Base classes for analysis dataclasses."""

from __future__ import annotations


class TimeSpanMixin:
    """Mixin providing duration property for classes with start/end attributes.

    This mixin should be listed first in inheritance to work with dataclasses:

        @dataclass
        class MySegment(TimeSpanMixin):
            start: float
            end: float

    The duration property returns max(0.0, end - start) to handle edge cases
    where end < start due to floating-point errors.
    """

    start: float
    end: float

    @property
    def duration(self) -> float:
        """Duration in seconds (always non-negative)."""
        return max(0.0, self.end - self.start)
