"""A correction pilot can be smaller than one gradient accumulation window."""

import math

import pytest

from training.accumulation import accumulation_windows


@pytest.mark.parametrize(
    ("count", "expected_batches"),
    [(1, [1]), (4, [1]), (12, [3]), (16, [4]), (17, [4, 1]), (33, [4, 4, 1])],
)
def test_every_epoch_updates_on_all_chunks_including_a_partial_window(count, expected_batches):
    rows = list(range(count))
    updates = []
    for _epoch in range(2):
        windows = list(accumulation_windows(rows, batch_size=4, grad_accum=4))
        assert [len(window) for window in windows] == expected_batches
        assert [row for window in windows for batch in window for row in batch] == rows
        updates.extend(windows)
    assert len(updates) == 2 * math.ceil(count / 16)


def test_a_partial_window_averages_its_losses_without_shrinking_the_gradient():
    # Five microbatches: the final one is an optimizer update of its own and
    # must keep its gradient of 5 rather than dividing it by four again.
    gradients = [1.0, 2.0, 3.0, 4.0, 5.0]
    updates = [
        sum(sum(batch) / len(window) for batch in window)
        for window in accumulation_windows(gradients, batch_size=1, grad_accum=4)
    ]
    assert updates == [2.5, 5.0]


@pytest.mark.parametrize(("batch_size", "grad_accum"), [(0, 4), (4, 0), (-1, 4)])
def test_invalid_batching_is_rejected(batch_size, grad_accum):
    with pytest.raises(ValueError, match="must be positive"):
        list(accumulation_windows([1], batch_size, grad_accum))
