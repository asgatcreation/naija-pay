#!/usr/bin/env python
"""Records the Paystack fixtures from the provider's own documented samples.

Run once to (re)create `fixtures/providers/paystack/`. Keeping this as a script rather
than hand-written JSON means the provenance of every fixture is in version control: each
directory gets a `source.txt` naming the documentation page and the date it was read.

Identifiers are replaced with the repository's standard fakes (account number
0123456789, BVN 22222222222, email ada@example.com) so no real values are committed.
"""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "fixtures" / "providers" / "paystack"
DOCS = "https://paystack.com/docs/api"
VERIFIED = "2026-10-30"


def write(operation: str, request: dict, response: dict, source: str) -> None:
    directory = BASE / operation
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "request.json").write_text(json.dumps(request, indent=2) + "\n", encoding="utf-8")
    (directory / "response.json").write_text(
        json.dumps(response, indent=2) + "\n", encoding="utf-8"
    )
    (directory / "source.txt").write_text(
        f"{source}\nVerified: {VERIFIED}\n"
        "Recorded from Paystack's own documented sample response. Identifiers replaced\n"
        "with this repository's standard fake values.\n",
        encoding="utf-8",
    )


write(
    "transaction-initialize",
    {
        "method": "POST",
        "path": "/transaction/initialize",
        "body": {
            "email": "ada@example.com",
            "amount": "500000",
            "currency": "NGN",
            "reference": "order_01HQ",
            "channels": ["card", "bank_transfer"],
        },
    },
    {
        "status": True,
        "message": "Authorization URL created",
        "data": {
            "authorization_url": "https://checkout.paystack.com/3ni8kdavz62431k",
            "access_code": "3ni8kdavz62431k",
            "reference": "order_01HQ",
        },
    },
    f"{DOCS}/transaction/ - Initialize Transaction",
)

write(
    "transaction-verify-success",
    {"method": "GET", "path": "/transaction/verify/order_01HQ"},
    {
        "status": True,
        "message": "Verification successful",
        "data": {
            "id": 4099260516,
            "domain": "test",
            "status": "success",
            "reference": "order_01HQ",
            "amount": 40333,
            "gateway_response": "Successful",
            "paid_at": "2024-08-22T09:15:02.000Z",
            "created_at": "2024-08-22T09:14:24.000Z",
            "channel": "card",
            "currency": "NGN",
            "fees": 10283,
            "requested_amount": 30050,
            "authorization": {
                "authorization_code": "AUTH_uh8bcl3zbn",
                "last4": "4081",
                "brand": "visa",
                "bank": "TEST BANK",
                "reusable": True,
                "signature": "SIG_yEXu7dLBeqG0kU7g95Ke",
            },
            "customer": {
                "id": 181873746,
                "first_name": "Ada",
                "last_name": "Obi",
                "email": "ada@example.com",
                "customer_code": "CUS_1rkzaqsv4rrhqo6",
                "phone": None,
            },
        },
    },
    f"{DOCS}/transaction/ - Verify Transaction",
)

write(
    "transaction-verify-pending",
    {"method": "GET", "path": "/transaction/verify/order_pending"},
    {
        "status": True,
        "message": "Verification successful",
        "data": {
            "id": 1,
            "status": "ongoing",
            "reference": "order_pending",
            "amount": 500000,
            "currency": "NGN",
            "channel": "bank_transfer",
            "customer": {"email": "ada@example.com"},
        },
    },
    f"{DOCS}/transaction/ - Verify Transaction (status vocabulary: ongoing)",
)

write(
    "bank-resolve",
    {
        "method": "GET",
        "path": "/bank/resolve",
        "query": {"account_number": "0123456789", "bank_code": "044"},
    },
    {
        "status": True,
        "message": "Account number resolved",
        "data": {"account_number": "0123456789", "account_name": "ADA OBI"},
    },
    f"{DOCS}/verification/ - Resolve Account",
)

write(
    "transferrecipient-create",
    {
        "method": "POST",
        "path": "/transferrecipient",
        "body": {
            "type": "nuban",
            "name": "ADA OBI",
            "account_number": "0123456789",
            "bank_code": "044",
            "currency": "NGN",
        },
    },
    {
        "status": True,
        "message": "Transfer recipient created successfully",
        "data": {
            "active": True,
            "currency": "NGN",
            "id": 20317609,
            "name": "ADA OBI",
            "recipient_code": "RCP_m7ljkv8leesep7p",
            "type": "nuban",
            "details": {
                "account_number": "0123456789",
                "account_name": "ADA OBI",
                "bank_code": "044",
                "bank_name": "Access Bank",
            },
        },
    },
    f"{DOCS}/transfer-recipient/ - Create Transfer Recipient",
)

write(
    "transfer-create",
    {
        "method": "POST",
        "path": "/transfer",
        "body": {
            "source": "balance",
            "amount": 2500000,
            "currency": "NGN",
            "recipient": "RCP_m7ljkv8leesep7p",
            "reference": "payout-01hq-abcdefgh",
            "reason": "Vendor settlement",
        },
    },
    {
        "status": True,
        "message": "Transfer has been queued",
        "data": {
            "amount": 2500000,
            "currency": "NGN",
            "reference": "payout-01hq-abcdefgh",
            "source": "balance",
            "reason": "Vendor settlement",
            "status": "success",
            "transfer_code": "TRF_v5tip3zx8nna9o78",
            "id": 860703114,
            "recipient": 56824902,
            "createdAt": "2025-08-04T10:32:40.000Z",
        },
    },
    f"{DOCS}/transfer/ - Initiate Transfer",
)

write(
    "transfer-create-otp",
    {
        "method": "POST",
        "path": "/transfer",
        "body": {
            "source": "balance",
            "amount": 2500000,
            "currency": "NGN",
            "recipient": "RCP_m7ljkv8leesep7p",
            "reference": "payout-01hq-otpcase1",
        },
    },
    {
        "status": True,
        "message": "Transfer requires OTP to continue",
        "data": {
            "amount": 2500000,
            "currency": "NGN",
            "reference": "payout-01hq-otpcase1",
            "status": "otp",
            "transfer_code": "TRF_otp123456789",
            "id": 860703115,
        },
    },
    f"{DOCS}/transfer/ - Initiate Transfer (OTP enabled: status reads 'otp')",
)

write(
    "refund-create",
    {"method": "POST", "path": "/refund", "body": {"transaction": "order_01HQ"}},
    {
        "status": True,
        "message": "Refund has been queued for processing",
        "data": {
            "transaction": {
                "id": 1004723697,
                "reference": "order_01HQ",
                "amount": 500000,
                "currency": "NGN",
                "channel": "card",
            },
            "deducted_amount": 0,
            "status": "pending",
            "currency": "NGN",
            "amount": 500000,
            "id": 3018284,
            "createdAt": "2021-12-07T09:21:17.122Z",
        },
    },
    f"{DOCS}/refund/ - Create Refund",
)

write(
    "subaccount-create",
    {
        "method": "POST",
        "path": "/subaccount",
        "body": {
            "business_name": "Ada Fabrics",
            "bank_code": "044",
            "settlement_bank": "044",
            "account_number": "0123456789",
            "percentage_charge": 2.5,
        },
    },
    {
        "status": True,
        "message": "Subaccount created",
        "data": {
            "business_name": "Ada Fabrics",
            "account_number": "0123456789",
            "percentage_charge": 2.5,
            "settlement_bank": "Access Bank",
            "currency": "NGN",
            "account_name": "ADA OBI",
            "subaccount_code": "ACCT_6uujpqtzmnufzkw",
            "is_verified": False,
            "settlement_schedule": "AUTO",
            "active": True,
            "id": 1151727,
        },
    },
    f"{DOCS}/subaccount/ - Create Subaccount",
)

write(
    "split-create",
    {
        "method": "POST",
        "path": "/split",
        "body": {
            "name": "marketplace",
            "type": "percentage",
            "currency": "NGN",
            "subaccounts": [{"subaccount": "ACCT_6uujpqtzmnufzkw", "share": 90.0}],
            "bearer_type": "all-proportional",
        },
    },
    {
        "status": True,
        "message": "Split created",
        "data": {
            "id": 2703655,
            "name": "marketplace",
            "type": "percentage",
            "currency": "NGN",
            "split_code": "SPL_RcScyW5jp2",
            "active": True,
            "bearer_type": "all-proportional",
            "subaccounts": [
                {
                    "subaccount": {
                        "id": 1151727,
                        "subaccount_code": "ACCT_6uujpqtzmnufzkw",
                        "business_name": "Ada Fabrics",
                        "settlement_bank": "Access Bank",
                        "account_number": "0123456789",
                    },
                    "share": 90,
                }
            ],
            "total_subaccounts": 1,
        },
    },
    f"{DOCS}/split/ - Create Split",
)

write(
    "dedicated-account-assign",
    {
        "method": "POST",
        "path": "/dedicated_account/assign",
        "body": {
            "email": "ada@example.com",
            "first_name": "Ada",
            "last_name": "Obi",
            "phone": "+2348100000000",
            "preferred_bank": "wema-bank",
            "country": "NG",
            "bvn": "22222222222",
        },
    },
    {"status": True, "message": "Assign dedicated account in progress"},
    f"{DOCS}/dedicated-virtual-account/ - Assign Dedicated Virtual Account",
)

write(
    "dedicated-account-get",
    {"method": "GET", "path": "/dedicated_account/253"},
    {
        "status": True,
        "message": "Managed account successfully retrieved",
        "data": {
            "bank": {"name": "Wema Bank", "id": 20, "slug": "wema-bank"},
            "account_name": "NAIJA PAY / ADA OBI",
            "account_number": "9930000737",
            "assigned": True,
            "currency": "NGN",
            "active": True,
            "id": 253,
            "assignment": {"expired": False, "account_type": "PAY-WITH-TRANSFER-RECURRING"},
            "customer": {
                "id": 7454289,
                "first_name": "Ada",
                "last_name": "Obi",
                "email": "ada@example.com",
                "customer_code": "CUS_kpb3qj71u1m0rw8",
                "phone": "+2348100000000",
            },
        },
    },
    f"{DOCS}/dedicated-virtual-account/ - Fetch Dedicated Virtual Account",
)

write(
    "error-duplicate-reference",
    {
        "method": "POST",
        "path": "/transaction/initialize",
        "body": {"email": "ada@example.com", "amount": "500000", "reference": "order_01HQ"},
    },
    {"status": False, "message": "Duplicate Transaction Reference"},
    f"{DOCS}/errors/ - envelope with status false",
)

directories = sorted(p.name for p in BASE.iterdir() if p.is_dir())
print(f"wrote {len(directories)} fixture directories:")
for name in directories:
    print(f"  {name}")
