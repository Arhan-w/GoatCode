"""Deterministic OpenAI-compatible mock for README demo captures.

Streams a scripted two-step agent turn so every capture run produces the
same story: assistant says it will look, calls read(t.txt), then streams
the answer word-by-word.

  python docs/mock_server.py --port 31999
"""
from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 31999

ANSWER = (
    "`t.txt` contains **hello from the goat pen** — 1 line, no surprises. "
    "I can rename it, expand it, or delete it, your call."
)


def sse(chunk: dict) -> bytes:
    return f"data: {json.dumps(chunk)}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/v1/models":
            body = json.dumps({"object": "list", "data": [{"id": "demo", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0)) or 0))
        messages = body.get("messages", [])
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        tools = body.get("tools") or []

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        try:
            if tools and not has_tool_result:
                for word in "Let me take a look at that file.".split(" "):
                    self.wfile.write(sse({"choices": [{"delta": {"content": word + " "}}]}))
                    self.wfile.flush()
                    time.sleep(0.05)
                self.wfile.write(sse({"choices": [{"delta": {
                    "tool_calls": [{"index": 0, "id": "call_r1", "type": "function",
                                    "function": {"name": "read", "arguments": ""}}]}}]}))
                for piece in [json.dumps({"path": "t.txt"})]:
                    self.wfile.write(sse({"choices": [{"delta": {
                        "tool_calls": [{"index": 0, "function": {"arguments": piece}}]}}]}))
                    time.sleep(0.25)
                self.wfile.write(sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}))
            else:
                for word in ANSWER.split(" "):
                    self.wfile.write(sse({"choices": [{"delta": {"content": word + " "}}]}))
                    self.wfile.flush()
                    time.sleep(0.10)
                self.wfile.write(sse({"choices": [{"delta": {}, "finish_reason": "stop"}],
                                      "usage": {"prompt_tokens": 512, "completion_tokens": 42}}))
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    print(f"mock openai on http://127.0.0.1:{PORT}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
