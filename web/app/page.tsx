"use client";

import { useState, useRef, useEffect, FormEvent, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../lib/supabase/client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: string[];
  isStreaming: boolean;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUserEmail(user?.email ?? null);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || isLoading) return;

    setInput("");
    setIsLoading(true);

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: question,
      citations: [],
      isStreaming: false,
    };
    const assistantId = `a-${Date.now()}`;
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      if (res.status === 401 || res.status === 403) {
        router.push("/login");
        return;
      }
      if (!res.ok || !res.body) throw new Error("API error");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "text") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + data.content }
                    : m
                )
              );
            } else if (data.type === "citation") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, citations: data.sources } : m
                )
              );
            } else if (data.type === "done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, isStreaming: false } : m
                )
              );
            } else if (data.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: `エラー: ${data.message}`,
                        isStreaming: false,
                      }
                    : m
                )
              );
            }
          } catch {
            // JSON parse error: skip malformed event
          }
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: "エラーが発生しました。", isStreaming: false }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  }

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">社内文書 RAG チャット</h1>
        <div className="header-user">
          {userEmail && <span className="user-email">{userEmail}</span>}
          <button onClick={handleLogout} className="logout-button">
            ログアウト
          </button>
        </div>
      </header>

      <main className="main">
        {messages.length === 0 && (
          <p className="placeholder">
            質問を入力してください（例：有給休暇はいつから使えますか?）
          </p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`bubble ${msg.role}`}>
            <div className="role">{msg.role === "user" ? "あなた" : "AI"}</div>
            <div className="content">
              {msg.content}
              {msg.isStreaming && <span className="cursor">▍</span>}
            </div>
            {msg.citations.length > 0 && (
              <div className="citation">出典: {msg.citations.join(", ")}</div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </main>

      <form onSubmit={handleSubmit} className="form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="質問を入力… (Shift+Enter で改行、Enter で送信)"
          disabled={isLoading}
          rows={2}
          className="input"
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="button"
        >
          {isLoading ? "回答中…" : "送信"}
        </button>
      </form>
    </div>
  );
}
