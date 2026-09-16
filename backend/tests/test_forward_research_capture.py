import asyncio
import json
from datetime import timedelta

import pytest

from platform_app.adapters.doubao_search import SearchEvidence, SearchResponse
from platform_app.config import Settings
from platform_app.contracts.base import utcnow
from platform_app.modules.experiments import forward_research_capture as capture
from platform_app.modules.research.agent import AgentFailure, validate_output


class Search:
    async def search(self, query):
        return SearchResponse(
            query=query.query, scope=query.scope, request_id="synthetic", elapsed_ms=1,
            results=[
                SearchEvidence(
                    provider_id=str(index), rank=index, title="Synthetic evidence",
                    site_name=None, url="https://example.org/evidence",
                    text="Synthetic published evidence containing a precise quoted statement.",
                    published_at=date, authority_level=None, authority_description=None,
                )
                for index, date in enumerate([
                    (utcnow() - timedelta(days=1)).isoformat(),
                    (utcnow() + timedelta(days=1)).isoformat(), None,
                ])
            ],
        )


@pytest.mark.parametrize("failure", [None, "UNSUPPORTED_OBSERVATION", "timeout"])
def test_prefetch_freezes_input_and_preserves_failures(tmp_path, monkeypatch, failure):
    root = tmp_path / "capture"
    calls = []

    async def model(payload, config, search):
        calls.append(payload)
        assert not config.search_enabled and search is None
        frozen = json.loads((root / "input.json").read_text())
        assert payload == frozen
        assert len(payload["evidence"]) == 2
        assert all(e["available_at"] <= payload["asOf"] for e in payload["evidence"])
        if failure == "timeout":
            raise TimeoutError
        if failure:
            raise AgentFailure(failure)
        raw = {
            "summary": "Evidence remains unverified.",
            "claims": [{
                "kind": "OBSERVED", "statement": "Synthetic published evidence",
                "evidence_ids": [payload["evidence"][0]["id"]],
            }],
            "counter_claims": [], "thesis_status": "UNCERTAIN", "strategy_fit": [],
            "uncertainties": ["Unverified search snippet"], "invalidation": "New evidence",
            "next_check": "Read issuer source",
            "valid_until": (utcnow() + timedelta(hours=1)).isoformat(),
        }
        from platform_app.modules.research.agent import AgentRunResult
        return AgentRunResult(validate_output(json.dumps(raw), payload), [], [])

    monkeypatch.setattr(capture, "_run_agent", model)
    result = asyncio.run(capture.capture(
        root, "SH.600000", "Synthetic", search=Search(),
        config=Settings(agent_enabled=True, search_enabled=True),
    ))
    assert len(calls) == 1
    assert result["status"] == ("FAILED" if failure else "VALIDATED")
    assert not result["jointPerformanceValidated"]
    assert (root / "search-0.json").exists()
    if failure:
        assert not (root / "assessment.json").exists()
    with pytest.raises(FileExistsError):
        asyncio.run(capture.capture(
            root, "SH.600000", "Synthetic", search=Search(),
            config=Settings(agent_enabled=True, search_enabled=True),
        ))
