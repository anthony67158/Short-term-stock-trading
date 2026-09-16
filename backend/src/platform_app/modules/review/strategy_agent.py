"""Strategy Agent constrained to a finite experiment-parameter registry."""

import asyncio
import json
from datetime import datetime

import httpx

from platform_app.config import settings
from platform_app.modules.review.contracts import StrategyAgentOutput

EXPERIMENT_PARAMETER_REGISTRY = {
    "minimumExpectedDeltaForAdd": {
        "changeTypes": ["DECISION_THRESHOLD"],
        "directions": ["INCREASE", "REVIEW"],
        "valueType": "DECIMAL_STRING",
        "allowedValues": ["0.005", "0.010", "0.020", "0.030"],
        "default": "0",
    },
    "maximumAgentUncertaintyCountForAdd": {
        "changeTypes": ["AGENT_PROTOCOL"],
        "directions": ["DECREASE", "REVIEW"],
        "valueType": "INTEGER",
        "allowedValues": [0, 1, 2, 3],
        "default": 12,
    },
    "minimumAgentEvidenceCountForAdd": {
        "changeTypes": ["FEATURE_SET"],
        "directions": ["INCREASE", "ADD", "REVIEW"],
        "valueType": "INTEGER",
        "allowedValues": [1, 2, 3, 4],
        "default": 0,
    },
    "maximumStopHazardForAdd": {
        "changeTypes": ["RISK_PARAMETER"],
        "directions": ["DECREASE", "REVIEW"],
        "valueType": "DECIMAL_STRING",
        "allowedValues": ["0.05", "0.10", "0.15", "0.20"],
        "default": "1",
    },
    "minimumExecutionSupportForAdd": {
        "changeTypes": ["EXECUTION_POLICY"],
        "directions": ["INCREASE", "REVIEW"],
        "valueType": "DECIMAL_STRING",
        "allowedValues": ["0.50", "0.60", "0.70", "0.80"],
        "default": "0",
    },
}
SYSTEM = """你是A股策略实验设计Agent。输入包含一个有来源episode的改进假设、冻结基线策略和有限参数注册表。
你只能从allowedParameters中选择一个parameterId和一个allowedValues中的原值，或返回REJECTED。
不得输出代码、表达式、SQL、命令、Prompt正文、文件路径、生产配置或发布动作。
不得改变数据集、确认集、费用、风险硬约束和发布门禁。输出只是待验证实验草案，不代表改进成立。
完成后必须调用submit_experiment_proposal，参数严格遵循schema。
schema:
"""
STRATEGY_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_experiment_proposal",
        "description": "提交一个受限参数实验或拒绝当前提案。",
        "parameters": StrategyAgentOutput.model_json_schema(by_alias=False),
    },
}


class StrategyAgentFailure(ValueError):
    pass


def allowed_parameters(change_type: str, direction: str) -> dict:
    return {
        parameter_id: {
            "valueType": spec["valueType"],
            "allowedValues": spec["allowedValues"],
            "default": spec["default"],
        }
        for parameter_id, spec in EXPERIMENT_PARAMETER_REGISTRY.items()
        if change_type in spec["changeTypes"]
        and direction in spec["directions"]
    }


def validate_output(raw: str, payload: dict) -> StrategyAgentOutput:
    output = StrategyAgentOutput.model_validate_json(raw)
    if output.status == "REJECTED":
        return output
    allowed = payload.get("allowedParameters")
    if (
        not isinstance(allowed, dict)
        or output.parameter_id not in allowed
        or output.candidate_value
        not in allowed[output.parameter_id].get("allowedValues", [])
    ):
        raise StrategyAgentFailure("STRATEGY_PARAMETER_NOT_ALLOWED")
    return output


async def _request(payload: dict, timeout: float) -> StrategyAgentOutput:
    config = settings()
    body = {
        "model": config.agent_model,
        "max_tokens": 1200,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM
                + json.dumps(
                    StrategyAgentOutput.model_json_schema(by_alias=False),
                    ensure_ascii=False,
                ),
            },
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False),
            },
        ],
        "tools": [STRATEGY_TOOL],
        "tool_choice": {
            "type": "function",
            "function": {"name": "submit_experiment_proposal"},
        },
    }
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=min(5, timeout))
    ) as client:
        response = await client.post(
            config.agent_base_url.rstrip("/") + "/v1/chat/completions",
            headers={
                "Authorization": (
                    "Bearer " + config.agent_api_key.get_secret_value()
                )
            },
            json=body,
        )
    if response.status_code in (401, 403):
        raise StrategyAgentFailure("AGENT_AUTH_FAILED")
    if response.status_code == 429:
        raise StrategyAgentFailure("AGENT_RATE_LIMITED")
    if response.status_code == 400:
        raise StrategyAgentFailure("AGENT_PROTOCOL_REJECTED")
    if response.status_code >= 500:
        raise StrategyAgentFailure("AGENT_UPSTREAM_FAILED")
    response.raise_for_status()
    if len(response.content) > 128000:
        raise StrategyAgentFailure("INVALID_STRATEGY_AGENT_OUTPUT")
    try:
        message = response.json()["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        if (
            len(calls) != 1
            or calls[0]["function"]["name"]
            != "submit_experiment_proposal"
        ):
            raise StrategyAgentFailure("INVALID_STRATEGY_AGENT_OUTPUT")
        arguments = calls[0]["function"]["arguments"]
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, ensure_ascii=False)
        if not isinstance(arguments, str):
            raise StrategyAgentFailure("INVALID_STRATEGY_AGENT_OUTPUT")
        return validate_output(arguments, payload)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        if isinstance(exc, StrategyAgentFailure):
            raise
        raise StrategyAgentFailure(
            "INVALID_STRATEGY_AGENT_OUTPUT"
        ) from exc


def run_strategy_agent(payload: dict) -> StrategyAgentOutput:
    config = settings()
    if (
        not config.agent_enabled
        or payload.get("model") != config.agent_model
        or payload.get("protocolVersion") != "strategy-agent.v1"
    ):
        raise StrategyAgentFailure("AGENT_UNAVAILABLE")
    try:
        deadline = datetime.fromisoformat(payload["deadline"])
        remaining = min(
            (deadline - datetime.now(deadline.tzinfo)).total_seconds(),
            config.agent_timeout_seconds,
        )
        if remaining < 1:
            raise StrategyAgentFailure("DEADLINE_EXCEEDED")
        return asyncio.run(_request(payload, remaining))
    except (httpx.TimeoutException, TimeoutError) as exc:
        raise StrategyAgentFailure(
            "AGENT_TIMEOUT_RESULT_UNCERTAIN"
        ) from exc
    except httpx.HTTPError as exc:
        raise StrategyAgentFailure("AGENT_UPSTREAM_FAILED") from exc
