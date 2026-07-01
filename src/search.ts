import * as dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const QUERY = process.argv[2] ?? "有給休暇はいつから使えますか?";
const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 5;

async function search(query: string): Promise<void> {
  console.log(`質問: ${query}\n`);

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

  if (error) {
    console.error("検索エラー:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log("関連文書が見つかりませんでした");
    return;
  }

  console.log(`${data.length}件の関連文書が見つかりました:\n`);
  data.forEach(
    (
      doc: {
        content: string;
        source_file: string;
        page_number: number | null;
        similarity: number;
      },
      i: number
    ) => {
      console.log(`--- ${i + 1}件目 ---`);
      console.log(`ファイル    : ${doc.source_file}`);
      console.log(`ページ番号  : ${doc.page_number ?? "なし"}`);
      console.log(`類似度      : ${doc.similarity.toFixed(4)}`);
      console.log(`内容        : ${doc.content}`);
      console.log();
    }
  );
}

search(QUERY).catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
