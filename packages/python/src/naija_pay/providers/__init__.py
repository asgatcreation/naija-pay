"""Provider adapters.

Each provider lives in its own module so an application only imports what it uses. The
mock provider needs no keys and reaches no network.
"""

from naija_pay.providers.mock import MockProvider, mock

__all__ = ["MockProvider", "mock"]
