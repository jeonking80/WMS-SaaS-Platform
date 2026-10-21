#!/usr/bin/env node
// 정지 훅: 마지막 답변이 영어 위주면 정지를 막고 한국어로 다시 쓰게 한다.
import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
// 한 번 막은 뒤 다시 정지할 때는 통과시켜 무한 반복을 막는다.
if (input.stop_hook_active) process.exit(0);

function lastAssistantText() {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (!input.transcript_path) return "";
  let lines;
  try {
    lines = readFileSync(input.transcript_path, "utf8").trim().split("\n");
  } catch {
    return "";
  }
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (entry.type === "user") {
      // 도구 결과가 아닌 실제 사용자 메시지에서 이번 턴이 시작된다.
      const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");
      if (!isToolResult) break;
      continue;
    }
    if (entry.type !== "assistant") continue;
    if (typeof content === "string") parts.unshift(content);
    else if (Array.isArray(content))
      for (const c of [...content].reverse()) if (c?.type === "text") parts.unshift(c.text);
  }
  return parts.join("\n");
}

const prose = lastAssistantText()
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/`[^`\n]*`/g, " ")
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/(?:[\w.-]*\/)+[\w.-]+/g, " ")
  .replace(/\b[\w-]+\.(?:tsx?|jsx?|mjs|json|md|css|html|sql|ya?ml)\b/g, " ");

const hangul = (prose.match(/[가-힣]/g) || []).length;
const latin = (prose.match(/[A-Za-z]/g) || []).length;
// 영어 문장: 영어 단어 4개 이상이 이어지고 마침표·물음표로 끝나는 구간
const englishSentences = (prose.match(/(?:\b[A-Za-z][A-Za-z']*\b[\s,]+){3,}[A-Za-z']+[.!?:]/g) || []).length;

const ratio = hangul / Math.max(1, hangul + latin);
if (latin >= 40 && (ratio < 0.5 || englishSentences >= 2)) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason:
        "직전 답변이 영어 위주입니다. 이 저장소 규칙(CLAUDE.md)에 따라 같은 내용을 한국어로 다시 작성하세요. 코드·명령어·파일 경로·고유명사만 원문으로 둡니다.",
    }),
  );
}
process.exit(0);
