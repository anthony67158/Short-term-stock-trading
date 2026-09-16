"""Bounded Review Agent over immutable metric and episode references."""

import asyncio
import json
import re
from datetime import datetime

import httpx

from platform_app.config import settings
from platform_app.modules.review.contracts import ReviewAgentOutput

SYSTEM = """你是A股交易复盘Agent。输入只包含已结算的结构化指标、失败簇和episode引用。
不得修改、重新计算或发明任何数字；文本中不要复述数字，只通过metric_refs引用已有指标。
OBSERVED只能概括输入中直接存在的模式，HYPOTHESIS必须明确是待实验验证的假设。
用户未创建计划或未录入成交不属于策略失败，不得将USER_NOT_EXECUTED归因给模型或Agent。
每个改进提案必须引用输入中的source_sample_ids，只能选择schema允许的变更类型和方向。
不得输出代码、SQL、命令、Prompt正文、生产配置、交易动作或发布建议。
完成后必须调用submit_review，参数严格遵循schema。
schema:
"""
REVIEW_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_review",
        "description": "提交结构化复盘结论和受限改进假设。",
        "parameters": ReviewAgentOutput.model_json_schema(by_alias=False),
    },
}


class ReviewAgentFailure(ValueError):
    pass


def validate_output(raw: str, payload: dict) -> ReviewAgentOutput:
    output = ReviewAgentOutput.model_validate_json(raw)
    snapshot = payload["metricSnapshot"]
    metric_ids = {
        metric["metric_id"]
        for metric in snapshot["metrics"]
    }
    source_ids = {
        sample_id
        for cluster in snapshot["failure_clusters"]
        for sample_id in cluster["source_sample_ids"]
    }
    for conclusion in output.conclusions:
        if any(reference not in metric_ids for reference in conclusion.metric_refs):
            raise ReviewAgentFailure("INVALID_REVIEW_METRIC_REFERENCE")
        if any(sample_id not in source_ids for sample_id in conclusion.source_sample_ids):
            raise ReviewAgentFailure("INVALID_REVIEW_SAMPLE_REFERENCE")
    for proposal in output.proposals:
        if any(sample_id not in source_ids for sample_id in proposal.source_sample_ids):
            raise ReviewAgentFailure("INVALID_REVIEW_SAMPLE_REFERENCE")
    generated_text = [
        output.summary,
        *(item.statement for item in output.conclusions),
        *(item.title for item in output.proposals),
        *(item.hypothesis for item in output.proposals),
    ]
    if any(re.search(r"\d", text) for text in generated_text):
        raise ReviewAgentFailure("REVIEW_TEXT_CONTAINS_UNSOURCED_NUMBER")
    return output


async def _request(payload: dict, timeout: float) -> ReviewAgentOutput:
    config = settings()
    body = {
        "model": config.agent_model,
        "max_tokens": 2500,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM
                + json.dumps(
                    ReviewAgentOutput.model_json_schema(by_alias=False),
                    ensure_ascii=False,
                ),
            },
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False),
            },
        ],
        "tools": [REVIEW_TOOL],
        "tool_choice": {
            "type": "function",
            "function": {"name": "submit_review"},
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
        raise ReviewAgentFailure("AGENT_AUTH_FAILED")
    if response.status_code == 429:
        raise ReviewAgentFailure("AGENT_RATE_LIMITED")
    if response.status_code == 400:
        raise ReviewAgentFailure("AGENT_PROTOCOL_REJECTED")
    if response.status_code >= 500:
        raise ReviewAgentFailure("AGENT_UPSTREAM_FAILED")
    response.raise_for_status()
    if len(response.content) > 256000:
        raise ReviewAgentFailure("INVALID_REVIEW_AGENT_OUTPUT")
    try:
        message = response.json()["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        if (
            len(calls) != 1
            or calls[0]["function"]["name"] != "submit_review"
        ):
            raise ReviewAgentFailure("INVALID_REVIEW_AGENT_OUTPUT")
        arguments = calls[0]["function"]["arguments"]
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, ensure_ascii=False)
        if not isinstance(arguments, str):
            raise ReviewAgentFailure("INVALID_REVIEW_AGENT_OUTPUT")
        return validate_output(arguments, payload)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        if isinstance(exc, ReviewAgentFailure):
            raise
        raise ReviewAgentFailure("INVALID_REVIEW_AGENT_OUTPUT") from exc


def run_review_agent(payload: dict) -> ReviewAgentOutput:
    config = settings()
    if (
        not config.agent_enabled
        or payload.get("model") != config.agent_model
        or payload.get("protocolVersion") != "review-agent.v1"
    ):
        raise ReviewAgentFailure("AGENT_UNAVAILABLE")
    try:
        deadline = datetime.fromisoformat(payload["deadline"])
        remaining = min(
            (deadline - datetime.now(deadline.tzinfo)).total_seconds(),
            config.agent_timeout_seconds,
        )
        if remaining < 1:
            raise ReviewAgentFailure("DEADLINE_EXCEEDED")
        return asyncio.run(_request(payload, remaining))
    except (httpx.TimeoutException, TimeoutError) as exc:
        raise ReviewAgentFailure(
            "AGENT_TIMEOUT_RESULT_UNCERTAIN"
        ) from exc
    except httpx.HTTPError as exc:
        raise ReviewAgentFailure("AGENT_UPSTREAM_FAILED") from exc
