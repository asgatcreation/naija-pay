# naija-pay (Python)

One typed interface to every Nigerian payment and banking-as-a-service provider:
collections, virtual accounts, split payments, customer wallets, payouts, recurring
billing and webhooks.

```bash
pip install naija-pay
```

```python
from naija_pay import NaijaPay, naira
from naija_pay.providers import paystack

pay = NaijaPay(providers=[paystack(secret_key=os.environ["PAYSTACK_SECRET_KEY"])])

checkout = pay.checkout.create(
    amount=naira(5_000),
    reference="order_01HQ",
    customer={"email": "ada@example.com"},
)
```

Sync and async clients, full type hints under `mypy --strict`, and `httpx` as the only
runtime dependency.

> **Pre-release.** Not yet published to PyPI, and no provider adapter is sandbox-verified yet.

Full documentation, the provider capability matrix and the API contract are in the
[project repository](https://github.com/asgatcreation/naija-pay).

MIT © Akanji Oluwaseun Gabriel
