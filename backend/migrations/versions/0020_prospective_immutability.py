"""Make prospective evidence immutability reproducible.

Revision ID: 0020_prospective_immutability
Revises: 0019_corporate_shares
"""

from alembic import op

revision = "0020_prospective_immutability"
down_revision = "0019_corporate_shares"


def upgrade():
    op.execute(
        """
        CREATE OR REPLACE FUNCTION protect_prospective_outcome()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'PROSPECTIVE_OUTCOME_IMMUTABLE';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION protect_prospective_sample_payload()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF ROW(
                NEW.owner_id, NEW.account_id, NEW.instrument_id,
                NEW.assessment_id, NEW.source_key, NEW.request_hash,
                NEW.decision_context_hash, NEW.schema_version,
                NEW.decision_as_of, NEW.horizon_end_date,
                NEW.market_snapshot_ref, NEW.ranking_bundle_id,
                NEW.quant_bundle_id, NEW.agent_protocol_version,
                NEW.agent_feature_schema_version, NEW.agent_features,
                NEW.quant_prediction, NEW.scenario, NEW.context,
                NEW.created_at
            ) IS DISTINCT FROM ROW(
                OLD.owner_id, OLD.account_id, OLD.instrument_id,
                OLD.assessment_id, OLD.source_key, OLD.request_hash,
                OLD.decision_context_hash, OLD.schema_version,
                OLD.decision_as_of, OLD.horizon_end_date,
                OLD.market_snapshot_ref, OLD.ranking_bundle_id,
                OLD.quant_bundle_id, OLD.agent_protocol_version,
                OLD.agent_feature_schema_version, OLD.agent_features,
                OLD.quant_prediction, OLD.scenario, OLD.context,
                OLD.created_at
            ) THEN
                RAISE EXCEPTION
                    'PROSPECTIVE_SAMPLE_PAYLOAD_IMMUTABLE';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        "DROP TRIGGER IF EXISTS prospective_outcome_immutable "
        "ON prospective_outcomes"
    )
    op.execute(
        "CREATE TRIGGER prospective_outcome_immutable "
        "BEFORE UPDATE OR DELETE ON prospective_outcomes "
        "FOR EACH ROW EXECUTE FUNCTION protect_prospective_outcome()"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS prospective_sample_payload_immutable "
        "ON prospective_samples"
    )
    op.execute(
        "CREATE TRIGGER prospective_sample_payload_immutable "
        "BEFORE UPDATE ON prospective_samples "
        "FOR EACH ROW EXECUTE FUNCTION "
        "protect_prospective_sample_payload()"
    )


def downgrade():
    op.execute(
        "DROP TRIGGER IF EXISTS prospective_outcome_immutable "
        "ON prospective_outcomes"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS prospective_sample_payload_immutable "
        "ON prospective_samples"
    )
    op.execute("DROP FUNCTION IF EXISTS protect_prospective_outcome()")
    op.execute(
        "DROP FUNCTION IF EXISTS protect_prospective_sample_payload()"
    )
