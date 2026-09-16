from typing import Annotated

from fastapi import APIRouter, Header, Query

from platform_app.contracts.base import Envelope
from platform_app.modules.experiments import service
from platform_app.modules.experiments.contracts import (
    ExperimentInput,
    ExperimentPage,
    ExperimentView,
    FreezeStrategyInput,
    StrategyVersionInput,
    StrategyVersionPage,
    StrategyVersionView,
)
from platform_app.modules.identity.routes import CurrentUser

router = APIRouter(prefix="/api/v1", tags=["experiments"])
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128),
]


@router.post(
    "/strategy-versions",
    response_model=Envelope[StrategyVersionView],
    status_code=201,
)
def create_strategy_version(
    body: StrategyVersionInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(data=service.create_strategy_version(user.id, body, key))


@router.get(
    "/strategy-versions",
    response_model=Envelope[StrategyVersionPage],
)
def list_strategy_versions(
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
):
    return Envelope(data=service.strategy_versions(user.id, limit))


@router.get(
    "/strategy-versions/{strategy_version_id}",
    response_model=Envelope[StrategyVersionView],
)
def get_strategy_version(strategy_version_id: str, user: CurrentUser):
    return Envelope(data=service.strategy_version(user.id, strategy_version_id))


@router.post(
    "/strategy-versions/{strategy_version_id}/freeze",
    response_model=Envelope[StrategyVersionView],
)
def freeze_strategy_version(
    strategy_version_id: str,
    body: FreezeStrategyInput,
    user: CurrentUser,
):
    return Envelope(
        data=service.freeze_strategy_version(
            user.id,
            strategy_version_id,
            body,
        )
    )


@router.post(
    "/experiments",
    response_model=Envelope[ExperimentView],
    status_code=201,
)
def create_experiment(
    body: ExperimentInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(data=service.create_experiment(user.id, body, key))


@router.get("/experiments", response_model=Envelope[ExperimentPage])
def list_experiments(
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
):
    return Envelope(data=service.experiments(user.id, limit))


@router.get(
    "/experiments/{experiment_id}",
    response_model=Envelope[ExperimentView],
)
def get_experiment(experiment_id: str, user: CurrentUser):
    return Envelope(data=service.experiment(user.id, experiment_id))
