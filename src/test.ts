import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
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

const MATCH_THRESHOLD = 0.45;
const MATCH_COUNT = 5;
const MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 5000;

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

interface TestResult {
  num: number;
  question: string;
  answer: string;
  citations: string[];
  elapsed: number;
  error?: string;
}

function loadQuestions(csvPath: string): Array<{ num: number; question: string }> {
  const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  // 1行目はヘッダーのためスキップ
  return lines.slice(1).map((line) => {
    // 列0: 番号, 列1: 質問 （質問列にカンマは含まれない前提でシンプルに分割）
    const firstComma = line.indexOf(",");
    const secondComma = line.indexOf(",", firstComma + 1);
    const num = parseInt(line.slice(0, firstComma), 10);
    const question = line.slice(firstComma + 1, secondComma);
    return { num, question };
  });
}

async function runQuestion(question: string): Promise<{ answer: string; citations: string[] }> {
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
  if (error) throw new Error(`検索エラー: ${error.message}`);
  const docs: Document[] = data ?? [];

  if (docs.length === 0) {
    return {
      answer: "提供された文書には、該当する情報の記載が見つかりませんでした。",
      citations: [],
    };
  }

  // 3. コンテキスト・出典構築
  const context = docs
    .map((doc, i) => {
      const page = doc.page_number != null ? ` (ページ ${doc.page_number})` : "";
      return `【参考文書 ${i + 1}】${doc.source_file}${page}\n${doc.content}`;
    })
    .join("\n\n");

  const seen = new Set<string>();
  const citations = docs
    .map((doc) => {
      const page = doc.page_number != null ? ` p.${doc.page_number}` : "";
      return `${doc.source_file}${page}`;
    })
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)));

  // 4. Claude でストリーミング回答生成（バッファに蓄積）
  const userMessage = `以下の参考文書を参照して、質問に回答してください。\n\n${context}\n\n質問: ${question}`;

  let answer = "";
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      answer += event.delta.text;
    }
  }

  return { answer, citations };
}

async function main() {
  const csvPath = path.join(__dirname, "../data/case3-test-questions.csv");
  const questions = loadQuestions(csvPath);
  const total = questions.length;

  console.log(`=== RAG 自動テスト (${total}問) ===`);
  console.log("（各問の実行中は進捗のみ表示。結果は全問終了後に一覧表示します）\n");

  const results: TestResult[] = [];

  for (const { num, question } of questions) {
    process.stdout.write(`[${num}/${total}] ${question} ... `);
    const start = Date.now();
    try {
      const { answer, citations } = await runQuestion(question);
      const elapsed = Date.now() - start;
      results.push({ num, question, answer, citations, elapsed });
      console.log(`${elapsed}ms`);
    } catch (err) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ num, question, answer: "", citations: [], elapsed, error: msg });
      console.log(`ERROR (${elapsed}ms)`);
    }
  }

  // ─── 結果一覧 ──────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("【テスト結果】");
  console.log("═".repeat(70));

  for (const r of results) {
    console.log(`\n▼ Q${r.num}: ${r.question}`);
    if (r.error) {
      console.log(`  [ERROR] ${r.error}`);
    } else {
      console.log(`  回答: ${r.answer}`);
      if (r.citations.length > 0) {
        console.log(`  出典: ${r.citations.join(", ")}`);
      } else {
        console.log(`  出典: なし`);
      }
    }
    const withinLimit = r.elapsed <= TIMEOUT_MS;
    console.log(`  応答時間: ${r.elapsed}ms  ${withinLimit ? "✓" : "✗ 5秒超過"}`);
    console.log("─".repeat(70));
  }

  // ─── サマリー ───────────────────────────────────────────────
  const avgMs = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length);
  const overLimit = results.filter((r) => r.elapsed > TIMEOUT_MS);
  const errors = results.filter((r) => r.error);

  console.log("\n【サマリー】");
  console.log(`  総問数      : ${total}問`);
  console.log(`  平均応答時間: ${avgMs}ms`);
  console.log(
    `  5秒以内     : ${
      overLimit.length === 0
        ? "✓ 全問クリア"
        : `✗ ${overLimit.length}問超過 (Q${overLimit.map((r) => r.num).join(", Q")})`
    }`
  );
  if (errors.length > 0) {
    console.log(`  エラー      : ${errors.length}問 (Q${errors.map((r) => r.num).join(", Q")})`);
  }
}

main().catch((err) => {
  console.error("テスト実行エラー:", err);
  process.exit(1);
});
