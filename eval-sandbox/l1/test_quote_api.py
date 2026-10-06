from app import app


def test_quote_applies_gold_discount():
    client = app.test_client()
    resp = client.post("/quote", json={"items": [{"price": 100, "qty": 2}], "tier": "gold"})
    assert resp.json["total"] == 170.0


def test_quote_adds_big_order_bonus():
    client = app.test_client()
    resp = client.post("/quote", json={"items": [{"price": 300, "qty": 2}]})
    assert resp.json["total"] == 590.0
