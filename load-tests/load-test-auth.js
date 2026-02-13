import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// =============================
// Custom Metrics
// =============================
export const loginDuration = new Trend('login_duration');
export const loginFailureRate = new Rate('login_failure_rate');
export const loginSuccessCount = new Counter('login_success_count');

// =============================
// Test Configuration
// =============================
export const options = {
  scenarios: {
    auth_capacity_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '1m', target: 300 },
        { duration: '1m', target: 500 },
        { duration: '1m', target: 700 },
        { duration: '1m', target: 0 },
      ],
    },
  },

  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.05'],
    login_failure_rate: ['rate<0.05'],
  },
};

// =============================
// Base URL
// =============================
const BASE_URL = 'http://host.docker.internal:8080';
// const BASE_URL = 'http://localhost:8080'; // If running locally

// =============================
// Helper Function
// =============================
function loginUser(username, password) {
  const payload = JSON.stringify({
    username,
    password,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'http://localhost:5173',
    },
    tags: { name: 'AuthLogin' },
  };

  const response = http.post(`${BASE_URL}/login`, payload, params);

  loginDuration.add(response.timings.duration);

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 2000ms': (r) => r.timings.duration < 2000,
  });

  if (response.status === 200) loginSuccessCount.add(1);
  loginFailureRate.add(success ? 0 : 1);

  return response;
}

// =============================
// Main Test Execution
// =============================
export default function () {
  const username = 'karanraj3056@gmail.com';
  const password = 'Kroops@7852';

  loginUser(username, password);

  sleep(1); // controlled pacing
}

// =============================
// Export Summary (JSON + HTML)
// =============================
export function handleSummary(data) {
  const totalReqs = data.metrics && data.metrics.http_reqs && data.metrics.http_reqs.values && data.metrics.http_reqs.values.count ? data.metrics.http_reqs.values.count : 0;
  const rps = data.metrics && data.metrics.http_reqs && data.metrics.http_reqs.values && data.metrics.http_reqs.values.rate ? data.metrics.http_reqs.values.rate : 0;
  const failed = data.metrics && data.metrics.http_req_failed && data.metrics.http_req_failed.values && data.metrics.http_req_failed.values.rate ? data.metrics.http_req_failed.values.rate * 100 : 0;
  const avgResp = data.metrics && data.metrics.http_req_duration && data.metrics.http_req_duration.values && data.metrics.http_req_duration.values.avg ? data.metrics.http_req_duration.values.avg : 0;
  const p95Resp = data.metrics && data.metrics.http_req_duration && data.metrics.http_req_duration.values && data.metrics.http_req_duration.values['p(95)'] ? data.metrics.http_req_duration.values['p(95)'] : 0;
  const loginSuccess = data.metrics && data.metrics.login_success_count && data.metrics.login_success_count.values && data.metrics.login_success_count.values.count ? data.metrics.login_success_count.values.count : 0;

  return {
    "summary.json": JSON.stringify(data, null, 2),
    "summary.html": `
      <html>
        <head>
          <title>Auth Capacity Test Report</title>
          <style>
            body { font-family: Arial; padding: 40px; }
            h1 { color: #222; }
            ul { line-height: 1.8; }
            pre { background: #f4f4f4; padding: 20px; overflow-x: auto; }
          </style>
        </head>
        <body>
          <h1>Auth Service Capacity Test Report</h1>
          <h2>Key Metrics</h2>
          <ul>
            <li><strong>Total Requests:</strong> ${totalReqs}</li>
            <li><strong>Throughput (RPS):</strong> ${rps.toFixed(2)} / sec</li>
            <li><strong>Failed Requests:</strong> ${failed.toFixed(2)}%</li>
            <li><strong>Avg Response Time:</strong> ${avgResp.toFixed(2)} ms</li>
            <li><strong>P95 Response Time:</strong> ${p95Resp.toFixed(2)} ms</li>
            <li><strong>Login Success Count:</strong> ${loginSuccess}</li>
          </ul>
          <h2>Full Raw Summary</h2>
          <pre>${JSON.stringify(data, null, 2)}</pre>
        </body>
      </html>
    `,
  };
}
