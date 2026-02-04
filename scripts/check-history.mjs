import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:19001");
let reqId = 0;

function send(method, params) {
  const id = "req-" + (++reqId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (msg.ok) resolve(msg.payload);
        else reject(new Error(msg.error?.message || "error"));
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

ws.on("open", async () => {
  try {
    // 发送 connect
    await send("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "test", version: "1.0.0", mode: "webchat", platform: "darwin" },
      auth: { token: "aada" }
    });
    
    // 获取历史消息
    const result = await send("chat.history", {
      sessionKey: "agent:main:main",
      limit: 10
    });
    
    console.log("=== 最近10条消息 ===\n");
    if (result.messages) {
      result.messages.forEach((m, i) => {
        const contentStr = typeof m.content === "string" 
          ? m.content.slice(0, 100) 
          : JSON.stringify(m.content).slice(0, 200);
        console.log(`[${i}] role="${m.role}"`);
        console.log(`    content: ${contentStr}`);
        console.log();
      });
    } else {
      console.log("没有消息");
    }
    ws.close();
  } catch (e) {
    console.error("Error:", e.message);
    ws.close();
  }
});

ws.on("error", (e) => console.error("WebSocket error:", e.message));
