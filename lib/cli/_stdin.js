/**
 * CLI stdin 유틸 — TTY 비감지 또는 --stdin 플래그 경로에서 전체 내용 읽기.
 *
 * 최대 1MB(1_048_576 바이트) 제한. 초과 시 에러를 throw한다.
 * UTF-8로 디코딩하며 선행/후행 공백은 trim하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

const MAX_BYTES = 1_048_576; /** 1MB */

/**
 * stdin에서 UTF-8 문자열 전체 읽기.
 *
 * @returns {Promise<string>} 읽은 내용 (trailing newline 포함)
 * @throws {Error} 입력이 비어 있거나 1MB 초과 시
 */
export async function readStdin() {
  const chunks = [];
  let   total  = 0;

  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new Error(
        `stdin input exceeds 1MB limit (${total} bytes received). Pipe smaller content or use a file.`
      );
    }
    chunks.push(buf);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    throw new Error("stdin is empty. Provide content via pipe or use positional argument.");
  }
  return text;
}
