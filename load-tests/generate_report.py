import json
from datetime import datetime

def load_summary(path="summary.json"):
    with open(path, "r") as f:
        return json.load(f)

def safe_get(metric, key, default=0):
    try:
        return metric["values"][key]
    except Exception:
        return default

def generate_capacity_verdict(rps, p95, failure_rate):
    if failure_rate > 5:
        return "System reached failure threshold."
    elif p95 > 1500:
        return "System latency exceeded acceptable limits (possible saturation)."
    elif rps > 0:
        return "System sustained load successfully without critical degradation."
    else:
        return "Insufficient data."

def generate_html(data):
    metrics = data.get("metrics", {})

    http_reqs = metrics.get("http_reqs", {})
    http_failed = metrics.get("http_req_failed", {})
    http_duration = metrics.get("http_req_duration", {})
    login_success = metrics.get("login_success_count", {})
    vus_metric = metrics.get("vus_max", {})

    total_requests = safe_get(http_reqs, "count")
    rps = safe_get(http_reqs, "rate")
    failure_rate = safe_get(http_failed, "rate") * 100
    avg_latency = safe_get(http_duration, "avg")
    p95_latency = safe_get(http_duration, "p(95)")
    success_count = safe_get(login_success, "count")
    max_vus = safe_get(vus_metric, "max")

    test_duration = data.get("state", {}).get("testRunDurationMs", 0) / 1000

    verdict = generate_capacity_verdict(rps, p95_latency, failure_rate)

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")

    html = f"""
    <html>
    <head>
        <title>Auth Capacity Test Report</title>
        <style>
            body {{ font-family: Arial; padding: 40px; }}
            h1 {{ color: #222; }}
            ul {{ line-height: 1.8; }}
            .verdict {{ font-size: 18px; font-weight: bold; color: darkgreen; }}
            pre {{ background: #f4f4f4; padding: 20px; overflow-x: auto; }}
        </style>
    </head>
    <body>
        <h1>Auth Service Capacity Report</h1>
        <p><strong>Generated:</strong> {now}</p>

        <h2>Peak Load Metrics</h2>
        <ul>
            <li><strong>Maximum Concurrent Users:</strong> {max_vus}</li>
            <li><strong>Total Requests:</strong> {total_requests}</li>
            <li><strong>Peak Throughput (RPS):</strong> {rps:.2f}</li>
            <li><strong>Failure Rate:</strong> {failure_rate:.2f}%</li>
            <li><strong>Average Latency:</strong> {avg_latency:.2f} ms</li>
            <li><strong>P95 Latency:</strong> {p95_latency:.2f} ms</li>
            <li><strong>Successful Logins:</strong> {success_count}</li>
            <li><strong>Test Duration:</strong> {test_duration:.2f} seconds</li>
        </ul>

        <h2>Capacity Verdict</h2>
        <p class="verdict">{verdict}</p>

        <h2>Raw Metrics</h2>
        <pre>{json.dumps(data, indent=2)}</pre>
    </body>
    </html>
    """

    return html

def main():
    data = load_summary()
    html = generate_html(data)

    with open("report.html", "w") as f:
        f.write(html)

    print("Report generated: report.html")

if __name__ == "__main__":
    main()
