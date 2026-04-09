from pathlib import Path
import os
import sys
import time

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from utils.branding import BACKEND_URL_ENV_VAR


def test_api():
    base_url = os.environ.get(BACKEND_URL_ENV_VAR, "http://127.0.0.1:8055")
    print("Testing Backend API Endpoints...")
    time.sleep(2)

    try:
        r = requests.get(f"{base_url}/health")
        print(f"Health: {r.status_code} - {r.json()}")
    except requests.exceptions.ConnectionError:
        print("Error: Server is not running. Start server.py first.")
        return

    r = requests.get(f"{base_url}/config")
    print(f"Config GET: {r.status_code}")

    r = requests.get(f"{base_url}/skills")
    print(f"Skills GET: {r.status_code} - Found {len(r.json().get('skills', []))} skills")

    updates = {"llm": {"temperature": 0.5}}
    r = requests.post(f"{base_url}/config", json=updates)
    print(f"Config POST: {r.status_code} - {r.json()}")


if __name__ == "__main__":
    test_api()
