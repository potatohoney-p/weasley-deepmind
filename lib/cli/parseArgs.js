/**
 * 외부 의존성 없는 CLI 인자 파서.
 *
 * 지원 형식:
 *   --flag              → { flag: true }
 *   --key value         → { key: "value" }
 *   --key=value         → { key: "value" }
 *   --no-flag           → { flag: false }
 *   --tag a --tag b     → { tag: ["a", "b"] }  (동일 키 반복 → 배열)
 *   positional          → { _: ["pos1", "pos2"] }
 *   -h                  → { h: true }
 *
 * 하위 호환:
 *   동일 키가 한 번만 등장하면 기존과 동일하게 string / boolean 반환.
 *   두 번 이상 등장할 때만 배열로 누적.
 */
export function parseArgs(args) {
  const result = { _: [] };

  /**
   * 키에 값을 설정한다.
   * 이미 동일 키가 존재하면 배열로 누적하고, 없으면 단일 값으로 저장한다.
   */
  function set(key, value) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const body = arg.slice(2);

      // --key=value 형태
      const eqIdx = body.indexOf('=');
      if (eqIdx !== -1) {
        const key   = body.slice(0, eqIdx);
        const value = body.slice(eqIdx + 1);
        set(key, value);
        continue;
      }

      // --no-flag 부정 플래그
      if (body.startsWith('no-')) {
        const key = body.slice(3);
        set(key, false);
        continue;
      }

      // --flag 또는 --key value
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        set(body, true);
      } else {
        set(body, next);
        i++;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // 단일 문자 플래그: -h, -v 등
      result[arg.slice(1)] = true;
    } else {
      result._.push(arg);
    }
  }

  return result;
}
