"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export default function Home() {
  const [targetUrl, setTargetUrl] = useState("https://jsonplaceholder.typicode.com/posts/1");
  const [method, setMethod] = useState("GET");
  const [requestBody, setRequestBody] = useState(JSON.stringify({
    title: 'foo',
    body: 'bar',
    userId: 1,
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
        time: `${elapsed}ms`,
        body: responseText,
        headers: JSON.stringify(headersObj, null, 2)
      });
      toast.success(`Request finished with status ${res.status}`);
    } catch (err: any) {
      setResponse({
        status: 'Error',
        body: err.message,
        headers: '-'
      });
      toast.error("Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto py-10 px-4 max-w-6xl">
      <Toaster position="top-right" />
      <div className="flex flex-col gap-8">
        <div className="space-y-2 text-center sm:text-left">
          <h1 className="text-4xl font-extrabold tracking-tight">Edge Proxy</h1>
          <p className="text-muted-foreground">High-performance request relay powered by Vercel Edge.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <Card className="lg:col-span-5 h-fit">
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>Set up your target request.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="url">Target URL</Label>
                <Input
                  id="url"
                  placeholder="https://api.example.com"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Method</Label>
                <Select value={method} onValueChange={(val) => setMethod(val ?? "GET")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select Method" />
                  </SelectTrigger>
                  <SelectContent>
                    {methods.map(m => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Header Key</Label>
                  <Input placeholder="x-api-key" value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Header Value</Label>
                  <Input placeholder="value" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
                </div>
              </div>

              {!['GET', 'HEAD', 'OPTIONS'].includes(method) && (
                <div className="space-y-2">
                  <Label htmlFor="body">Body (JSON)</Label>
                  <Textarea
                    id="body"
                    className="font-mono text-xs h-32"
                    value={requestBody}
                    onChange={(e) => setRequestBody(e.target.value)}
                  />
                </div>
              )}
            </CardContent>
            <CardFooter>
              <Button
                className="w-full font-bold"
                onClick={sendRequest}
                disabled={loading}
              >
                {loading ? "Sending..." : "Send Request"}
              </Button>
            </CardFooter>
          </Card>

          <Card className="lg:col-span-7 flex flex-col min-h-125">
            <CardHeader className="pb-3 border-b">
              <div className="flex items-center justify-between">
                <CardTitle>Response</CardTitle>
                {response && (
                  <div className="flex gap-2">
                    <Badge variant={response.status >= 200 && response.status < 300 ? "default" : "destructive"}>
                      Status: {response.status}
                    </Badge>
                    <Badge variant="outline">{response.time}</Badge>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col pt-6">
              {!response && !loading && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground opacity-50 space-y-2">
                  <p>No response data.</p>
                </div>
              )}

              {loading && (
                <div className="flex-1 flex items-center justify-center">
                  <div className="animate-pulse space-y-2">
                    <div className="h-4 w-48 bg-muted rounded"></div>
                    <div className="h-4 w-32 bg-muted rounded"></div>
                  </div>
                </div>
              )}

              {response && (
                <Tabs defaultValue="body" className="flex-1 flex flex-col">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="body">Body</TabsTrigger>
                    <TabsTrigger value="headers">Headers</TabsTrigger>
                  </TabsList>
                  <TabsContent value="body" className="flex-1 mt-4">
                    <pre className="p-4 rounded-lg bg-zinc-950 text-emerald-400 font-mono text-[10px] sm:text-xs overflow-auto max-h-112.5 border shadow-inner">
                      {response.body}
                    </pre>
                  </TabsContent>
                  <TabsContent value="headers" className="flex-1 mt-4">
                    <pre className="p-4 rounded-lg bg-muted font-mono text-[10px] sm:text-xs overflow-auto max-h-112.5">
                      {response.headers}
                    </pre>
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
