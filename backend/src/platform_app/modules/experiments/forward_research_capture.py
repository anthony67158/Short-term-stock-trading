"""Research-only prospective capture: bounded prefetch, then one assessment call."""

import argparse
import asyncio
import hashlib
import json
from datetime import timedelta
from pathlib import Path

import httpx

from platform_app.adapters.doubao_search import DoubaoSearchClient, SearchFailure, SearchRequest
from platform_app.config import settings
from platform_app.contracts.base import utcnow
from platform_app.modules.research.agent import AgentFailure, _run_agent, _search_evidence
from platform_app.modules.research.contracts import ResearchInput

PROTOCOL = "forward-prefetch-single-call.v1"


def save(path: Path, payload: dict) -> None:
    # Exclusive files preserve exactly what was available before each external call.
    with path.open("x") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


async def capture(root: Path, instrument: str, name: str, *, config=None, search=None):
    config = config or settings()
    if not config.agent_enabled or not config.search_enabled:
        raise AgentFailure("CAPTURE_SERVICES_UNAVAILABLE")
    request = ResearchInput(
        instrument_id=instrument, evidence_ids=[],
        question=f"研究{name}当前事件证据、最强反证和持仓论点失效条件；不输出交易动作。",
    )
    queries = [
        SearchRequest(query=f"{name} {instrument} 公司公告 经营 风险", scope="OFFICIAL", count=4),
        SearchRequest(query=f"{name} {instrument} 业绩 风险 反证", scope="NEWS", count=4),
    ][:config.agent_search_max_calls]
    started = utcnow()
    deadline = started + timedelta(seconds=config.agent_timeout_seconds)
    root.mkdir(parents=True, exist_ok=False)
    save(root / "protocol.json", {
        "protocolVersion": PROTOCOL, "model": config.agent_model,
        "instrumentId": instrument, "startedAt": started.isoformat(),
        "publicationCutoff": started.isoformat(), "deadline": deadline.isoformat(),
        "queries": [q.model_dump() for q in queries], "maximumModelCalls": 1,
        "usage": "RESEARCH_ONLY", "historicalEvaluationAllowed": False,
        "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    })
    evidence, traces = [], []
    result = {"status": "FAILED", "protocolVersion": PROTOCOL}
    try:
        search = search or DoubaoSearchClient(config=config)
        async with asyncio.timeout(config.agent_timeout_seconds):
            for index, query in enumerate(queries):
                query = query.model_copy(update={
                    "time_range": f"1990-01-01..{started.date()}",
                })
                trace = {"request": query.model_dump(), "startedAt": utcnow().isoformat()}
                try:
                    response = await search.search(query)
                    fetched = utcnow()
                    accepted = _search_evidence(response, {
                        "asOf": started.isoformat(),
                        "request": request.model_dump(),
                    }, fetched)
                    # Persist actual returned evidence, including rejected/missing dates.
                    save(root / f"search-{index}.json", {
                        "response": response.model_dump(), "retrievedAt": fetched.isoformat(),
                        "acceptedEvidence": accepted,
                    })
                    evidence.extend(accepted)
                    trace.update(status="SUCCEEDED", accepted=len(accepted))
                except SearchFailure as exc:
                    trace.update(status="FAILED", errorCode=str(exc))
                trace["completedAt"] = utcnow().isoformat()
                traces.append(trace)
                save(root / f"trace-{index}.json", trace)
            if not evidence:
                raise AgentFailure("NO_POINT_IN_TIME_EVIDENCE")
            as_of = utcnow()
            payload = {
                "request": request.model_copy(update={
                    "evidence_ids": [e["id"] for e in evidence],
                }).model_dump(mode="json"),
                "evidence": evidence, "protocolVersion": PROTOCOL,
                "model": config.agent_model, "asOf": as_of.isoformat(),
                "deadline": deadline.isoformat(),
                "constraints": (
                    "仅提交一次submit_assessment。OBSERVED只复制证据text中的连续原文；"
                    "改写、总结或因果判断必须用INFERRED或HYPOTHESIS。"
                    "最多3条论点和2条反证，保留搜索摘要尚未核实的不确定性。"
                ),
            }
            save(root / "input.json", payload)
            run = await _run_agent(
                payload, config.model_copy(update={"search_enabled": False}), None,
            )
            save(root / "assessment.json", run.assessment.model_dump(mode="json"))
            result.update(status="VALIDATED", asOf=as_of.isoformat())
    except (TimeoutError, httpx.TimeoutException):
        result["errorCode"] = "AGENT_TIMEOUT_RESULT_UNCERTAIN"
    except (AgentFailure, SearchFailure) as exc:
        result["errorCode"] = str(exc)
    except httpx.HTTPError:
        result["errorCode"] = "AGENT_UPSTREAM_FAILED"
    except (ValueError, KeyError, TypeError, IndexError):
        result["errorCode"] = "INVALID_AGENT_OUTPUT"
    result.update(
        completedAt=utcnow().isoformat(), acceptedEvidence=len(evidence),
        searchCalls=len(traces), usage="RESEARCH_ONLY",
        matureReturnLabels=False, jointPerformanceValidated=False,
    )
    save(root / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    result = asyncio.run(capture(args.output, args.instrument, args.name))
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
