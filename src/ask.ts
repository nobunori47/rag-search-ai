import * as dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const QUERY = process.argv[2] ?? "有給休暇はいつから使えますか?";
const MATCH_THRESHOLD = 0.5;
const MATCH_COUNT = 5;
const MODEL = "claude-sonnet-4-6";

interface Document {
  content: string;
  source_file: string;
  page_number: number | null;
  similarity: number;
}

async function fetchRelevantDocs(query: string): Promise<Document[]> {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
  });

  if (error) throw new Error(`検索エラー: ${error.message}`);
  return (data ?? []) as Document[];
}

async function generateAnswer(query: string, docs: Document[]): Promise<void> {
  const context = docs
    .map((doc, i) => {
      const page =
        doc.page_number != null ? ` (ページ ${doc.page_number})` : "";
      return `【参考文書 ${i + 1}】${doc.source_file}${page}\n${doc.content}`;
    })
    .join("\n\n");

  const sourceFiles = [...new Set(docs.map((doc) => doc.source_file))];

  const systemPrompt = `あなたは会社の規則や方針についての質問に回答するアシスタントです。
以下のルールを厳守してください。

- 回答は、提供された参考文書に明示的に記載されている情報のみを使用すること
- 文書に記載のない情報については、推測・補足・提案・一般論を一切含めず、「提供された文書には、該当する情報の記載が見つかりませんでした」とだけ回答すること
- 「〜と思われます」「〜が考えられます」「〜にご確認ください」などの推測や誘導を含む表現は使用しないこと
- 回答本文のみを出力し、出典は記載しないこと`;

  const userMessage = `以下の参考文書を参照して、質問に回答してください。

${context}

質問: ${query}`;

  process.stdout.write("回答:\n");

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      process.stdout.write(event.delta.text);
    }
  }
  process.stdout.write(`\n出典: ${sourceFiles.join(", ")}\n`);
}

async function main(): Promise<void> {
  console.log(`質問: ${QUERY}\n`);

  console.log("関連文書を検索中...");
  const docs = await fetchRelevantDocs(QUERY);

  if (docs.length === 0) {
    console.log("関連文書が見つかりませんでした。回答を生成できません。");
    return;
  }

  console.log(`${docs.length}件の関連文書を取得しました\n`);
  docs.forEach((doc, i) => {
    const page =
      doc.page_number != null ? ` (ページ ${doc.page_number})` : "";
    console.log(
      `  ${i + 1}. ${doc.source_file}${page} (類似度: ${doc.similarity.toFixed(4)})`
    );
  });
  console.log();

  await generateAnswer(QUERY, docs);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
