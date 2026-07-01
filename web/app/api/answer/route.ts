import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { createClient as createAuthClient } from "../../../lib/supabase/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED_DOMAIN =
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? "@techbridge.co.jp";
const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 5;
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `あなたは会社の規則や方針についての質問に回答するアシスタントです。
以下のルールを厳守してください。

- 回答は、提供された参考文書に明示的に記載されている情報のみを使用すること
- 文書に記載のない情報については、推測・補足・提案・一般論を一切含めず、「提供された文書には、該当する情報の記載が見つかりませんでした」とだけ回答すること
- 「〜と思われます」「〜が考えられます」「〜にご確認ください」などの推測や誘導を含む表現は使用しないこと
- 回答本文のみを出力し、出典は記載しないこと`;

interface Document {
  content: string;
  source_file: string;
  page_number: number | null;
  similarity: number;
}

function send(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  data: object
) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

export async function POST(req: NextRequest) {
  // 認証チェック
  const authClient = await createAuthClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }
  if (!user.email?.endsWith(ALLOWED_DOMAIN)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
    });
  }

  const { question } = await req.json();
  if (!question?.trim()) {
    return new Response(JSON.stringify({ error: "質問が空です" }), {
      status: 400,
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. クエリをベクトル化
        const embRes = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: question,
        });
        const queryEmbedding = embRes.data[0].embedding;

        // 2. ベクトル検索
        const { data, error } = await supabase.rpc("match_documents", {
          query_embedding: queryEmbedding,
          match_threshold: MATCH_THRESHOLD,
          match_count: MATCH_COUNT,
        });

        if (error) throw new Error(error.message);
        const docs: Document[] = data ?? [];

        if (docs.length === 0) {
          send(controller, encoder, {
            type: "text",
            content: "提供された文書には、該当する情報の記載が見つかりませんでした。",
          });
          send(controller, encoder, { type: "citation", sources: [] });
          send(controller, encoder, { type: "done" });
          controller.close();
          return;
        }

        // 3. コンテキスト構築
        const context = docs
          .map((doc, i) => {
            const page =
              doc.page_number != null ? ` (ページ ${doc.page_number})` : "";
            return `【参考文書 ${i + 1}】${doc.source_file}${page}\n${doc.content}`;
          })
          .join("\n\n");

        const userMessage = `以下の参考文書を参照して、質問に回答してください。\n\n${context}\n\n質問: ${question}`;

        // 4. 出典リスト構築
        const seen = new Set<string>();
        const citations = docs
          .map((doc) => {
            const page =
              doc.page_number != null ? ` p.${doc.page_number}` : "";
            return `${doc.source_file}${page}`;
          })
          .filter((c) => (seen.has(c) ? false : (seen.add(c), true)));

        // 5. Claude でストリーミング回答生成
        const claudeStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        });

        for await (const event of claudeStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send(controller, encoder, {
              type: "text",
              content: event.delta.text,
            });
          }
        }

        send(controller, encoder, { type: "citation", sources: citations });
        send(controller, encoder, { type: "done" });
        controller.close();
      } catch (err) {
        send(controller, encoder, {
          type: "error",
          message: err instanceof Error ? err.message : "不明なエラー",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
