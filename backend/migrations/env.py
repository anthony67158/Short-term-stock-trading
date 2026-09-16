from alembic import context

from platform_app.adapters.database import Base, engine
from platform_app.modules.identity import models as identity_models  # noqa: F401
from platform_app.modules.operations import models  # noqa: F401
from platform_app.modules.portfolio import models as portfolio_models  # noqa: F401
from platform_app.modules.market import models as market_models  # noqa: F401
from platform_app.modules.research import models as research_models  # noqa: F401
from platform_app.modules.learning import models as learning_models  # noqa: F401

with engine().connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
