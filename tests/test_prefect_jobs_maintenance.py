from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("prefect", reason="requires the optional jobs extra")

from prefect.client.schemas.filters import FlowRunFilter  # noqa: E402
from prefect.client.schemas.objects import StateType  # noqa: E402

from besedy.lib.prefect_jobs import maintenance  # noqa: E402


@dataclass
class FakeDeployment:
    id: UUID


@dataclass
class FakeFlowRun:
    id: UUID
    state_name: str
    name: str


class FakeClient:
    def __init__(self, runs: list[FakeFlowRun] | None = None) -> None:
        self.deployment = FakeDeployment(uuid4())
        self.runs = runs or []
        self.deployment_name: str | None = None
        self.read_kwargs: dict[str, object] = {}

    def read_deployment_by_name(self, name: str) -> FakeDeployment:
        self.deployment_name = name
        return self.deployment

    def read_flow_runs(self, **kwargs: object) -> list[FakeFlowRun]:
        self.read_kwargs = kwargs
        return self.runs


def test_read_active_deployment_runs_scopes_deployment_and_active_states() -> None:
    client = FakeClient()

    assert (
        maintenance.read_active_deployment_runs(
            client,
            deployment_name="deep_search_flow/deep-search-prod",
        )
        == []
    )

    assert client.deployment_name == "deep_search_flow/deep-search-prod"
    flow_run_filter = client.read_kwargs["flow_run_filter"]
    assert isinstance(flow_run_filter, FlowRunFilter)
    assert flow_run_filter.deployment_id is not None
    assert flow_run_filter.state is not None
    assert flow_run_filter.state.type is not None
    assert flow_run_filter.deployment_id.any_ == [client.deployment.id]
    assert flow_run_filter.state.type.any_ == [
        StateType.SCHEDULED,
        StateType.PENDING,
        StateType.RUNNING,
        StateType.PAUSED,
        StateType.CANCELLING,
    ]
    assert client.read_kwargs["limit"] == 20


def test_check_idle_refuses_maintenance_when_a_run_is_active(monkeypatch, capsys) -> None:
    run = FakeFlowRun(uuid4(), "Running", "deep-search-test")
    client = FakeClient([run])
    monkeypatch.setattr(maintenance, "get_client", lambda **_: nullcontext(client))

    assert maintenance.check_idle(deployment_name="deep_search_flow/deep-search-prod") == 1
    output = capsys.readouterr().out
    assert str(run.id) in output
    assert "Wait for these runs to finish or cancel them explicitly" in output


def test_check_idle_allows_maintenance_when_deployment_is_idle(monkeypatch, capsys) -> None:
    client = FakeClient()
    monkeypatch.setattr(maintenance, "get_client", lambda **_: nullcontext(client))

    assert maintenance.check_idle(deployment_name="deep_search_flow/deep-search-prod") == 0
    assert "deployment is idle" in capsys.readouterr().out
