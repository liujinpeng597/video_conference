#!/usr/bin/env python3
"""极简告警接收端: 收到 Alertmanager 的 webhook 就把告警整条打印出来。

用途是把"告警闭环"在本机跑通 (Alertmanager -> 这里), 不依赖任何云上的通知渠道。
看它收到了什么:  docker compose logs -f alert-sink
只依赖 Python 标准库, 不需要装包。
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # Alertmanager 的 webhook 是 POST
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            alerts = json.loads(raw).get("alerts", [])
            print(f"[alert-sink] 收到 {len(alerts)} 条告警", flush=True)
            for a in alerts:
                labels = a.get("labels", {})
                summary = a.get("annotations", {}).get("summary", "")
                print(
                    f"  - {a.get('status')} {labels.get('alertname')} "
                    f"sev={labels.get('severity')} inst={labels.get('instance')} "
                    f"| {summary}",
                    flush=True,
                )
        except Exception:  # 不是预期结构也照收, 原文打出来
            print(f"[alert-sink] 收到(非 JSON): {raw}", flush=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):  # 探活用
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"alert-sink up")

    def log_message(self, *args):  # 挡掉默认访问日志, 只留自己的打印
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"[alert-sink] 监听 :{port}", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
