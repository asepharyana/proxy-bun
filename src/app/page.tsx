"use client";

import { useState } from "react";

export default function Home() {
  const [targetUrl, setTargetUrl] = useState("https://httpbin.org/anything");
  const [method, setMethod] = useState("GET");
  const [requestBody, setRequestBody] = useState(JSON.stringify({
    message: "Hello from Edge Proxy",
    timestamp: Date.now(),
  }, null, 2));
  const [headerKey, setHeaderKey] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

  async function sendRequest() {
    setLoading(true);
    setResponse(null);

    const headers: Record<string, string> = {
      'x-relay-target': targetUrl,
      'Content-Type': 'application/json'
    };

    if (headerKey && headerValue) {
      headers[headerKey] = headerValue;
    }
    // console.log('Request Headers:', headers);
    try {
      const start = Date.now();
      const fetchOptions: any = {
        method,
        headers
      };

      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && requestBody) {
        fetchOptions.body = requestBody;
      }

      const res = await fetch('/api/relay', fetchOptions);
      const elapsed = Date.now() - start;

      let responseText = '';
      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await res.json();
        responseText = JSON.stringify(data, null, 2);
      } else {
        responseText = await res.text();
      }

      const headersObj: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      setResponse({
        status: res.status,
        statusText: res.statusText,
        time: `${elapsed}ms`,
        body: responseText,
        headers: JSON.stringify(headersObj, null, 2)
      });
    } catch (err: any) {
      setResponse({
        status: 'Error',
        body: err.message,
        headers: '-'
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-8 max-w-6xl mx-auto font-sans">
      <h1 className="text-3xl font-bold text-sky-400 mb-2">Edge Proxy Relay Test</h1>
      <p className="text-slate-400 mb-8">Standardized Next.js Migration</p>

      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 mb-6">
        <h2 className="text-sky-400 text-sm font-bold uppercase tracking-wider mb-4">Target Configuration</h2>
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-500 font-bold uppercase mb-2">Target URL</label>
            <input
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-sm focus:border-sky-500 outline-none"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {['https://httpbin.org/anything', 'https://httpbin.org/get', 'https://jsonplaceholder.typicode.com/posts/1'].map(url => (
              <button
                key={url}
                className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded transition"
                onClick={() => setTargetUrl(url)}
              >
                {url.split('/').pop() || url}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 mb-6">
        <h2 className="text-sky-400 text-sm font-bold uppercase tracking-wider mb-4">Method</h2>
        <div className="flex gap-2 flex-wrap">
          {methods.map(m => (
            <button
              key={m}
              className={`px-4 py-2 rounded font-bold text-sm transition ${method === m ? 'bg-sky-500 text-slate-900' : 'bg-slate-700 hover:bg-slate-600'}`}
              onClick={() => setMethod(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-sky-400 text-sm font-bold uppercase tracking-wider mb-4">Body (JSON)</h2>
          <textarea
            className="w-full h-48 bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-xs focus:border-sky-500 outline-none resize-none"
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
          />
        </div>
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-sky-400 text-sm font-bold uppercase tracking-wider mb-4">Custom Headers</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-500 font-bold uppercase mb-2">Key</label>
              <input
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-sm focus:border-sky-500 outline-none"
                placeholder="x-custom-header"
                value={headerKey}
                onChange={(e) => setHeaderKey(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 font-bold uppercase mb-2">Value</label>
              <input
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 font-mono text-sm focus:border-sky-500 outline-none"
                placeholder="value"
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      <button
        className="w-full py-4 bg-sky-500 hover:bg-sky-400 text-slate-900 font-bold rounded-xl transition shadow-lg shadow-sky-500/20 disabled:opacity-50"
        onClick={sendRequest}
        disabled={loading}
      >
        {loading ? "Sending..." : "Send Request"}
      </button>

      {response && (
        <div className="mt-8 space-y-6">
          <div className="flex gap-4">
            <div className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700">
              <span className="text-xs text-slate-500 font-bold uppercase mr-2">Status:</span>
              <span className={`font-bold ${response.status >= 200 && response.status < 300 ? 'text-green-400' : 'text-orange-400'}`}>
                {response.status}
              </span>
            </div>
            <div className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700">
              <span className="text-xs text-slate-500 font-bold uppercase mr-2">Time:</span>
              <span className="font-bold text-slate-200">{response.time}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-xs text-slate-500 font-bold uppercase mb-2">Response Body</label>
              <pre className="bg-slate-950 p-4 rounded-lg border border-slate-700 overflow-auto max-h-96 text-xs text-green-400 font-mono">
                {response.body}
              </pre>
            </div>
            <div>
              <label className="block text-xs text-slate-500 font-bold uppercase mb-2">Response Headers</label>
              <pre className="bg-slate-950 p-4 rounded-lg border border-slate-700 overflow-auto max-h-96 text-xs text-slate-400 font-mono">
                {response.headers}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
