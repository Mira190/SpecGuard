from flask import Flask, jsonify, request

from pricing import quote_total

app = Flask(__name__)


@app.post("/quote")
def quote():
    body = request.get_json()
    return jsonify(total=quote_total(body["items"], body.get("tier")))
